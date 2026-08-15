import type { FastifyBaseLogger, FastifyPluginAsync } from "fastify";
import {
  decodeSseEventId,
  resyncRequiredDataSchema,
  RESYNC_REQUIRED_EVENT_TYPE,
  STEP_03_TEST_SCOPE,
  type SseChannelScope,
  type SseCursorVector,
} from "@bunny-command-center/shared";
import type { AppConfig } from "../config.js";
import { SseHub, type SseConnectionHandle } from "./hub.js";
import { startHeartbeat } from "./heartbeat.js";
import { validateSourceRow } from "./validate.js";
import { listSourceAdapters } from "./registry.js";
import { sseMetrics } from "./metrics.js";
import type { SseCursorRepo } from "./cursorRepo.js";
import { SSE_HUB_CURSOR_KEY } from "./types.js";

/**
 * 26_REALTIME_SSE_AND_SYNC.md §Reconnection and resume: "`EventSource`'s
 * native auto-reconnect (with the server-set `retry:` hint ...)". No exact
 * millisecond value is fixed anywhere in DASHBOARD/ - this is this
 * implementation's own choice (noted in the Step-03 HANDOVER's deviations),
 * short enough that a brief drop recovers quickly but long enough not to
 * hammer the server during a real outage.
 */
const SSE_RETRY_MS = 3000;

/**
 * STEP 04/05 EXTENSION POINT (apps/api/src/sse/route.ts:44).
 * 03_realtime_infrastructure.md §SECURITY & RBAC: "The real per-channel
 * authorization ... is finished in Step 05/06 once RBAC exists - this step's
 * placeholder identity must be clearly marked as temporary and the real
 * subscription-authorization hook point must be an explicit, obvious
 * extension point (not something Step 05 has to reverse-engineer)."
 *
 * Every Step-03 connection is subscribed to exactly the synthetic test scope
 * - never a real `guild:`/`user:`/`admin:`/`platform` channel, since no
 * session/authorization exists yet to justify one. Step 04/05 replaces this
 * function's body with real session-derived scopes (own `userScope`,
 * favorited guilds -> `guildScope`, Guild Admin resolution -> `adminScope`,
 * Superadmin -> `platform`); the route handler's call site
 * (`buildSseRoutePlugin` below) does not need to change.
 */
function resolveSubscriptionScopes(): SseChannelScope[] {
  return [STEP_03_TEST_SCOPE];
}

export function buildSseRoutePlugin(params: {
  hub: SseHub;
  cursorRepo: SseCursorRepo;
  config: AppConfig;
}): FastifyPluginAsync {
  // eslint-disable-next-line @typescript-eslint/require-await -- FastifyPluginAsync's contract
  return async (fastify) => {
    fastify.get("/api/stream", (request, reply) => {
      const scopes = resolveSubscriptionScopes();

      // Native `EventSource` sends `Last-Event-ID` automatically ONLY when
      // the BROWSER's own internal reconnect re-uses the SAME EventSource
      // object - there is no web-platform API to set custom request headers
      // on `new EventSource(url)`, so a client-side reconnect that must
      // construct a genuinely NEW object (this layer's own fatal-state
      // recreation, ADR-005 §Risks) cannot carry the header forward. The
      // well-established workaround: the client remembers its own
      // last-received id and appends it as a `lastEventId` QUERY parameter
      // on the new connection URL; the server accepts either, preferring
      // the real header (only ever sent by a genuine native reconnect,
      // therefore more trustworthy) when both are present.
      const rawHeader = request.headers["last-event-id"];
      const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
      const queryValue = (request.query as Record<string, unknown> | undefined)?.["lastEventId"];
      const lastEventIdHeader = headerValue ?? (typeof queryValue === "string" ? queryValue : undefined);

      let vector: SseCursorVector = new Map();
      let malformedLastEventId = false;
      if (lastEventIdHeader !== undefined) {
        sseMetrics.reconnectWithLastEventId();
        const decoded = decodeSseEventId(lastEventIdHeader);
        if (decoded === null) {
          malformedLastEventId = true;
        } else {
          vector = decoded;
        }
      }

      // Full manual control over the response - this is real HTTP streaming
      // (mission §9: "Do not write one giant string after the response ends
      // and call it streaming"), not a buffered `reply.send()`.
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // ADR-005 risk mitigation: Cloudflare/reverse-proxy buffering breaks
        // a long-lived SSE connection without this.
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();

      const handle = params.hub.register({
        scopes,
        initialVector: vector,
        res,
        maxQueuedFrames: params.config.sse.maxQueuedFramesPerConnection,
        retryMs: SSE_RETRY_MS,
      });

      request.log.info(
        { connectionId: handle.connectionId, scopes, resumed: vector.size > 0 },
        "sse: connection opened",
      );

      void replayOrResync({
        handle,
        vector,
        malformedLastEventId,
        scopes,
        config: params.config,
        cursorRepo: params.cursorRepo,
        logger: request.log,
      });

      const stopHeartbeat = startHeartbeat(params.hub, handle, params.config.sse.heartbeatSeconds);

      let cleanedUp = false;
      const cleanup = (): void => {
        if (cleanedUp) {
          return;
        }
        cleanedUp = true;
        stopHeartbeat();
        handle.close("client_disconnected");
        request.log.info({ connectionId: handle.connectionId }, "sse: connection closed");
      };
      // Fastify request abort / raw socket close (mission §15) - both paths
      // are wired since either can fire depending on how the client drops.
      request.raw.on("close", cleanup);
      res.on("close", cleanup);
      res.on("error", cleanup);
    });
  };
}

