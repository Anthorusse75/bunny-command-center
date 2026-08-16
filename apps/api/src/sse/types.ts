import type { SseChannelScope } from "@bunny-command-center/shared";

/**
 * One durable row a source adapter has decided is SSE-worthy.
 *
 * `ordinal` MUST be the source table's own durable, strictly-increasing,
 * restart-safe key (an auto-increment PK, or an equivalent monotonic value) -
 * mission §11: "Do not use Date.now(), Math.random(), or process-local
 * increment-only IDs if that would make restart replay impossible."
 */
export interface SourceRow {
  ordinal: number;
  eventType: string;
  scope: SseChannelScope;
  data: unknown;
  occurredAt: Date;
}

/**
 * The registration boundary future steps use to plug a durable table into
 * the SSE fan-out (03_realtime_infrastructure.md HANDOVER FORMAT: "document
 * the exact extension point future steps use to add a new channel/event type
 * (file:line)"). Register via `registerSourceAdapter` in
 * apps/api/src/sse/registry.ts.
 *
 * Never implemented against a shared table's write path - `fetchSince`/
 * `oldestAvailableOrdinal` are READ-ONLY queries (mission §13/§53: "The
 * browser must never query MySQL directly" or read shared tables via this
 * generic layer without a query in an adapter; this same rule protects
 * against ever writing).
 */
export interface SourceAdapter {
  /** Matches a `dashboard_sse_cursor.source_table` row. Must be unique and <= 64 chars. */
  readonly sourceTable: string;
  /**
   * Small integer, unique across all registered adapters, chosen by the
   * REGISTERING code as a fixed constant (never runtime-assigned) - this is
   * what makes the packed SSE id restart-safe: the same adapter always packs
   * to the same sourceIndex across process restarts, so a client's
   * Last-Event-ID vector stays meaningful after a server restart.
   * `0` is reserved for heartbeat frames (apps/api/src/sse/heartbeat.ts) -
   * no adapter may register it.
   */
  readonly sourceIndex: number;
  /** Rows with `ordinal > sinceOrdinal`, ascending, capped at `limit`. */
  fetchSince(sinceOrdinal: number, limit: number): Promise<SourceRow[]>;
  /**
   * The oldest ordinal this source can still produce evidence for (its
   * retention floor), or `null` if the source currently has no rows at all.
   * Used for gap detection: a client resuming from an ordinal older than
   * `oldestAvailableOrdinal() - 1` has a real, unrecoverable gap.
   */
  oldestAvailableOrdinal(): Promise<number | null>;
}

export const HEARTBEAT_SOURCE_INDEX = 0;

export const SSE_HUB_CURSOR_KEY = "sse_hub";

export interface SourcePollBatchSize {
  /** Max rows fetched from one adapter per poll tick - bounds a single tick's work under a burst (29_PERFORMANCE_AND_SCALABILITY.md's no-unbounded-query-per-event rule). */
  maxRowsPerTick: number;
}
