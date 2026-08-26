/**
 * Snapshot-based approval workflow (Step 10,
 * DASHBOARD/10_GUILD_ONBOARDING_AND_APPROVAL.md §Approval workflow — the
 * TOCTOU-closing sequence diagram). `routes.ts` calls exactly these three
 * functions for `POST /api/guilds/:guildId/request-activation` and
 * `POST /api/admin/activation-requests/:requestId/{approve,request-changes,reject}`.
 *
 * Notification creation (`createNotification`, Step 09) always happens
 * AFTER this module's own transaction commits — Kysely/mysql2 has no nested
 * transaction (savepoint) support in this codebase, and `createNotification`
 * always opens its own `db.transaction()`
 * (`apps/api/src/notifications/service.ts`), so it cannot be called from
 * inside an already-open one. A failure creating the notification is caught
 * and logged, never allowed to undo or fail the already-committed lifecycle
 * transition/activation-request row — mirrors this codebase's own
 * established "a failed DM must never lose the underlying [durable fact]"
 * precedent (ADR-013, `notifications/service.ts`'s own SEND_DM try/catch).
 */
import type { Kysely } from "kysely";
import type { DB } from "../db/codegen-types.js";
import type { AppConfig } from "../config.js";
import { createNotification, type MinimalLogger } from "../notifications/service.js";
import { findDashboardUserByDiscordId } from "../auth/userRepo.js";
import type { GuildTier } from "../auth/guildAuthorization.js";
import { getGuildLifecycleRow } from "./lifecycleRepo.js";
import { transitionGuildLifecycleInTransaction } from "./lifecycleService.js";
import {
  ensureOnboardingProgressRow,
  isVersionImmutable,
  loadMaterializedConfigValues,
  materializeDraftConfigVersion,
  minimumChecklistPassed,
  ConfigVersionRaceError,
} from "./onboardingRepo.js";
import { computeMaterializedConfigChecksum } from "./configChecksum.js";
import {
  getActivationRequestById,
  getOpenRequestForGuild,
  insertActivationRequest,
  writeActivationRequestDecision,
  type ActivationRequestRow,
} from "./activationRequestsRepo.js";
import { setActiveConfigVersion } from "./lifecycleRepo.js";
import { insertAuditLogEntry, writeDurableFailureAudit } from "./auditLog.js";
import { generateNotificationId } from "../notifications/id.js";
import type { LifecycleAction } from "./stateMachine.js";

export type ActivationServiceErrorCode =
  | "GUILD_NOT_FOUND"
  | "ILLEGAL_TRANSITION"
  | "INSUFFICIENT_TIER"
  | "CHECKLIST_NOT_PASSED"
  | "REQUEST_NOT_FOUND"
  | "REQUEST_ALREADY_DECIDED"
  | "CHECKSUM_MISMATCH"
  | "CONCURRENT_MODIFICATION";

export class ActivationServiceError extends Error {
  constructor(
    public readonly code: ActivationServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ActivationServiceError";
  }
}

interface CommonParams {
  readonly actorUserId: number;
  readonly actorDiscordId: string;
  readonly callerTier: GuildTier;
  readonly correlationId: string | null;
}

async function notifySuperadminNewGuildPending(
  db: Kysely<DB>,
  config: AppConfig,
  logger: MinimalLogger,
  params: {
    readonly guildId: string;
    readonly guildName: string;
    readonly requestId: string;
    readonly requestedByDiscordId: string;
  },
): Promise<void> {
  try {
    const superadminUser = await findDashboardUserByDiscordId(db, config.superadmin.discordUserId);
    if (!superadminUser) {
      logger.error(
        { guildId: params.guildId },
        "activationRequests: Superadmin has never logged in (no dashboard_users row) — skipping in-app notification; the durable activation-request row is unaffected",
      );
      return;
    }
    await createNotification(
      db,
      config,
      {
        userId: superadminUser.id,
        eventType: "NEW_GUILD_PENDING",
        parameters: { guildName: params.guildName },
        guildId: params.guildId,
        deeplinkPath: `/admin/platform/guilds/${params.guildId}/review/${params.requestId}`,
        triggeredBy: { discordUserId: params.requestedByDiscordId, role: "GUILD_ADMIN" },
      },
      logger,
    );
  } catch (err) {
    logger.error(
      { err, guildId: params.guildId },
      "activationRequests: failed to notify Superadmin (non-fatal)",
    );
  }
}

