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

      // ==================================================================
      // Last-Event-ID resolution — TWO DISTINCT RECONNECT CASES, one
      // resolution rule. Documented explicitly here because the two cases
      // are easy to conflate and have different trust characteristics.
      //
      // CASE A — NATIVE EVENTSOURCE RECONNECT (the standard SSE mechanism):
      //   the SAME `EventSource` object the browser created initially loses
      //   its connection and the BROWSER ITSELF (not any code in this
      //   repo) automatically reconnects, sending the real, standard
      //   `Last-Event-ID` HEADER with the value of the last `id:` field it
      //   received. This is the spec-defined, browser-native path this
      //   server does nothing special to enable - it only needs to read
      //   `request.headers['last-event-id']` like any ordinary header.
      //   Proven end-to-end with a REAL browser + REAL native reconnect
      //   (not a mocked EventSource, not a manually-constructed header) in
      //   apps/web/e2e/realtime.spec.ts's "native EventSource reconnect"
      //   test.
      //
      // CASE B — APPLICATION-LEVEL BOOTSTRAP OF A BRAND-NEW EVENTSOURCE:
      //   e.g. after the polling-fallback path (mission's own drop/grace/
      //   polling/recovery flow) or this layer's own fatal-retry recreation
      //   (apps/web/src/realtime/sseConnectionManager.ts), the CLIENT
      //   application code constructs a genuinely NEW `EventSource` object.
      //   The native `EventSource` constructor has NO parameter and no
      //   subsequent API to set a custom `Last-Event-ID` (or any) request
      //   header, so this path cannot use the standard header at all. The
      //   client-side workaround (this repo's own application-level
      //   extension, not part of the SSE spec) is to remember its own last-
      //   received id and pass it as a `?lastEventId=` QUERY parameter on
      //   the new connection's URL - accepted here ONLY as a fallback, and
      //   ONLY consulted when case A's header is entirely absent.
      //
      // PRECEDENCE (deterministic, tested explicitly - see
      // apps/api/test/sse-stream.test.ts's "Last-Event-ID precedence"
      // suite for all 7 combinations):
      //   1. A syntactically valid standard `Last-Event-ID` header, if present, ALWAYS wins -
      //      never overridden by a query parameter, even a different one.
      //   2. Otherwise, a syntactically valid `?lastEventId=` query parameter is used.
      //   3. Otherwise (neither present), this is a fresh connection - no
      //      cursor, no replay, live-only.
      //   A header that IS present but fails to decode is never silently
      //   replaced by a possibly-attacker-controlled query value instead -
      //   it goes straight to the safe INVALID_CURSOR resync path (see
      //   replayOrResync below). The two inputs are never merged/reconciled
      //   field-by-field; exactly one of them is chosen as a whole.
      // ==================================================================
      const rawHeader = request.headers["last-event-id"];
      const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
      const queryValue = (request.query as Record<string, unknown> | undefined)?.["lastEventId"];
      const queryBootstrapValue = typeof queryValue === "string" ? queryValue : undefined;
      const resolvedLastEventId = headerValue ?? queryBootstrapValue;

      let vector: SseCursorVector = new Map();
      let malformedLastEventId = false;
      if (resolvedLastEventId !== undefined) {
        sseMetrics.reconnectWithLastEventId();
        const decoded = decodeSseEventId(resolvedLastEventId);
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