async function replayOrResync(params: {
  handle: SseConnectionHandle;
  vector: SseCursorVector;
  malformedLastEventId: boolean;
  scopes: SseChannelScope[];
  config: AppConfig;
  cursorRepo: SseCursorRepo;
  logger: FastifyBaseLogger;
}): Promise<void> {
  if (params.malformedLastEventId) {
    // mission §12: "invalid Last-Event-ID -> documented safe behavior" - we
    // cannot know what this client has or hasn't seen, so the safe choice is
    // a full resync signal rather than guessing at a replay window.
    for (const scope of params.scopes) {
      sendResync(params.handle, scope, "INVALID_CURSOR");
    }
    return;
  }

  for (const adapter of listSourceAdapters()) {
    const knownOrdinal = params.vector.get(adapter.sourceIndex);
    if (knownOrdinal === undefined) {
      // Never seen this source on any prior connection for this client -
      // start live from here, no historical replay (matches ordinary SSE
      // semantics: initial state comes from a REST GET, not SSE replay).
      continue;
    }
    try {
      const [oldest, currentWatermark] = await Promise.all([
        adapter.oldestAvailableOrdinal(),
        params.cursorRepo.getLastSequence(adapter.sourceTable, SSE_HUB_CURSOR_KEY),
      ]);

      if (knownOrdinal >= currentWatermark) {
        // Cursor ahead of (or exactly caught up to) the source - documented
        // safe handling: nothing to replay, just resume live.
        continue;
      }
      if (oldest !== null && knownOrdinal < oldest - 1) {
        // Real, unrecoverable gap: rows between knownOrdinal+1 and oldest-1
        // no longer exist. Never silently treat this as "caught up".
        sseMetrics.replayGap();
        for (const scope of params.scopes) {
          sendResync(params.handle, scope, "REPLAY_GAP");
        }
        continue;
      }

      const rows = await adapter.fetchSince(knownOrdinal, params.config.sse.maxRowsPerSourcePerTick);
      let replayedCount = 0;
      for (const row of rows) {
        const validated = validateSourceRow(row, adapter.sourceTable, params.logger);
        if (validated && params.scopes.includes(validated.scope)) {
          params.handle.sendEvent(
            adapter.sourceIndex,
            validated.ordinal,
            validated.eventType,
            validated.data,
          );
          replayedCount += 1;
        }
      }
      if (replayedCount > 0) {
        sseMetrics.eventsReplayed(replayedCount);
      }
    } catch (err) {
      params.logger.error(
        { err, sourceTable: adapter.sourceTable },
        "sse: replay failed for one source adapter",
      );
    }
  }
}

function sendResync(
  handle: SseConnectionHandle,
  scope: SseChannelScope,
  reason: "REPLAY_GAP" | "INVALID_CURSOR",
): void {
  const data = resyncRequiredDataSchema.parse({ scope, reason });
  handle.sendControl(RESYNC_REQUIRED_EVENT_TYPE, data);
  sseMetrics.resyncSent();
}
