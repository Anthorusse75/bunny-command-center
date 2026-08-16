import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import {
  advanceVector,
  encodeSseEventId,
  type SseChannelScope,
  type SseCursorVector,
} from "@bunny-command-center/shared";
import { sseMetrics } from "./metrics.js";

function formatSseFrame(params: { event: string; id?: string; data: unknown; retryMs?: number }): string {
  const lines: string[] = [];
  if (params.retryMs !== undefined) {
    lines.push(`retry: ${params.retryMs}`);
  }
  lines.push(`event: ${params.event}`);
  if (params.id !== undefined) {
    lines.push(`id: ${params.id}`);
  }
  // JSON.stringify never contains a raw newline for normal payloads, but
  // guard anyway - a `data:` line MUST NOT contain an unescaped newline per
  // the SSE spec (each additional line needs its own `data:` prefix).
  const json = JSON.stringify(params.data);
  for (const line of json.split("\n")) {
    lines.push(`data: ${line}`);
  }
  return lines.join("\n") + "\n\n";
}

/**
 * Bounded, backpressure-aware writer for one connection's underlying HTTP
 * response (mission §16: "A slow client must not cause unlimited memory
 * growth ... bounded queues"; mission §15: "Where Node stream backpressure
 * applies, respect it"). Respects `res.write()`'s own boolean return value
 * and the `drain` event rather than reimplementing flow control.
 *
 * CORRECTNESS-REVIEW DEFECT 1 FIX: once the queue bound is exceeded, the
 * connection is TERMINATED, never kept open with an individual frame
 * silently dropped. The earlier "drop the oldest queued frame and keep
 * advancing the stream" design was unsafe specifically because these frames
 * carry the connection's `id:` cursor: dropping frame N while still sending
 * frame N+1 (with a NEWER id) lets the client's Last-Event-ID silently skip
 * past the dropped event - on reconnect it asks for events AFTER the id it
 * actually has, so the dropped one can never be replayed (SSE events being
 * "invalidation hints, never mutations" does not help here - the id itself,
 * not just the payload, is the thing that must never lie about what was
 * delivered). Terminating instead means the client's own last ACTUALLY
 * received id is the only position it can ever claim on reconnect, and
 * ordinary Last-Event-ID replay (or `resync_required`, if retention already
 * lost the gap) fills in the rest - see `onOverflow` below and
 * `apps/api/test/sse-hub.test.ts`'s "backpressure overflow" tests.
 */
class BackpressureWriter {
  private queue: string[] = [];
  private backpressured = false;
  private closed = false;

  constructor(
    private readonly res: ServerResponse,
    private readonly maxQueued: number,
    private readonly onOverflow: () => void,
  ) {
    this.res.on("drain", () => this.flush());
  }

  write(chunk: string): void {
    if (this.closed) {
      return;
    }
    if (this.backpressured) {
      this.enqueue(chunk);
      return;
    }
    let ok: boolean;
    try {
      ok = this.res.write(chunk);
    } catch {
      // Socket already gone - the 'close' handler will run cleanup.
      return;
    }
    if (!ok) {
      this.backpressured = true;
    }
  }

  private enqueue(chunk: string): void {
    if (this.closed) {
      return;
    }
    this.queue.push(chunk);
    if (this.queue.length > this.maxQueued) {
      // Hard safety bound reached - terminate rather than drop-and-continue
      // (see class doc comment above). No later `write()` call can ever
      // reach the client after this point (the `closed` flag makes every
      // subsequent `write`/`enqueue` a silent no-op), so no cursor-bearing
      // frame beyond this point can ever be delivered out of order with
      // respect to the dropped one.
      this.closed = true;
      this.queue = [];
      this.onOverflow();
    }
  }

