/**
 * Correction #2 (this step's task brief) — observation-only reconciliation:
 * polls `dashboard_notification_deliveries` for `DISCORD_DM` rows still
 * `PENDING`, reads the corresponding `operator_commands` row BY ITS OWN
 * PRIMARY KEY (`command_id`, stored on the delivery row's
 * `operator_command_id` at enqueue time), and maps its `state`/
 * `last_error_code` onto the delivery's `state` via
 * `deliveryStateMapping.ts`. Never watches `operator_command_events`
 * (an earlier ADR-013 draft's wording — the real merged Bunny OCR Step 08
 * consumer does not write rows there for `SEND_DM`).
 *
 * Structurally observation-only: this module contains no INSERT into
 * `operator_commands`, no UPDATE of any `operator_commands` column, and no
 * code path that creates a replacement `SEND_DM` — `updateDiscordDmDeliveryState`
 * (repo.ts) only ever writes `dashboard_notification_deliveries`. A
 * transient DB read error for one candidate leaves that row `PENDING` (it is
 * simply reconsidered on the next poll) and is logged, never thrown out of
 * the tick loop — one bad row must never stop the rest of the batch, same
 * failure-isolation discipline as `apps/api/src/sse/poller.ts`'s per-adapter
 * try/catch.
 *
 * Same recursive-`setTimeout` "at most one tick in flight" scheduling
 * pattern as the SSE poller (`sse/poller.ts`'s own doc comment explains why
 * `setInterval` without an in-flight guard is unsafe) — deliberately mirrored
 * here rather than reinvented, per this codebase's "reuse its conventions,
 * don't reinvent style" discipline.
 */
import type { Kysely } from "kysely";
import type { FastifyBaseLogger } from "fastify";
import type { DB } from "../db/codegen-types.js";
import { mapOperatorCommandStateToDeliveryState } from "./deliveryStateMapping.js";
import {
  findOperatorCommandStateById,
  findPendingDiscordDmDeliveries,
  updateDiscordDmDeliveryState,
} from "./repo.js";

export interface NotificationReconciliationWatcherHandle {
  /**
   * Stops scheduling future ticks AND waits for any tick CURRENTLY in
   * flight to fully settle before resolving — mirrors
   * `SsePollerHandle.stop`'s identical fix (external-review item 3's
   * `health.test.ts` investigation: an in-flight tick's `db` query against
   * an unreachable host could previously outlive `stop()` returning, and if
   * the caller then destroyed the underlying pool while that connection
   * attempt was still pending, its eventual timeout fired with no listener
   * left — an unhandled rejection that crashed the whole test process).
   */
  stop(): Promise<void>;
  /** Test hook: run exactly one tick synchronously (mirrors `SsePollerHandle.runOnceForTests`). */
  runOnceForTests(): Promise<void>;
}

export function startNotificationReconciliationWatcher(params: {
  db: Kysely<DB>;
  logger: FastifyBaseLogger;
  pollIntervalMs: number;
  maxRowsPerTick: number;
}): NotificationReconciliationWatcherHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  /** The currently-in-flight tick's promise, if any — `stop()` awaits this (see `NotificationReconciliationWatcherHandle.stop`'s doc comment). */
  let inFlightTick: Promise<void> | null = null;

  async function tick(): Promise<void> {
    let pending: Awaited<ReturnType<typeof findPendingDiscordDmDeliveries>>;
    try {
      pending = await findPendingDiscordDmDeliveries(params.db, params.maxRowsPerTick);
    } catch (err) {
      // Transient DB read error for the SCAN itself — every candidate stays
      // PENDING (nothing to update), logged, retried next poll.
      params.logger.error({ err }, "notifications: reconciliation watcher failed to scan pending deliveries");
      return;
    }

    for (const delivery of pending) {
      try {
        const command = await findOperatorCommandStateById(params.db, delivery.operator_command_id);
        if (!command) {
          // Not found yet is not an error in itself under normal operation
          // (insert-then-select already guarantees existence at enqueue
          // time — this would only happen if the row were somehow removed,
          // which nothing in this system's write paths ever does). Leave
          // PENDING and log for visibility rather than guessing.
          params.logger.warn(
            { notificationId: delivery.notification_id, commandId: delivery.operator_command_id },
            "notifications: reconciliation watcher found no operator_commands row for a pending delivery",
          );
          continue;
        }
        const mapped = mapOperatorCommandStateToDeliveryState({
          state: command.state,
          lastErrorCode: command.last_error_code,
        });
        if (mapped === "PENDING") {
          continue;
        }
        await updateDiscordDmDeliveryState(params.db, delivery.notification_id, mapped);
      } catch (err) {
        // One row's transient failure must never stop the rest of the batch.
        params.logger.error(
          { err, notificationId: delivery.notification_id },
          "notifications: reconciliation watcher failed to reconcile one delivery — left PENDING, retried next poll",
        );
      }
    }
  }

  function scheduleNext(): void {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      if (stopped) {
        return;
      }
      const running = tick();
      inFlightTick = running;
      void running.finally(() => {
        if (inFlightTick === running) {
          inFlightTick = null;
        }
        scheduleNext();
      });
    }, params.pollIntervalMs);
    timer.unref?.();
  }
  scheduleNext();

  return {
    async stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // Wait for a tick that had ALREADY started before `stop()` was called
      // to fully settle — `tick()` itself never throws (every DB call is
      // individually try/caught), so this can't hang or reject.
      await inFlightTick;
    },
    async runOnceForTests() {
      await tick();
    },
  };
}
