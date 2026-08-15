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
 * growth ... bounded queues; dropped/coalesced invalidations"; mission §15:
 * "Where Node stream backpressure applies, respect it"). Respects
 * `res.write()`'s own boolean return value and the `drain` event rather than
 * reimplementing flow control - when the queue bound is exceeded, the OLDEST
 * queued frame is dropped (the client will still catch up to "current" on
 * its next reconnect via Last-Event-ID/resync, so losing an old queued frame
 * is safe - SSE events are invalidation hints, never mutations, mission §27).
 */
class BackpressureWriter {
  private queue: string[] = [];
  private backpressured = false;
  private closed = false;

  constructor(
    private readonly res: ServerResponse,
    private readonly maxQueued: number,
    private readonly onDrop: () => void,
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
    this.queue.push(chunk);
    while (this.queue.length > this.maxQueued) {
      this.queue.shift();
      this.onDrop();
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
  /** A durable, replayable business/heartbeat event - advances this connection's own id vector for `sourceIndex`. */
  sendEvent(sourceIndex: number, ordinal: number, eventType: string, data: unknown): void;
  /** A control frame (`resync_required`) - carries no `id:`, never advances the vector (mission: control signals are not durable positions). */
  sendControl(eventType: string, data: unknown): void;
  close(reason: string): void;
  readonly queuedFrameCount: number;
}

interface InternalConnection {
  readonly id: string;
  readonly scopes: ReadonlySet<SseChannelScope>;
  vector: SseCursorVector;
  writer: BackpressureWriter;
  heartbeatLocalCounter: number;
  res: ServerResponse;
}

/**
 * Central connection registry + fan-out point
 * (03_realtime_infrastructure.md §Create: "apps/api/src/sse/*"). Owns no
 * business knowledge of any specific event type - it only knows how to route
 * an already-validated `(scope, sourceIndex, ordinal, eventType, data)` tuple
 * to every connection subscribed to that scope, and how to keep each
 * connection's per-connection Last-Event-ID vector correct
 * (packages/shared/src/realtime/envelope.ts's `SseCursorVector`).
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
      sseMetrics.frameDroppedForBackpressure();
    });
    const internal: InternalConnection = {
      id,
      scopes: new Set(params.scopes),
      vector: params.initialVector,
      writer,
      heartbeatLocalCounter: 0,
      res: params.res,
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
      if (internal.scopes.has(scope)) {
        internal.vector = advanceVector(internal.vector, sourceIndex, ordinal);
        internal.writer.write(
          formatSseFrame({ event: eventType, id: encodeSseEventId(internal.vector), data }),
        );
      }
    }
  }

  broadcastControl(scope: SseChannelScope, eventType: string, data: unknown): void {
    for (const internal of this.connections.values()) {
      if (internal.scopes.has(scope)) {
        internal.writer.write(formatSseFrame({ event: eventType, data }));
      }
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
}

export { formatSseFrame };
