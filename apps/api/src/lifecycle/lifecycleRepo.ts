/**
 * Reads/writes the SHARED `guilds` table's lifecycle columns (Step 07:
 * `lifecycle_state`/`lifecycle_state_changed_at`/`suspended_from_state`,
 * `vendor/self-bot-schema/database/migrations/0015_web_ingestion_and_guild_lifecycle.up.sql`).
 *
 * `guild_id` is a real Discord Snowflake stored as `BIGINT UNSIGNED` in this
 * SHARED table — every read here goes through `CAST(guild_id AS CHAR)` and
 * every write predicate binds via `bindBigIntUnsigned`, exactly mirroring
 * `apps/api/src/guilds/guildsService.ts`'s already-established, documented
 * precision-safety pattern for this exact table (that file's own header
 * comment has the full rationale — not re-derived here).
 */
import { sql, type Kysely, type Transaction } from "kysely";
import type { DB } from "../db/codegen-types.js";
import { bindBigIntUnsigned } from "../db/bigIntParam.js";
import { isLifecycleState, type LifecycleState } from "./stateMachine.js";

export type Executor = Kysely<DB> | Transaction<DB>;

export interface GuildLifecycleRow {
  readonly guildId: string;
  readonly lifecycleState: LifecycleState;
  readonly suspendedFromState: LifecycleState | null;
  readonly rowVersion: number;
  readonly enabled: boolean;
  readonly activeConfigVersionId: number | null;
  readonly displayName: string | null;
}

function toLifecycleStateOrThrow(value: string, context: string): LifecycleState {
  // 10_GUILD_ONBOARDING_AND_APPROVAL.md §Guild Lifecycle Durable Source:
  // "lifecycle_state itself is validated at the application layer ... a
  // value outside that enum is rejected before it reaches the database, not
  // tolerated and interpreted permissively." A row already in the DB with an
  // out-of-enum value would mean that invariant was violated somewhere else
  // (a bug, or a manual DB edit) — fails loudly here rather than silently
  // treating an unrecognized value as some default state.
  if (!isLifecycleState(value)) {
    throw new Error(
      `${context}: unrecognized lifecycle_state value in the database: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** `undefined` iff no `guilds` row exists for this id at all — i.e. the bot has never been added to this guild (10_GUILD_ONBOARDING_AND_APPROVAL.md: a row is created "when Bunny joins the guild", not by the Dashboard). */
export async function getGuildLifecycleRow(
  db: Executor,
  guildId: string,
): Promise<GuildLifecycleRow | undefined> {
  const row = await db
    .selectFrom("guilds")
    .select([
      sql<string>`CAST(guild_id AS CHAR)`.as("guildIdStr"),
      "lifecycle_state",
      "suspended_from_state",
      "row_version",
      "enabled",
      "active_config_version_id",
      "display_name_cache",
    ])
    .where(sql<string>`CAST(guild_id AS CHAR)`, "=", guildId)
    .executeTakeFirst();
  if (!row) {
    return undefined;
  }
  return {
    guildId: row.guildIdStr,
    lifecycleState: toLifecycleStateOrThrow(row.lifecycle_state, "getGuildLifecycleRow"),
    suspendedFromState:
      row.suspended_from_state === null
        ? null
        : toLifecycleStateOrThrow(row.suspended_from_state, "getGuildLifecycleRow"),
    rowVersion: Number(row.row_version),
    enabled: Boolean(row.enabled),
    activeConfigVersionId: row.active_config_version_id,
    displayName: row.display_name_cache,
  };
}

/**
 * The ONE write path for a lifecycle transition — sets `lifecycle_state` +
 * `lifecycle_state_changed_at` + `suspended_from_state` + the lockstep
 * `enabled` derivation in a SINGLE statement (10_GUILD_ONBOARDING_AND_APPROVAL.md:
 * "a single writer path"), guarded by BOTH `lifecycle_state = expectedState`
 * AND `row_version = expectedRowVersion` in the same WHERE predicate — an
 * optimistic-concurrency guard against two concurrent transition attempts
 * (e.g. a pause and a platform-suspend racing) using the free `row_version`
 * column `10_GUILD_ONBOARDING_AND_APPROVAL.md` already documents as
 * available for exactly this. Returns `false` (never throws) on a 0-row
 * match — the caller (`lifecycleService.ts`) turns that into an explicit
 * "state changed under you, retry" rejection, never a silent no-op
 * (IMPLEMENTATION/10_onboarding_approval.md §Concurrency: "clear rejection
 * rather than silent no-op").
 */
export async function writeLifecycleTransition(
  db: Executor,
  params: {
    readonly guildId: string;
    readonly expectedState: LifecycleState;
    readonly expectedRowVersion: number;
    readonly nextState: LifecycleState;
    readonly nextSuspendedFromState: LifecycleState | null;
    readonly nextEnabled: 0 | 1;
  },
): Promise<boolean> {
  const result = await db
    .updateTable("guilds")
    .set({
      lifecycle_state: params.nextState,
      lifecycle_state_changed_at: new Date(),
      suspended_from_state: params.nextSuspendedFromState,
      enabled: params.nextEnabled,
      row_version: sql`row_version + 1`,
    })
    .where(sql<string>`CAST(guild_id AS CHAR)`, "=", params.guildId)
    .where("lifecycle_state", "=", params.expectedState)
    .where("row_version", "=", params.expectedRowVersion)
    .executeTakeFirst();
  return (result.numUpdatedRows ?? 0n) > 0n;
}

/**
 * Sets `guilds.active_config_version_id` — used only by the (minimal, this
 * step's disclosed scope) onboarding-approval path's `APPROVE` action, which
 * adopts the exact snapshot that was reviewed
 * (`dashboard_guild_activation_requests.submitted_config_version_id`) as the
 * guild's real active configuration at the same time it flips
 * `lifecycle_state` to `ACTIVE`. Bound via `bindBigIntUnsigned` (guildId is a
 * BIGINT UNSIGNED predicate column; the config-version id itself is a plain
 * internal auto-increment sequence, not Snowflake-shaped, so it is passed
 * through unchanged).
 */
export async function setActiveConfigVersion(
  db: Executor,
  params: { readonly guildId: string; readonly configVersionId: number },
): Promise<void> {
  await db
    .updateTable("guilds")
    .set({ active_config_version_id: params.configVersionId })
    .where("guild_id", "=", bindBigIntUnsigned(params.guildId))
    .execute();
}
