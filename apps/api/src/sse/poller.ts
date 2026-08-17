import type { FastifyBaseLogger } from "fastify";
import { listSourceAdapters, type RegisteredEventType } from "./registry.js";
import { validateSourceRow } from "./validate.js";
import type { SseCursorRepo } from "./cursorRepo.js";
import type { SseHub } from "./hub.js";
import { SSE_HUB_CURSOR_KEY } from "./types.js";

export interface SsePollerHandle {
  stop(): void;
  /** Test hook: run exactly one tick synchronously, awaiting completion (avoids `setInterval` timing races in integration tests). */
  runOnceForTests(): Promise<void>;
}

/**
 * "apps/api does not invent a second event bus - it derives SSE events from
 * the SAME durable data changes already being polled/observed today: a
 * lightweight internal poller (short interval, e.g. 2-5s) watches
 * [durable source tables] for rows newer than the last-seen watermark, and
 * fans them out to subscribed SSE connections."
 * (26_REALTIME_SSE_AND_SYNC.md §Server-side event sourcing)
 *
 * One bad/unregistered/malformed row from one adapter must never stop other
 * adapters' rows from being processed, and must never crash the poller loop
 * (mission §43 failure isolation) - each adapter's tick body is individually
 * try/caught.
 */
export function startSsePoller(params: {
  hub: SseHub;
  cursorRepo: SseCursorRepo;
  logger: FastifyBaseLogger;
  pollIntervalMs: number;
  maxRowsPerTick: number;
  onPollTick?: () => void;
  onPollError?: (sourceTable: string) => void;
}): SsePollerHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  async function tick(): Promise<void> {
    params.onPollTick?.();
    for (const adapter of listSourceAdapters()) {
      try {
        const since = await params.cursorRepo.getLastSequence(adapter.sourceTable, SSE_HUB_CURSOR_KEY);
        const rows = await adapter.fetchSince(since, params.maxRowsPerTick);
        if (rows.length === 0) {
          continue;
        }
        let maxOrdinal = since;
        for (const row of rows) {
          if (row.ordinal > maxOrdinal) {
            maxOrdinal = row.ordinal;
          }
        }
        // Durable watermark advances BEFORE any broadcast for this tick's
        // rows reaches subscribers (correctness fix, D.RESUME CI
        // investigation - see apps/api/test/sse-stream.test.ts's
        // "broadcast-before-durable-advance window" test, which reproduces
        // the bug deterministically against the OLD advance-after-broadcast
        // order). Previously, `broadcast()` fired first and `advance()`
        // (a real DB write) followed - a client reconnecting in that gap
        // registered too late to catch the live broadcast (hub.ts's
        // REPLAYING bridge buffer only captures broadcasts from the moment
        // of registration onward) AND read a stale watermark for its own
        // replay-target snapshot (`route.ts`'s `replayOrResync`, which reads
        // straight from this same durable cursor), missing the row via
        // BOTH paths - a genuine, permanent loss, not a duplicate. Ordering
        // the durable write first closes that gap: any connection
        // registering between the two steps now either (a) registered
        // before this line, so still catches the row live via the buffer,
        // or (b) reads a watermark that ALREADY covers this tick's rows and
        // gets them via replay instead - a possible duplicate delivery in
        // that second case, but that side of the boundary was already
        // proven safe by the existing "pre-snapshot replay/bridge
        // duplication window" test (`completeReplay`'s `internal.vector`
        // dedup in hub.ts).
        await params.cursorRepo.advance(adapter.sourceTable, SSE_HUB_CURSOR_KEY, maxOrdinal);
        for (const row of rows) {
          const validated = validateSourceRow(row, adapter.sourceTable, params.logger);
          if (validated) {
            params.hub.broadcast(
              validated.scope,
              adapter.sourceIndex,
              validated.ordinal,
              validated.eventType,
              validated.data,
            );
          }
        }
      } catch (err) {
        params.onPollError?.(adapter.sourceTable);
        params.logger.error(
          { err, sourceTable: adapter.sourceTable },
          "sse poller: tick failed for one source adapter - other adapters unaffected",
        );
      }
    }
  }

  /**
   * Correctness-review defect 6: production polling previously used
   * `setInterval(() => void tick(), interval)` with no in-flight guard - if
   * one tick's DB round-trips ever took longer than `pollIntervalMs`, a
   * second tick could start while the first was still reading the SAME
   * `dashboard_sse_cursor` watermark, and both would broadcast the same
   * rows (duplicate fan-out) before either had advanced the cursor. Fixed
   * by scheduling the NEXT tick's timer only once the CURRENT tick's
   * `await tick()` has fully settled (recursive `setTimeout`, not
   * `setInterval`) - this makes "at most one tick in flight at any moment"
   * true by construction, not by a separate guard flag that could itself
   * race. `runOnceForTests` calls `tick()` directly and is documented
   * (SsePollerHandle's own doc comment) as a test-only synchronous
   * alternative to the timer loop, so it is intentionally NOT routed
   * through this scheduler - a test calling it manages its own timing.
   */
  function scheduleNext(): void {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      if (stopped) {
        return;
      }
      void tick().finally(() => {
        scheduleNext();
      });
    }, params.pollIntervalMs);
    timer.unref?.();
  }
  scheduleNext();

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    async runOnceForTests() {
      await tick();
    },
  };
}

export type { RegisteredEventType };
