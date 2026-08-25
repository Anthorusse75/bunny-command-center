/**
 * `dashboard_audit_log` writer (Step 10, migration 0011,
 * DASHBOARD/30_OBSERVABILITY_AND_AUDIT.md §Audit trail: "WHO / WHAT / WHEN /
 * GUILD / BEFORE / AFTER / CORRELATION / RESULT"). This is the ONE insert
 * path — every later step's sensitive mutation reuses this same function
 * rather than hand-rolling its own INSERT (mirrors `createNotification()`'s
 * "do not scatter INSERT logic across routes" precedent, `notifications/service.ts`).
 * Append-only: no update/delete function exists in this module by design
 * (30_OBSERVABILITY_AND_AUDIT.md: "no audit row is ever edited or deleted").
 */
import type { Kysely, Transaction } from "kysely";
import type { DB } from "../db/codegen-types.js";

export type Executor = Kysely<DB> | Transaction<DB>;

export interface AuditLogEntryInput {
  /** `dashboard_users.id` of the human actor, or `null` for a system-triggered entry (none exist in this step — every writer here is a real Guild Admin/Superadmin action). */
  readonly actorUserId: number | null;
  readonly action: string;
  readonly guildId: string | null;
  readonly beforeJson?: unknown;
  readonly afterJson?: unknown;
  /** Fastify's own per-request `request.id` (30_OBSERVABILITY_AND_AUDIT.md §Correlation IDs: "generated per-request (or propagated from an incoming header if present)") — reused as-is, never a second correlation mechanism invented. */
  readonly correlationId: string | null;
  readonly result: string;
}

export async function insertAuditLogEntry(db: Executor, entry: AuditLogEntryInput): Promise<void> {
  await db
    .insertInto("dashboard_audit_log")
    .values({
      actor_user_id: entry.actorUserId,
      action: entry.action,
      guild_id: entry.guildId,
      before_json: entry.beforeJson === undefined ? null : JSON.stringify(entry.beforeJson),
      after_json: entry.afterJson === undefined ? null : JSON.stringify(entry.afterJson),
      correlation_id: entry.correlationId,
      result: entry.result,
    })
    .execute();
}