async function notifyGuildAdminApprovalStateChange(
  db: Kysely<DB>,
  config: AppConfig,
  logger: MinimalLogger,
  params: {
    readonly guildId: string;
    readonly guildName: string;
    readonly state: string;
    readonly requestedByDiscordId: string;
    readonly reviewerDiscordId: string;
  },
): Promise<void> {
  try {
    const requester = await findDashboardUserByDiscordId(db, params.requestedByDiscordId);
    if (!requester) {
      logger.error(
        { guildId: params.guildId },
        "activationRequests: requesting Guild Admin has no dashboard_users row — skipping in-app notification",
      );
      return;
    }
    await createNotification(
      db,
      config,
      {
        userId: requester.id,
        eventType: "GUILD_APPROVAL_STATE_CHANGE",
        parameters: { guildName: params.guildName, state: params.state },
        guildId: params.guildId,
        // Real route path (apps/web/src/navigation/routes.tsx): singular
        // "/guild/:guildId/onboarding" — a real bug found by reading the
        // actual route table (00_GLOBAL_IMPLEMENTATION_RULES.md rule 4: "the
        // live repo is the authority over this document set's description
        // of what exists"), NOT the plural "/guilds/..." this file
        // originally guessed.
        deeplinkPath: `/guild/${params.guildId}/onboarding`,
        triggeredBy: { discordUserId: params.reviewerDiscordId, role: "SUPERADMIN" },
      },
      logger,
    );
  } catch (err) {
    logger.error(
      { err, guildId: params.guildId },
      "activationRequests: failed to notify Guild Admin (non-fatal)",
    );
  }
}

export interface CreateActivationRequestResult {
  readonly requestId: string;
  readonly lifecycleState: string;
}

/**
 * `POST /api/guilds/:guildId/request-activation` — handles BOTH the first
 * submission (`CONFIGURING -> PENDING_APPROVAL`) and re-submission
 * (`CHANGES_REQUESTED -> PENDING_APPROVAL`, "Guild Admin re-submits") behind
 * one entrypoint, matching SCREENS/ONBOARDING.md's single "Request
 * activation"/"Re-submit" CTA. Re-validates the minimum checklist
 * SERVER-SIDE regardless of what the client claims (rejection criteria:
 * "any client-only enforcement of the minimum-checklist gate").
 */
export async function createActivationRequest(
  db: Kysely<DB>,
  config: AppConfig,
  logger: MinimalLogger,
  params: CommonParams & { readonly guildId: string },
): Promise<CreateActivationRequestResult> {
  // Step 10 correction round, Gap 5: `materializeDraftConfigVersion` can
  // throw `ConfigVersionRaceError` on a real concurrent-INSERT race (see its
  // own doc comment, onboardingRepo.ts) — caught here and mapped onto the
  // same typed `CONCURRENT_MODIFICATION` conflict every other guarded write
  // in this step already produces, never left as an unhandled 500.
  let outcome;
  try {
    outcome = await db.transaction().execute(async (trx) => {
      const guildRow = await getGuildLifecycleRow(trx, params.guildId);
      if (!guildRow) {
        throw new ActivationServiceError("GUILD_NOT_FOUND", `no guilds row for ${params.guildId}`);
      }
      const action: LifecycleAction =
        guildRow.lifecycleState === "CONFIGURING"
          ? "REQUEST_ACTIVATION"
          : guildRow.lifecycleState === "CHANGES_REQUESTED"
            ? "RESUBMIT_ACTIVATION"
            : "REQUEST_ACTIVATION"; // deliberately invalid from any other state — transitionGuildLifecycleInTransaction below rejects it as ILLEGAL_TRANSITION, never silently guessed as legal.

      const progress = await ensureOnboardingProgressRow(trx, params.guildId);
      if (!minimumChecklistPassed(progress.sections)) {
        throw new ActivationServiceError(
          "CHECKLIST_NOT_PASSED",
          "server-side minimum-checklist re-validation failed (client-disabled-button bypass attempt rejected)",
        );
      }

      const currentDraftIsImmutable =
        progress.draftConfigVersionId !== null
          ? await isVersionImmutable(trx, progress.draftConfigVersionId)
          : false;

      const { versionId, checksum } = await materializeDraftConfigVersion(trx, {
        guildId: params.guildId,
        authorDiscordId: params.actorDiscordId,
        sections: progress.sections,
        currentDraftVersionId: progress.draftConfigVersionId,
        currentDraftIsImmutable,
      });

      const requestId = generateNotificationId();
      await insertActivationRequest(trx, {
        requestId,
        guildId: params.guildId,
        submittedConfigVersionId: versionId,
        submittedConfigChecksum: checksum,
        requestedBy: params.actorDiscordId,
      });

      const transition = await transitionGuildLifecycleInTransaction(trx, db, {
        guildId: params.guildId,
        action,
        callerTier: params.callerTier,
        actorUserId: params.actorUserId,
        correlationId: params.correlationId,
        reason: `activation request ${requestId}`,
        logger,
      });

      await insertAuditLogEntry(trx, {
        actorUserId: params.actorUserId,
        action: "ACTIVATION_REQUEST_CREATED",
        guildId: params.guildId,
        beforeJson: null,
        afterJson: { requestId, submittedConfigVersionId: versionId },
        correlationId: params.correlationId,
        result: "SUCCESS",
      });

      return {
        requestId,
        lifecycleState: transition.nextState,
        guildName: guildRow.displayName ?? params.guildId,
      };
    });
  } catch (err) {
    if (err instanceof ConfigVersionRaceError) {
      throw new ActivationServiceError("CONCURRENT_MODIFICATION", err.message);
    }
    throw err;
  }

  await notifySuperadminNewGuildPending(db, config, logger, {
    guildId: params.guildId,
    guildName: outcome.guildName,
    requestId: outcome.requestId,
    requestedByDiscordId: params.actorDiscordId,
  });

  return { requestId: outcome.requestId, lifecycleState: outcome.lifecycleState };
}

