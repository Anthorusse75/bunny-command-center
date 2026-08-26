/**
 * `dashboard_guild_lifecycle_events` (migration 0014, Step 10 correction
 * round Gap 3) — Dashboard-owned, append-only guild lifecycle-transition
 * event log backing the `guild_lifecycle.state_changed` SSE source adapter
 * (`lifecycleSseAdapter.ts`). Mirrors `apps/api/src/notifications/repo.ts`'s
 * `fetchNotificationsSinceSseSeq`/`oldestNotificationSseSeq` pair exactly —
 * same `sse_seq`-ordinal query shape, same `> sinceOrdinal ORDER BY sse_seq
 * ASC LIMIT` pattern.
 */
import type { Kysely, Transaction } from "kysely";
import type { DB } from "../db/codegen-types.js";
import type { LifecycleState } from "./stateMachine.js";

export type Executor = Kysely<DB> | Transaction<DB>;

/**
 * The ONE write path — called by `lifecycleRepo.ts`'s `writeLifecycleTransition`
 * caller (`lifecycleService.ts`) in the SAME transaction as the `guilds`
 * UPDATE (this table is Dashboard-owned, so real cross-table atomicity is
 * achievable here, unlike the shared `guilds` table + `createNotification()`
 * case — `activationRequestsService.ts`'s own header comment has the full
 * rationale for why that OTHER case can't share a transaction).
 */
export async function insertLifecycleEvent(
  db: Executor,
  params: {
    readonly guildId: string;
    readonly previousState: LifecycleState;
    readonly nextState: LifecycleState;
  },
): Promise<void> {
  await db
    .insertInto("dashboard_guild_lifecycle_events")
    .values({
      guild_id: params.guildId,
      lifecycle_state: params.nextState,
      previous_state: params.previousState,
    })
    .execute();
}

export async function fetchLifecycleEventsSinceSseSeq(
  db: Kysely<DB>,
  sinceOrdinal: number,
  limit: number,
): Promise<
  Array<{
    sse_seq: number;
    guild_id: string;
    lifecycle_state: string;
    previous_state: string;
    occurred_at: Date;
  }>
> {
  const rows = await db
    .selectFrom("dashboard_guild_lifecycle_events")
    .select(["sse_seq", "guild_id", "lifecycle_state", "previous_state", "occurred_at"])
    .where("sse_seq", ">", sinceOrdinal)
    .orderBy("sse_seq", "asc")
    .limit(limit)
    .execute();
  return rows.map((row) => ({
    sse_seq: Number(row.sse_seq),
    guild_id: row.guild_id,
    lifecycle_state: row.lifecycle_state,
    previous_state: row.previous_state,
    occurred_at: row.occurred_at,
  }));
}

export async function oldestLifecycleEventSseSeq(db: Kysely<DB>): Promise<number | null> {
  const row = await db
    .selectFrom("dashboard_guild_lifecycle_events")
    .select((eb) => eb.fn.min("sse_seq").as("min_seq"))
    .executeTakeFirst();
  return row?.min_seq === null || row?.min_seq === undefined ? null : Number(row.min_seq);
}
