/**
 * Combines the pure `stateMachine.ts` with the real, guarded `lifecycleRepo.ts`
 * write and a `dashboard_audit_log` entry — ALL in one transaction
 * (IMPLEMENTATION/10_onboarding_approval.md: "every state transition writes
 * guilds.lifecycle_state ... keeping guilds.enabled in lockstep in the same
 * statement" + "dashboard_audit_log entries for every state transition").
 * This is the ONE entrypoint every route in `routes.ts` calls to change a
 * guild's lifecycle — no route ever writes `guilds.lifecycle_state` itself.
 */
import type { Kysely, Transaction } from "kysely";
import type { DB } from "../db/codegen-types.js";
import { applyLifecycleTransition, type LifecycleAction, type LifecycleState } from "./stateMachine.js";
import { getGuildLifecycleRow, writeLifecycleTransition } from "./lifecycleRepo.js";
import { insertAuditLogEntry } from "./auditLog.js";
import type { GuildTier } from "../auth/guildAuthorization.js";

export type LifecycleServiceErrorCode =
  | "GUILD_NOT_FOUND"
  | "ILLEGAL_TRANSITION"
  | "INSUFFICIENT_TIER"
  | "CORRUPT_SUSPENSION_STATE"
  | "CONCURRENT_MODIFICATION";

export class LifecycleTransitionRejectedError extends Error {
  constructor(
    public readonly code: LifecycleServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LifecycleTransitionRejectedError";
  }
}

export interface TransitionGuildLifecycleParams {
  readonly guildId: string;
  readonly action: LifecycleAction;
  readonly callerTier: GuildTier;
  readonly actorUserId: number;
  readonly correlationId: string | null;
  readonly reason?: string;
}

export interface TransitionGuildLifecycleResult {
  readonly guildId: string;
  readonly previousState: LifecycleState;
  readonly nextState: LifecycleState;
}

/**
 * The transaction BODY, factored out so callers that already have an open
 * transaction of their own (`onboardingService.ts`'s implicit
 * `DISCOVERED -> CONFIGURING` on first save, `activationRequestsService.ts`'s
 * request-activation/approve/reject/request-changes flows, which must
 * combine a lifecycle transition with their own additional writes
 * atomically) can call this directly instead of nesting a second,
 * kysely-unsupported transaction. `transitionGuildLifecycle` below is a thin
 * wrapper that opens its own transaction for the simple, single-purpose
 * routes (pause/resume/suspend/lift-suspension).
 */
export async function transitionGuildLifecycleInTransaction(
  trx: Transaction<DB>,
  params: TransitionGuildLifecycleParams,
): Promise<TransitionGuildLifecycleResult> {
  const row = await getGuildLifecycleRow(trx, params.guildId);
  if (!row) {
    throw new LifecycleTransitionRejectedError(
      "GUILD_NOT_FOUND",
      `transitionGuildLifecycle: no guilds row for guildId=${params.guildId} (bot not present)`,
    );
  }

  const outcome = applyLifecycleTransition(
    params.action,
    { currentState: row.lifecycleState, suspendedFromState: row.suspendedFromState },
    params.callerTier,
  );
  if (!outcome.ok) {
    await insertAuditLogEntry(trx, {
      actorUserId: params.actorUserId,
      action: `LIFECYCLE_${params.action}`,
      guildId: params.guildId,
      beforeJson: { lifecycleState: row.lifecycleState, suspendedFromState: row.suspendedFromState },
      afterJson: null,
      correlationId: params.correlationId,
      result: outcome.errorCode,
    });
    throw new LifecycleTransitionRejectedError(
      outcome.errorCode,
      `transitionGuildLifecycle: ${params.action} rejected from state=${row.lifecycleState} (${outcome.errorCode})`,
    );
  }

  const nextEnabled = outcome.nextState === "ACTIVE" ? 1 : 0;
  const wrote = await writeLifecycleTransition(trx, {
    guildId: params.guildId,
    expectedState: row.lifecycleState,
    expectedRowVersion: row.rowVersion,
    nextState: outcome.nextState,
    nextSuspendedFromState: outcome.nextSuspendedFromState,
    nextEnabled,
  });
  if (!wrote) {
    await insertAuditLogEntry(trx, {
      actorUserId: params.actorUserId,
      action: `LIFECYCLE_${params.action}`,
      guildId: params.guildId,
      beforeJson: { lifecycleState: row.lifecycleState, rowVersion: row.rowVersion },
      afterJson: null,
      correlationId: params.correlationId,
      result: "CONCURRENT_MODIFICATION",
    });
    throw new LifecycleTransitionRejectedError(
      "CONCURRENT_MODIFICATION",
      `transitionGuildLifecycle: ${params.guildId} was modified concurrently — retry`,
    );
  }

  await insertAuditLogEntry(trx, {
    actorUserId: params.actorUserId,
    action: `LIFECYCLE_${params.action}`,
    guildId: params.guildId,
    beforeJson: { lifecycleState: row.lifecycleState, suspendedFromState: row.suspendedFromState },
    // `result` (VARCHAR(32), migration 0011) is a short FIXED outcome tag —
    // any free-text detail (a reason string, a request id) belongs in
    // `afterJson`, never concatenated into `result` (a real bug this fixed:
    // `reason` here can be an arbitrary-length request id / Superadmin
    // reason string, which overflowed the column on the very first
    // request-activation call in real-MySQL testing).
    afterJson: {
      lifecycleState: outcome.nextState,
      suspendedFromState: outcome.nextSuspendedFromState,
      ...(params.reason ? { reason: params.reason } : {}),
    },
    correlationId: params.correlationId,
    result: "SUCCESS",
  });

  return { guildId: params.guildId, previousState: row.lifecycleState, nextState: outcome.nextState };
}

/**
 * A single-attempt optimistic-concurrency transition (IMPLEMENTATION/10_onboarding_approval.md
 * §Concurrency: "clear rejection rather than silent no-op" — never a silent
 * retry loop, which could mask two genuinely conflicting real-world actions,
 * e.g. a pause and a platform-suspend racing, as if only one had ever
 * happened). A caller that legitimately wants to retry (e.g. a UI re-reading
 * the current state and re-issuing the same click) does so explicitly, one
 * new call at a time. Opens its OWN transaction — for a caller that already
 * has one open, use `transitionGuildLifecycleInTransaction` directly.
 */
export async function transitionGuildLifecycle(
  db: Kysely<DB>,
  params: TransitionGuildLifecycleParams,
): Promise<TransitionGuildLifecycleResult> {
  return db.transaction().execute((trx) => transitionGuildLifecycleInTransaction(trx, params));
}