async function loadPendingRequestOrThrow(db: Kysely<DB>, requestId: string): Promise<ActivationRequestRow> {
  const request = await getActivationRequestById(db, requestId);
  if (!request) {
    throw new ActivationServiceError("REQUEST_NOT_FOUND", `no activation request ${requestId}`);
  }
  return request;
}

export interface DecisionResult {
  readonly requestId: string;
  readonly lifecycleState: string | null;
}

/**
 * `POST /api/admin/activation-requests/:requestId/approve` — re-verifies
 * `submitted_config_checksum` still matches the referenced version (defense
 * in depth) before flipping `lifecycle_state`, adopts the reviewed snapshot
 * as `guilds.active_config_version_id`, and marks the SHARED
 * `guild_configuration_versions` row `ACTIVE` (superseding whatever was
 * previously `ACTIVE` for this guild, if anything).
 */
export async function approveActivationRequest(
  db: Kysely<DB>,
  config: AppConfig,
  logger: MinimalLogger,
  params: CommonParams & { readonly requestId: string },
): Promise<DecisionResult> {
  // Step 10 correction round, Gap 4: a checksum mismatch must leave a durable
  // audit trail of the integrity failure — but the mismatch is detected
  // INSIDE the transaction below, and throwing out of `db.transaction().execute()`
  // rolls back every write that transaction made (correctly — nothing about
  // the rejected approval should persist). An audit row recording the
  // failure therefore CANNOT be written inside that same transaction (it
  // would be rolled back with everything else); it is written via the outer
  // `db` handle, in its own separate committed statement, from the catch
  // block below, only for this one specific error code.
  let guildIdForIntegrityAudit: string | undefined;
  try {
    const outcome = await db.transaction().execute(async (trx) => {
      const request = await loadPendingRequestOrThrow(trx, params.requestId);
      guildIdForIntegrityAudit = request.guildId;
      if (request.state !== "PENDING") {
        throw new ActivationServiceError(
          "REQUEST_ALREADY_DECIDED",
          `request ${params.requestId} is already ${request.state}`,
        );
      }

      // Step 10 external-review correction round, Section 5.1: defense in
      // depth used to compare ONLY `guild_configuration_versions.checksum`
      // against `submitted_config_checksum` — it never re-derived anything
      // from the REAL, live sub-table rows, so an out-of-band mutation of a
      // sub-table column (e.g. directly UPDATE-ing `guild_config_bunny`)
      // that left `guild_configuration_versions.checksum` itself untouched
      // would have sailed through undetected. Fixed: load the referenced
      // version's REAL `guild_config_common`/`guild_config_bunny`/
      // `guild_config_selfbot`/`guild_config_orchestrator` rows
      // (`loadMaterializedConfigValues` — the SAME reader materialization
      // itself uses, so the two can never define "the real row content"
      // differently), recompute the checksum with the canonical serializer
      // (`configChecksum.ts`), and require ALL THREE values to agree:
      // recomputed == guild_configuration_versions.checksum ==
      // submitted_config_checksum. Any disagreement — a stale/tampered
      // stored checksum column, tampered sub-table content, or a genuinely
      // stale submitted_config_checksum — fails closed exactly like the
      // original single-comparison check (audit, no activation, no
      // notification).
      const storedVersion = await trx
        .selectFrom("guild_configuration_versions")
        .select("checksum")
        .where("id", "=", request.submittedConfigVersionId)
        .executeTakeFirst();
      const realValues = await loadMaterializedConfigValues(trx, request.submittedConfigVersionId);
      const recomputedChecksum = realValues ? computeMaterializedConfigChecksum(realValues) : null;
      const integrityOk =
        storedVersion !== undefined &&
        recomputedChecksum !== null &&
        Buffer.compare(recomputedChecksum, storedVersion.checksum) === 0 &&
        Buffer.compare(recomputedChecksum, request.submittedConfigChecksum) === 0;
      if (!integrityOk) {
        throw new ActivationServiceError(
          "CHECKSUM_MISMATCH",
          `recomputed checksum from the real guild_config_* sub-table rows does not agree with guild_configuration_versions.checksum and/or submitted_config_checksum for version id=${request.submittedConfigVersionId} — refusing to approve a mutated/tampered snapshot`,
        );
      }

      const decided = await writeActivationRequestDecision(trx, {
        requestId: params.requestId,
        expectedState: "PENDING",
        newState: "APPROVED",
        reviewedBy: params.actorDiscordId,
        decisionReason: null,
      });
      if (!decided) {
        throw new ActivationServiceError(
          "REQUEST_ALREADY_DECIDED",
          `request ${params.requestId} was decided concurrently`,
        );
      }

      // Supersede whatever was previously ACTIVE for this guild, then
      // activate the reviewed version — same "one ACTIVE at a time" discipline
      // as `hero_reference_catalog_versions.active_marker`.
      const guildRow = await getGuildLifecycleRow(trx, request.guildId);
      if (guildRow?.activeConfigVersionId) {
        await trx
          .updateTable("guild_configuration_versions")
          .set({ state: "SUPERSEDED", superseded_at: new Date() })
          .where("id", "=", guildRow.activeConfigVersionId)
          .where("state", "=", "ACTIVE")
          .execute();
      }
      await trx
        .updateTable("guild_configuration_versions")
        .set({ state: "ACTIVE", activated_at: new Date() })
        .where("id", "=", request.submittedConfigVersionId)
        .execute();
      await setActiveConfigVersion(trx, {
        guildId: request.guildId,
        configVersionId: request.submittedConfigVersionId,
      });

      const transition = await transitionGuildLifecycleInTransaction(trx, db, {
        guildId: request.guildId,
        action: "APPROVE",
        callerTier: params.callerTier,
        actorUserId: params.actorUserId,
        correlationId: params.correlationId,
        reason: `activation request ${params.requestId} approved`,
        logger,
      });

      await insertAuditLogEntry(trx, {
        actorUserId: params.actorUserId,
        action: "ACTIVATION_REQUEST_APPROVED",
        guildId: request.guildId,
        beforeJson: { requestState: "PENDING" },
        afterJson: { requestState: "APPROVED", activeConfigVersionId: request.submittedConfigVersionId },
        correlationId: params.correlationId,
        result: "SUCCESS",
      });

      return {
        requestId: params.requestId,
        lifecycleState: transition.nextState,
        guildId: request.guildId,
        guildName: guildRow?.displayName ?? request.guildId,
        requestedBy: request.requestedBy,
      };
    });

    await notifyGuildAdminApprovalStateChange(db, config, logger, {
      guildId: outcome.guildId,
      guildName: outcome.guildName,
      state: "APPROVED",
      requestedByDiscordId: outcome.requestedBy,
      reviewerDiscordId: params.actorDiscordId,
    });

    return { requestId: outcome.requestId, lifecycleState: outcome.lifecycleState };
  } catch (err) {
    // Step 10 correction round, Gap 4: record the integrity failure durably
    // — a real out-of-band mutation of a referenced `guild_configuration_versions`
    // row is exactly the "impossible" case defense-in-depth exists for; a
    // Superadmin (and any later investigator) must be able to see in
    // `dashboard_audit_log` that an approval was refused for this reason,
    // never just a silent 409 with no trace. Written via the OUTER `db`
    // (never `trx`, already rolled back by the throw) as its own committed
    // statement — a failure to write this audit row is logged but must never
    // mask or replace the original `CHECKSUM_MISMATCH` rejection.
    if (err instanceof ActivationServiceError && err.code === "CHECKSUM_MISMATCH") {
      // Section 15: routed through the centralized `writeDurableFailureAudit`
      // helper (same one `lifecycleService.ts`'s guarded transition writer
      // now uses) rather than hand-rolling the raw-pool-write-plus-catch
      // boilerplate here — this was the ORIGINAL, hand-rolled instance of
      // exactly the pattern Section 15 asks to centralize.
      await writeDurableFailureAudit(
        db,
        {
          actorUserId: params.actorUserId,
          action: "ACTIVATION_REQUEST_APPROVAL_INTEGRITY_FAILURE",
          guildId: guildIdForIntegrityAudit ?? null,
          beforeJson: { requestId: params.requestId, requestState: "PENDING" },
          afterJson: null,
          correlationId: params.correlationId,
          result: "FAILURE",
        },
        logger,
      );
    }
    throw err;
  }
}