  private flush(): void {
    while (this.queue.length > 0) {
      const chunk = this.queue[0]!;
      let ok: boolean;
      try {
        ok = this.res.write(chunk);
      } catch {
        return;
      }
      if (!ok) {
        this.backpressured = true;
        return;
      }
      this.queue.shift();
    }
    this.backpressured = false;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  markClosed(): void {
    this.closed = true;
    this.queue = [];
  }
}

export interface SseConnectionHandle {
  readonly connectionId: string;
  readonly scopes: ReadonlySet<SseChannelScope>;
  /** A durable, replayable business/heartbeat event - advances this connection's own id vector for `sourceIndex`. Always written directly (never buffered by replay/live phase - see class doc comment): the caller is either the connection's OWN replay/heartbeat, never the poller's cross-connection fan-out. */
  sendEvent(sourceIndex: number, ordinal: number, eventType: string, data: unknown): void;
  /** A control frame (`resync_required`) - carries no `id:`, never advances the vector (mission: control signals are not durable positions). Always written directly, same reasoning as `sendEvent`. */
  sendControl(eventType: string, data: unknown): void;
  close(reason: string): void;
  readonly queuedFrameCount: number;
}

/** One item buffered on a still-REPLAYING connection's bridge buffer - see `SseHub`'s class doc comment. */
type BufferedBroadcast =
  | { readonly kind: "event"; sourceIndex: number; ordinal: number; eventType: string; data: unknown }
  | { readonly kind: "control"; eventType: string; data: unknown };

interface InternalConnection {
  readonly id: string;
  readonly scopes: ReadonlySet<SseChannelScope>;
  vector: SseCursorVector;
  writer: BackpressureWriter;
  heartbeatLocalCounter: number;
  res: ServerResponse;
  /**
   * REPLAYING until the connection's own catch-up (apps/api/src/sse/route.ts's
   * `replayOrResync`) explicitly calls `completeReplay` - see class doc
   * comment for why this exists (correctness-review defect 3).
   */
  phase: "REPLAYING" | "LIVE";
  bridgeBuffer: BufferedBroadcast[];
  readonly maxBridgeBufferFrames: number;
}

/**
 * Central connection registry + fan-out point
 * (03_realtime_infrastructure.md §Create: "apps/api/src/sse/*"). Owns no
 * business knowledge of any specific event type - it only knows how to route
 * an already-validated `(scope, sourceIndex, ordinal, eventType, data)` tuple
 * to every connection subscribed to that scope, and how to keep each
 * connection's per-connection Last-Event-ID vector correct
 * (packages/shared/src/realtime/envelope.ts's `SseCursorVector`).
 *
 * REPLAY <-> LIVE SERIALIZATION (correctness-review defect 3): a freshly
 * registered, resuming connection starts in the `REPLAYING` phase. While
 * REPLAYING, `broadcast`/`broadcastControl` (the poller's cross-connection
 * fan-out - never this connection's OWN replay/heartbeat calls, which use
 * `sendEvent`/`sendControl` directly and are unaffected) do not write to the
 * connection at all - they push onto a bounded per-connection bridge buffer
 * instead. This exists because `route.ts`'s `replayOrResync` snapshots each
 * source's target watermark and then asynchronously pages through history to
 * reach it; if the poller broadcast a genuinely newer row for that same
 * source WHILE that paging was still in flight, the connection would receive
 * frames out of the order its own id vector implies (e.g. an id jump ahead
 * via the live broadcast, immediately followed by an older replay frame that
 * can no longer advance the vector at all - `advanceVector` is monotonic by
 * design, so that older frame's `id:` would silently show the ALREADY-newer
 * position instead of its own, which is exactly the "payload ordering
 * inconsistent with the cursor position" defect). Once `replayOrResync`
 * finishes (successfully or via a per-source resync), it calls
 * `completeReplay`, which flips the connection to `LIVE` and flushes the
 * bridge buffer in the order items were buffered - by construction, every
 * buffered item's ordinal is guaranteed to be ABOVE whatever replay itself
 * delivered for that source (the poller only ever broadcasts after
 * advancing `dashboard_sse_cursor` past whatever `replayOrResync` already
 * snapshotted as its target), so flushing in arrival order can never
 * duplicate or invert a source's sequence. If the buffer itself would
 * overflow before replay finishes, the connection is terminated (the same
 * fail-safe `BackpressureWriter` uses for its own bound, and for the exact
 * same reason - never silently drop a cursor-bearing event and continue).
 */
export class SseHub {
  private readonly connections = new Map<string, InternalConnection>();

