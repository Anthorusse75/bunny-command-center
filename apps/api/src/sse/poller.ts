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
          if (row.ordinal > maxOrdinal) {
            maxOrdinal = row.ordinal;
          }
        }
        await params.cursorRepo.advance(adapter.sourceTable, SSE_HUB_CURSOR_KEY, maxOrdinal);
      } catch (err) {
        params.onPollError?.(adapter.sourceTable);
        params.logger.error(
          { err, sourceTable: adapter.sourceTable },
          "sse poller: tick failed for one source adapter - other adapters unaffected",
        );
      }
    }
  }

  const timer = setInterval(() => {
    if (stopped) {
      return;
    }
    void tick();
  }, params.pollIntervalMs);
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    async runOnceForTests() {
      await tick();
    },
  };
}

export type { RegisteredEventType };