async function decideNonApprove(
  db: Kysely<DB>,
  config: AppConfig,
  logger: MinimalLogger,
  params: CommonParams & { readonly requestId: string; readonly reason: string },
  action: Extract<LifecycleAction, "REJECT" | "REQUEST_CHANGES">,
  newRequestState: "REJECTED" | "CHANGES_REQUESTED",
): Promise<DecisionResult> {
  const outcome = await db.transaction().execute(async (trx) => {
    const request = await loadPendingRequestOrThrow(trx, params.requestId);
    if (request.state !== "PENDING") {
      throw new ActivationServiceError(
        "REQUEST_ALREADY_DECIDED",
        `request ${params.requestId} is already ${request.state}`,
      );
    }
    const decided = await writeActivationRequestDecision(trx, {
      requestId: params.requestId,
      expectedState: "PENDING",
      newState: newRequestState,
      reviewedBy: params.actorDiscordId,
      decisionReason: params.reason,
    });
    if (!decided) {
      throw new ActivationServiceError(
        "REQUEST_ALREADY_DECIDED",
        `request ${params.requestId} was decided concurrently`,
      );
    }

    const guildRow = await getGuildLifecycleRow(trx, request.guildId);
    const transition = await transitionGuildLifecycleInTransaction(trx, db, {
      guildId: request.guildId,
      action,
      callerTier: params.callerTier,
      actorUserId: params.actorUserId,
      correlationId: params.correlationId,
      reason: `activation request ${params.requestId} ${newRequestState.toLowerCase()}: ${params.reason}`,
      logger,
    });

    await insertAuditLogEntry(trx, {
      actorUserId: params.actorUserId,
      action: `ACTIVATION_REQUEST_${newRequestState}`,
      guildId: request.guildId,
      beforeJson: { requestState: "PENDING" },
      afterJson: { requestState: newRequestState, reason: params.reason },
      correlationId: params.correlationId,
      result: "SUCCESS",
    });

    return {
      requestId: params.requestId,
      lifecycleState: transition.nextState,
      guildId: request.guildId,
      guildName: guildRow?.displayName ?? request.guildId,
      requestedBy: request.requestedBy,
    };
  });

  await notifyGuildAdminApprovalStateChange(db, config, logger, {
    guildId: outcome.guildId,
    guildName: outcome.guildName,
    state: newRequestState,
    requestedByDiscordId: outcome.requestedBy,
    reviewerDiscordId: params.actorDiscordId,
  });

  return { requestId: outcome.requestId, lifecycleState: outcome.lifecycleState };
}

export async function rejectActivationRequest(
  db: Kysely<DB>,
  config: AppConfig,
  logger: MinimalLogger,
  params: CommonParams & { readonly requestId: string; readonly reason: string },
): Promise<DecisionResult> {
  return decideNonApprove(db, config, logger, params, "REJECT", "REJECTED");
}

export async function requestChangesOnActivationRequest(
  db: Kysely<DB>,
  config: AppConfig,
  logger: MinimalLogger,
  params: CommonParams & { readonly requestId: string; readonly reason: string },
): Promise<DecisionResult> {
  return decideNonApprove(db, config, logger, params, "REQUEST_CHANGES", "CHANGES_REQUESTED");
}

export { getOpenRequestForGuild, getActivationRequestById };
