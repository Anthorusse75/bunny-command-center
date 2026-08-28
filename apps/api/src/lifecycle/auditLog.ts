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

/** Matches `MinimalLogger`/`MinimalPoolLogger`'s shape used elsewhere in this codebase (`notifications/service.ts`, `db/kysely.ts`) — not re-declared as an import to avoid a needless cross-module dependency for one method signature. */
export interface MinimalAuditLogger {
  error(obj: unknown, msg?: string): void;
}

/**
 * Step 10 external-review correction round, Section 15: writes `entry` as
 * its OWN, independently-committed statement via `pool` — NEVER the
 * caller's own (possibly about-to-roll-back) transaction handle. This is
 * the fix for a real bug: the guarded transition writer
 * (`lifecycleService.ts`'s `transitionGuildLifecycleInTransaction`) used to
 * `INSERT dashboard_audit_log; throw` inside the SAME transaction on a
 * rejected/failed transition — the `throw` rolls back the transaction,
 * silently rolling back the "failure" audit row too, making the code's own
 * comments claiming durable rejected-attempt evidence false. The pattern
 * this function centralizes: (1) the real business-mutation transaction is
 * attempted and rolled back on failure as before, (2) SEPARATELY, via this
 * function against the pool directly, the failure audit row is written —
 * genuinely durable regardless of what happens to the business transaction.
 *
 * A failure to write THIS audit row is caught and logged here — never
 * allowed to mask or replace whatever original rejection triggered it (the
 * original error is always still thrown/returned by the caller, unchanged).
 * `logger` defaults to `console`, matching this codebase's own established
 * default-logger precedent (`db/kysely.ts`'s `MinimalPoolLogger`) for
 * call sites that don't already have a request-scoped logger threaded
 * through.
 */
export async function writeDurableFailureAudit(
  pool: Executor,
  entry: AuditLogEntryInput,
  logger: MinimalAuditLogger = console,
): Promise<void> {
  try {
    await insertAuditLogEntry(pool, entry);
  } catch (err) {
    logger.error(
      { err, action: entry.action, guildId: entry.guildId },
      "writeDurableFailureAudit: failed to write a durable failure-audit row (non-fatal — the original rejection still stands)",
    );
  }
}
