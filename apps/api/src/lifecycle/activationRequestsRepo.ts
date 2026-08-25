/**
 * `dashboard_guild_activation_requests` data access (migration 0012). Every
 * by-id mutation here guards on `state = :expectedState` in the SQL
 * predicate itself — the same "clear rejection rather than silent no-op"
 * discipline as `lifecycleRepo.ts`'s row_version guard, applied to this
 * table's own state machine (`PENDING`/`CHANGES_REQUESTED` -> a terminal
 * decision, exactly once).
 */
import type { Kysely, Transaction } from "kysely";
import type { DB } from "../db/codegen-types.js";
import type { ActivationRequestState } from "@bunny-command-center/shared";

export type Executor = Kysely<DB> | Transaction<DB>;

export interface ActivationRequestRow {
  readonly requestId: string;
  readonly guildId: string;
  readonly submittedConfigVersionId: number;
  readonly submittedConfigChecksum: Buffer;
  readonly requestedBy: string;
  readonly requestedAt: Date;
  readonly state: ActivationRequestState;
  readonly reviewedBy: string | null;
  readonly reviewedAt: Date | null;
  readonly decisionReason: string | null;
}

function mapRow(row: {
  request_id: string;
  guild_id: string;
  submitted_config_version_id: number;
  submitted_config_checksum: Buffer;
  requested_by: string;
  requested_at: Date;
  state: string;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  decision_reason: string | null;
}): ActivationRequestRow {
  return {
    requestId: row.request_id,
    guildId: row.guild_id,
    submittedConfigVersionId: row.submitted_config_version_id,
    submittedConfigChecksum: row.submitted_config_checksum,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    state: row.state as ActivationRequestState,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    decisionReason: row.decision_reason,
  };
}

const COLUMNS = [
  "request_id",
  "guild_id",
  "submitted_config_version_id",
  "submitted_config_checksum",
  "requested_by",
  "requested_at",
  "state",
  "reviewed_by",
  "reviewed_at",
  "decision_reason",
] as const;

export async function insertActivationRequest(
  db: Executor,
  params: {
    readonly requestId: string;
    readonly guildId: string;
    readonly submittedConfigVersionId: number;
    readonly submittedConfigChecksum: Buffer;
    readonly requestedBy: string;
  },
): Promise<void> {
  await db
    .insertInto("dashboard_guild_activation_requests")
    .values({
      request_id: params.requestId,
      guild_id: params.guildId,
      submitted_config_version_id: params.submittedConfigVersionId,
      submitted_config_checksum: params.submittedConfigChecksum,
      requested_by: params.requestedBy,
      state: "PENDING",
    })
    .execute();
}

export async function getActivationRequestById(
  db: Executor,
  requestId: string,
): Promise<ActivationRequestRow | undefined> {
  const row = await db
    .selectFrom("dashboard_guild_activation_requests")
    .select(COLUMNS)
    .where("request_id", "=", requestId)
    .executeTakeFirst();
  return row ? mapRow(row) : undefined;
}

/** The guild's current open (non-terminal) request, if any — re-submission always creates a NEW row rather than reusing this one, but callers need to find it to confirm it's superseded/left alone correctly. */
export async function getOpenRequestForGuild(
  db: Executor,
  guildId: string,
): Promise<ActivationRequestRow | undefined> {
  const row = await db
    .selectFrom("dashboard_guild_activation_requests")
    .select(COLUMNS)
    .where("guild_id", "=", guildId)
    .where("state", "in", ["PENDING", "CHANGES_REQUESTED"])
    .orderBy("requested_at", "desc")
    .executeTakeFirst();
  return row ? mapRow(row) : undefined;
}

/**
 * The guild's most recent request REGARDLESS of state — including a
 * terminal one (`REJECTED`/`CHANGES_REQUESTED`'s own decision reason).
 * SCREENS/ONBOARDING.md §Rejected / Changes requested: "the Superadmin's
 * reason surfaced prominently" — the Guild Admin has no `SUPERADMIN`-tier
 * access to `GET /api/admin/activation-requests/:requestId`, so
 * `onboardingService.ts`'s own response is the only place this can
 * reach the Guild Admin's screen. Real gap found and fixed while wiring the
 * frontend (00_GLOBAL_IMPLEMENTATION_RULES.md rule 5): without this, a
 * rejected/changes-requested Guild Admin would see nothing explaining why.
 */
export async function getLatestActivationRequestForGuild(
  db: Executor,
  guildId: string,
): Promise<ActivationRequestRow | undefined> {
  const row = await db
    .selectFrom("dashboard_guild_activation_requests")
    .select(COLUMNS)
    .where("guild_id", "=", guildId)
    .orderBy("requested_at", "desc")
    .executeTakeFirst();
  return row ? mapRow(row) : undefined;
}

/**
 * Guarded terminal-decision write — `state = :expectedState` in the WHERE
 * predicate means a request already decided (by a racing second
 * Superadmin click, or already terminal) matches zero rows rather than
 * silently double-applying a decision. Returns whether a row was actually
 * affected.
 */
export async function writeActivationRequestDecision(
  db: Executor,
  params: {
    readonly requestId: string;
    readonly expectedState: ActivationRequestState;
    readonly newState: ActivationRequestState;
    readonly reviewedBy: string;
    readonly decisionReason: string | null;
  },
): Promise<boolean> {
  const result = await db
    .updateTable("dashboard_guild_activation_requests")
    .set({
      state: params.newState,
      reviewed_by: params.reviewedBy,
      reviewed_at: new Date(),
      decision_reason: params.decisionReason,
    })
    .where("request_id", "=", params.requestId)
    .where("state", "=", params.expectedState)
    .executeTakeFirst();
  return (result.numUpdatedRows ?? 0n) > 0n;
}