  register(params: {
    scopes: SseChannelScope[];
    initialVector: SseCursorVector;
    res: ServerResponse;
    maxQueuedFrames: number;
    retryMs: number;
  }): SseConnectionHandle {
    const id = randomUUID();
    const writer = new BackpressureWriter(params.res, params.maxQueuedFrames, () => {
      sseMetrics.connectionClosedForBackpressure();
      this.unregister(id, "backpressure_overflow");
    });
    const internal: InternalConnection = {
      id,
      scopes: new Set(params.scopes),
      vector: params.initialVector,
      writer,
      heartbeatLocalCounter: 0,
      res: params.res,
      phase: "REPLAYING",
      bridgeBuffer: [],
      maxBridgeBufferFrames: params.maxQueuedFrames,
    };
    this.connections.set(id, internal);
    sseMetrics.connectionOpened();

    const handle: SseConnectionHandle = {
      connectionId: id,
      scopes: internal.scopes,
      sendEvent: (sourceIndex, ordinal, eventType, data) => {
        internal.vector = advanceVector(internal.vector, sourceIndex, ordinal);
        writer.write(
          formatSseFrame({
            event: eventType,
            id: encodeSseEventId(internal.vector),
            data,
            retryMs: params.retryMs,
          }),
        );
      },
      sendControl: (eventType, data) => {
        writer.write(formatSseFrame({ event: eventType, data, retryMs: params.retryMs }));
      },
      close: (reason: string) => {
        this.unregister(id, reason);
      },
      get queuedFrameCount() {
        return writer.queuedCount;
      },
    };
    return handle;
  }

  /**
   * Ends the REPLAYING phase for one connection (called once by
   * `route.ts`'s `replayOrResync` after it has paged every replayable
   * source through to its snapshotted target, or determined there was
   * nothing to replay). Idempotent - a connection already LIVE, or one that
   * no longer exists (closed mid-replay), is a silent no-op. Flushes the
   * bridge buffer in arrival order before flipping the phase, so a caller
   * observing the connection's writer afterward sees every buffered event
   * already delivered.
   */
  completeReplay(connectionId: string): void {
    const internal = this.connections.get(connectionId);
    if (!internal || internal.phase === "LIVE") {
      return;
    }
    const buffered = internal.bridgeBuffer;
    internal.bridgeBuffer = [];
    internal.phase = "LIVE";
    for (const item of buffered) {
      if (item.kind === "event") {
        internal.vector = advanceVector(internal.vector, item.sourceIndex, item.ordinal);
        internal.writer.write(
          formatSseFrame({ event: item.eventType, id: encodeSseEventId(internal.vector), data: item.data }),
        );
      } else {
        internal.writer.write(formatSseFrame({ event: item.eventType, data: item.data }));
      }
    }
  }

  private bufferOrOverflow(internal: InternalConnection, item: BufferedBroadcast): void {
    internal.bridgeBuffer.push(item);
    if (internal.bridgeBuffer.length > internal.maxBridgeBufferFrames) {
      sseMetrics.connectionClosedForBridgeOverflow();
      this.unregister(internal.id, "replay_live_bridge_overflow");
    }
  }

  /** Called by the connection's own `sendEvent(HEARTBEAT_SOURCE_INDEX, ...)` caller (route.ts's heartbeat timer) - exposed as a helper so callers don't need to track the per-connection counter themselves. */
  nextHeartbeatOrdinal(connectionId: string): number {
    const internal = this.connections.get(connectionId);
    if (!internal) {
      return 0;
    }
    internal.heartbeatLocalCounter += 1;
    return internal.heartbeatLocalCounter;
  }

  broadcast(
    scope: SseChannelScope,
    sourceIndex: number,
    ordinal: number,
    eventType: string,
    data: unknown,
  ): void {
    for (const internal of this.connections.values()) {
      if (!internal.scopes.has(scope)) {
        continue;
      }
      if (internal.phase === "REPLAYING") {
        this.bufferOrOverflow(internal, { kind: "event", sourceIndex, ordinal, eventType, data });
        continue;
      }
      internal.vector = advanceVector(internal.vector, sourceIndex, ordinal);
      internal.writer.write(
        formatSseFrame({ event: eventType, id: encodeSseEventId(internal.vector), data }),
      );
    }
  }

  broadcastControl(scope: SseChannelScope, eventType: string, data: unknown): void {
    for (const internal of this.connections.values()) {
      if (!internal.scopes.has(scope)) {
        continue;
      }
      if (internal.phase === "REPLAYING") {
        this.bufferOrOverflow(internal, { kind: "control", eventType, data });
        continue;
      }
      internal.writer.write(formatSseFrame({ event: eventType, data }));
    }
  }

  unregister(connectionId: string, _reason: string): void {
    const internal = this.connections.get(connectionId);
    if (!internal) {
      return;
    }
    internal.writer.markClosed();
    this.connections.delete(connectionId);
    sseMetrics.connectionClosed();
    // Guaranteed socket teardown regardless of which side (client abort vs
    // server-driven close) triggered this - safe/idempotent on an
    // already-closed socket, and prevents a lingering keep-alive socket from
    // ever blocking a future `http.Server.close()` (mission §15).
    try {
      internal.res.destroy();
    } catch {
      /* already gone */
    }
  }

