/**
 * Step 10 external-review correction round, Section 9 — Dashboard-side
 * replica of `01_NEW_SELF_BOTS/src/database/repositories/season_plans.py`'s
 * `create_guild_season_plan` INSERT shape (that Python function cannot be
 * called from TypeScript — this module reproduces its exact SQL shape in
 * Kysely) and `seasons.py`'s `get_open_season` query (`SELECT ... FROM
 * submission_seasons WHERE open_for_delivery_marker = 1`).
 *
 * `guild_season_plans`/`guild_season_progress`/`submission_seasons` are
 * SHARED tables (migration `0003_seasons.up.sql`) — this module runs no DDL,
 * only reads/writes rows through the already-migrated schema.
 */
import type { Kysely, Transaction } from "kysely";
import type { DB } from "../db/codegen-types.js";
import { bindBigIntUnsigned } from "../db/bigIntParam.js";
import { generateNotificationId } from "../notifications/id.js";
import type { EffectiveQuotas } from "./seasonQuotas.js";

export type Executor = Kysely<DB> | Transaction<DB>;

/**
 * "Eligible current season" per `01_NEW_SELF_BOTS/src/database/repositories/seasons.py`'s
 * `get_open_season(pool)`: at most one row can ever have
 * `open_for_delivery_marker = 1` (the generated-column uniqueness
 * constraint, `submission_seasons`'s own `uq_submission_seasons_open_marker`).
 * Returns `null` if none is currently open/closing.
 */
export async function getOpenSeasonId(db: Executor): Promise<string | null> {
  const row = await db
    .selectFrom("submission_seasons")
    .select("season_id")
    .where("open_for_delivery_marker", "=", 1)
    .executeTakeFirst();
  return row?.season_id ?? null;
}

export interface SeasonPlanRow {
  readonly planId: string;
  readonly rowVersion: number;
}

export async function getSeasonPlanForGuildAndSeason(
  db: Executor,
  guildId: string,
  seasonId: string,
): Promise<SeasonPlanRow | null> {
  const row = await db
    .selectFrom("guild_season_plans")
    .select(["plan_id", "row_version"])
    .where("guild_id", "=", bindBigIntUnsigned(guildId))
    .where("season_id", "=", seasonId)
    .executeTakeFirst();
  if (!row) return null;
  return { planId: row.plan_id, rowVersion: row.row_version };
}

/**
 * Replicates `create_guild_season_plan`'s exact two-INSERT shape: a
 * `guild_season_plans` row (`operational_state='ACTIVE'` — "the plan is
 * immediately live/being tracked once created," per that Python function's
 * own documented judgment call, faithfully reproduced here rather than
 * re-litigated) plus its 1:1 `guild_season_progress` row, all counters 0,
 * `status='PENDING'` ("no official or estimated observation has been
 * recorded yet"). `plan_id` is generated locally as a fresh CHAR(26) ULID
 * (reusing `generateNotificationId`'s generic id-generation mechanism — it
 * is not notification-specific, merely named for its first call site).
 */
export async function createGuildSeasonPlan(
  db: Executor,
  params: {
    readonly guildId: string;
    readonly seasonId: string;
    readonly quotas: EffectiveQuotas;
    readonly createdUnderGuildConfigurationVersionId: number;
  },
): Promise<string> {
  const planId = generateNotificationId();
  await db
    .insertInto("guild_season_plans")
    .values({
      plan_id: planId,
      guild_id: bindBigIntUnsigned(params.guildId),
      season_id: params.seasonId,
      operational_state: "ACTIVE",
      quota_gc_hero: params.quotas.gcHero,
      quota_gc_titan: params.quotas.gcTitan,
      quota_hol: params.quotas.hol,
      quota_hero: params.quotas.hero,
      quota_titan: params.quotas.titan,
      created_under_guild_configuration_version_id: params.createdUnderGuildConfigurationVersionId,
    })
    .execute();
  await db
    .insertInto("guild_season_progress")
    .values({
      plan_id: planId,
      official_gc_hero: 0,
      official_gc_titan: 0,
      official_hol: 0,
      official_hero: 0,
      official_titan: 0,
      estimated_gc_hero: 0,
      estimated_gc_titan: 0,
      estimated_hol: 0,
      estimated_hero: 0,
      estimated_titan: 0,
      status: "PENDING",
    })
    .execute();
  return planId;
}

/**
 * ** Documented update-semantics choice ** (task's explicit "decide the
 * exact update semantics — document your choice"): a re-save of the
 * onboarding Season & Quotas section while a plan already exists for this
 * (guild, season) pair UPDATEs the 5 `quota_*` columns to the new effective
 * values AND `created_under_guild_configuration_version_id` (kept current —
 * pointing it at the version whose onboarding save actually triggered this
 * update is more useful for audit/traceability than leaving it frozen at
 * whichever version happened to create the row originally), plus bumps
 * `row_version` (this table's own existing optimistic-concurrency column,
 * consistent with every other guarded write in this codebase incrementing
 * it on a real content change). Never touches `guild_season_progress` — a
 * quota change has no bearing on already-recorded official/estimated
 * counters.
 */
export async function updateGuildSeasonPlanQuotas(
  db: Executor,
  params: {
    readonly planId: string;
    readonly quotas: EffectiveQuotas;
    readonly createdUnderGuildConfigurationVersionId: number;
  },
): Promise<void> {
  await db
    .updateTable("guild_season_plans")
    .set((eb) => ({
      quota_gc_hero: params.quotas.gcHero,
      quota_gc_titan: params.quotas.gcTitan,
      quota_hol: params.quotas.hol,
      quota_hero: params.quotas.hero,
      quota_titan: params.quotas.titan,
      created_under_guild_configuration_version_id: params.createdUnderGuildConfigurationVersionId,
      row_version: eb("row_version", "+", 1),
    }))
    .where("plan_id", "=", params.planId)
    .execute();
}

/**
 * The full Section 9 "separately, materialize/create-or-update a
 * guild_season_plans row if an eligible season exists" step — called AFTER
 * the effective quotas have already been written into the materialized
 * version's `guild_config_selfbot.nb_*` columns. If NO eligible season
 * exists, this is a deliberate no-op: the nb_* values simply sit as the
 * version's durable per-guild defaults, to be consumed whenever a future
 * season plan is created (see the doc comment at this function's own call
 * site and the accompanying regression test proving this exact behavior).
 */
export async function materializeSeasonPlanForOpenSeasonIfAny(
  db: Executor,
  params: {
    readonly guildId: string;
    readonly quotas: EffectiveQuotas;
    readonly materializedVersionId: number;
  },
): Promise<{ readonly seasonId: string; readonly planId: string } | null> {
  const openSeasonId = await getOpenSeasonId(db);
  if (openSeasonId === null) {
    return null;
  }
  const existing = await getSeasonPlanForGuildAndSeason(db, params.guildId, openSeasonId);
  if (existing) {
    await updateGuildSeasonPlanQuotas(db, {
      planId: existing.planId,
      quotas: params.quotas,
      createdUnderGuildConfigurationVersionId: params.materializedVersionId,
    });
    return { seasonId: openSeasonId, planId: existing.planId };
  }
  const planId = await createGuildSeasonPlan(db, {
    guildId: params.guildId,
    seasonId: openSeasonId,
    quotas: params.quotas,
    createdUnderGuildConfigurationVersionId: params.materializedVersionId,
  });
  return { seasonId: openSeasonId, planId };
}