  get activeConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Server shutdown (mission §29/§15: graceful close, not a bare drop).
   * Writes a client-recognizable `server_shutdown` frame BEFORE closing
   * (32_DEPLOYMENT_AND_OPERATIONS.md §Graceful shutdown: "close SSE
   * connections with a client-recognized 'server restarting, reconnect
   * shortly' reason, not a bare drop that looks like an error"), then
   * explicitly destroys the underlying socket rather than relying on
   * `res.end()` alone - the response was served with `Connection:
   * keep-alive` (correct for a long-lived SSE stream), which means `end()`
   * alone only finishes the current response body and leaves the TCP socket
   * itself open for a hypothetical next keep-alive request; without an
   * explicit destroy, Node's `http.Server.close()` (which `fastify.close()`
   * calls internally) blocks indefinitely waiting for that socket to close
   * on its own.
   */
  closeAll(message: string): void {
    for (const id of [...this.connections.keys()]) {
      const internal = this.connections.get(id);
      if (internal) {
        try {
          internal.writer.write(formatSseFrame({ event: "server_shutdown", data: { message } }));
          internal.res.end();
        } catch {
          /* socket already gone */
        }
        internal.res.destroy();
      }
      this.unregister(id, "server_shutdown");
    }
  }

  /**
   * TEST-ONLY (mission §35/§37, apps/api/scripts/e2e-server.ts's own
   * sentinel-row watcher is the only real caller). Simulates a genuine
   * network-level failure of every currently-open connection in `scope` -
   * an ABRUPT `res.destroy()` with NO frame written first (deliberately
   * unlike `closeAll`, which writes a graceful `server_shutdown` frame
   * before closing: a real network drop gives the client no such warning).
   * This is what makes it possible to prove native `EventSource` reconnect
   * (Case A in apps/api/src/sse/route.ts's own doc comment) with a REAL
   * browser: the browser's own `onerror`/auto-reconnect logic only
   * activates on a genuine, unannounced connection failure, and there is no
   * way to produce that from Playwright's side alone against an
   * already-established long-lived HTTP/1.1 stream (verified empirically -
   * see apps/web/e2e/realtime.spec.ts's own top comment). Never reachable
   * from any HTTP route - this is a plain method call on the hub instance,
   * only ever invoked by test-only server-side code, never by anything a
   * client can trigger over the wire.
   */
  simulateNetworkDropForTests(scope: SseChannelScope): void {
    for (const id of [...this.connections.keys()]) {
      const internal = this.connections.get(id);
      if (internal && internal.scopes.has(scope)) {
        this.unregister(id, "simulated_network_drop");
      }
    }
  }

  /**
   * TEST-ONLY, same status and placement as `simulateNetworkDropForTests`
   * immediately above (never reachable from any HTTP route - a plain method
   * call on the hub instance). Produces the EXACT SAME observable
   * consequence a genuine backpressure-bound overflow produces (abrupt
   * termination, same metric, same `unregister` path) without depending on
   * real OS/Node socket buffer sizes actually filling - which real
   * integration testing found to be genuinely non-deterministic across
   * runs/environments (variable wall-clock time, sometimes 1s, sometimes
   * 18s+, depending on kernel socket buffer state), unlike the native-
   * reconnect case above where Playwright genuinely has no other way to
   * produce an unannounced failure at all. Here, a real overflow's
   * mechanism (`BackpressureWriter`'s bound) is already proven directly and
   * deterministically at the unit level (apps/api/test/sse-hub.test.ts's
   * "backpressure overflow terminates the connection" suite, against the
   * real `BackpressureWriter` class); this hook exists so an INTEGRATION
   * test can deterministically prove the RECOVERY half (real reconnect from
   * the last-actually-received id, real paginated replay) without also
   * fighting real-world buffer-size non-determinism to get there.
   */
  simulateBackpressureOverflowForTests(scope: SseChannelScope): void {
    for (const id of [...this.connections.keys()]) {
      const internal = this.connections.get(id);
      if (internal && internal.scopes.has(scope)) {
        sseMetrics.connectionClosedForBackpressure();
        this.unregister(id, "simulated_backpressure_overflow");
      }
    }
  }
}

export { formatSseFrame };
