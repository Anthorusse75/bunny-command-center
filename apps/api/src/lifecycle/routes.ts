/**
 * `/api/guilds/:guildId/{onboarding,request-activation,pause,resume,reopen}`
 * and `/api/admin/{guilds/:guildId/{suspend,lift-suspension},activation-requests/:requestId/*}`
 * (IMPLEMENTATION/10_onboarding_approval.md). Session auth + CSRF header on
 * every mutation, Zod-validated params/body, `{ data }` success envelope —
 * same conventions as `apps/api/src/notifications/routes.ts`/`guilds/routes.ts`.
 *
 * Every guild-scoped SENSITIVE MUTATION here passes `{ freshness:
 * "SENSITIVE_MUTATION" }` to `requireTier` (auth/tier.ts's own documented
 * list explicitly includes "pause/resume, approval decision, admin role
 * policy change ... Steps 10/12"). Platform-scoped Superadmin actions
 * (suspend/lift-suspension, activation-request review) use the
 * single-argument `requireTier("SUPERADMIN")` form — no guild-membership
 * check, matching `10_GUILD_ONBOARDING_AND_APPROVAL.md`'s "PLATFORM_SUSPENDED:
 * Superadmin only" (a Superadmin need not be a Discord member of the guild
 * they are suspending).
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { DB } from "../db/codegen-types.js";
import type { AppConfig } from "../config.js";
import {
  activationRequestIdParamSchema,
  guildIdParamSchema,
  onboardingSectionSaveSchema,
  rejectActivationRequestSchema,
  requestChangesRequestSchema,
} from "@bunny-command-center/shared";
import {
  buildRequireTier,
  buildRequireGuildOwner,
  createGuildAuthDeps,
  type GuildAuthDeps,
} from "../auth/index.js";
import { buildRequireAuth, requireCsrfHeader } from "../auth/requireAuth.js";
import { getOnboardingState, saveOnboardingSection, OnboardingRejectedError } from "./onboardingService.js";
import { fetchGuildChannelCatalog } from "../integrations/bunnyInternalApi.js";
import { transitionGuildLifecycle, LifecycleTransitionRejectedError } from "./lifecycleService.js";
import {
  approveActivationRequest,
  createActivationRequest,
  getActivationRequestById,
  rejectActivationRequest,
  requestChangesOnActivationRequest,
  ActivationServiceError,
} from "./activationRequestsService.js";

async function validationError(reply: FastifyReply, key = "errors.validation"): Promise<void> {
  await reply.code(400).send({ error_code: "VALIDATION_ERROR", message_key: key, parameters: {} });
}

/**
 * Every service function in this module (`onboardingService.ts`,
 * `lifecycleService.ts`, `activationRequestsService.ts`) can surface EITHER
 * its own error class OR (since `activationRequestsService.ts`/`onboardingService.ts`
 * both call `transitionGuildLifecycle(InTransaction)` internally, inside
 * their own transaction) a `LifecycleTransitionRejectedError` bubbling up
 * from that inner call — a route that only caught its "own" error class
 * would 500 on this (found for real: the TOCTOU test's illegal-resubmission
 * check and the request-changes test's illegal-transition path both
 * surfaced exactly this in real-MySQL testing before this fix). Every route
 * handler below catches all three via this one helper instead of a
 * per-route `instanceof` chain.
 */
function serviceErrorCode(err: unknown): string | undefined {
  if (
    err instanceof OnboardingRejectedError ||
    err instanceof LifecycleTransitionRejectedError ||
    err instanceof ActivationServiceError
  ) {
    return err.code;
  }
  return undefined;
}

/** Maps every lifecycle/onboarding/activation service error onto the documented HTTP status + envelope — the ONE place that mapping happens. */
async function sendServiceError(reply: FastifyReply, code: string): Promise<void> {
  const table: Record<string, { status: number; errorCode: string; messageKey: string }> = {
    GUILD_NOT_FOUND: { status: 404, errorCode: "GUILD_NOT_FOUND", messageKey: "errors.guilds.notFound" },
    ILLEGAL_TRANSITION: {
      status: 409,
      errorCode: "ILLEGAL_TRANSITION",
      messageKey: "errors.lifecycle.illegalTransition",
    },
    INSUFFICIENT_TIER: {
      status: 403,
      errorCode: "FORBIDDEN",
      messageKey: "errors.auth.insufficientPermissions",
    },
    CORRUPT_SUSPENSION_STATE: {
      status: 500,
      errorCode: "CORRUPT_SUSPENSION_STATE",
      messageKey: "errors.lifecycle.corruptSuspensionState",
    },
    CONCURRENT_MODIFICATION: {
      status: 409,
      errorCode: "CONCURRENT_MODIFICATION",
      messageKey: "errors.lifecycle.concurrentModification",
    },
    NOT_EDITABLE: { status: 409, errorCode: "NOT_EDITABLE", messageKey: "errors.lifecycle.notEditable" },
    CHECKLIST_NOT_PASSED: {
      status: 400,
      errorCode: "CHECKLIST_NOT_PASSED",
      messageKey: "errors.onboarding.checklistNotPassed",
    },
    REQUEST_NOT_FOUND: {
      status: 404,
      errorCode: "REQUEST_NOT_FOUND",
      messageKey: "errors.lifecycle.requestNotFound",
    },
    REQUEST_ALREADY_DECIDED: {
      status: 409,
      errorCode: "REQUEST_ALREADY_DECIDED",
      messageKey: "errors.lifecycle.requestAlreadyDecided",
    },
    CHECKSUM_MISMATCH: {
      status: 409,
      errorCode: "CHECKSUM_MISMATCH",
      messageKey: "errors.lifecycle.checksumMismatch",
    },
    // Step 10 correction round, Gap 2: onboarding channel-section save
    // rejections — "couldn't verify" (Bunny unreachable/misconfigured/error)
    // is a distinct, clearer outcome from "verified, and it genuinely
    // doesn't exist" — both fail the save closed, never a silent accept.
    CHANNEL_VERIFICATION_FAILED: {
      status: 503,
      errorCode: "CHANNEL_VERIFICATION_FAILED",
      messageKey: "errors.onboarding.channelVerificationFailed",
    },
    CHANNEL_NOT_FOUND: {
      status: 400,
      errorCode: "CHANNEL_NOT_FOUND",
      messageKey: "errors.onboarding.channelNotFound",
    },
  };
  const entry = table[code] ?? { status: 500, errorCode: "INTERNAL_ERROR", messageKey: "errors.server" };
  await reply
    .code(entry.status)
    .send({ error_code: entry.errorCode, message_key: entry.messageKey, parameters: {} });
}

async function validateGuildIdParam(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = guildIdParamSchema.safeParse(request.params);
  if (!result.success) {
    await validationError(reply);
  }
}

export function buildLifecycleRoutes(
  db: Kysely<DB>,
  config: AppConfig,
  guildAuthDepsOverride?: GuildAuthDeps,
): FastifyPluginAsync {
  const guildAuthDeps = guildAuthDepsOverride ?? createGuildAuthDeps(db, config);
  const requireTier = buildRequireTier(guildAuthDeps);
  const requireGuildOwner = buildRequireGuildOwner(guildAuthDeps);
  const requireAuth = buildRequireAuth(db, config);
  const requireGuildAdmin = requireTier("guildId", "GUILD_ADMIN", { freshness: "SENSITIVE_MUTATION" });
  const requireOwner = requireGuildOwner("guildId", { freshness: "SENSITIVE_MUTATION" });
  const requireSuperadmin = requireTier("SUPERADMIN");

  // eslint-disable-next-line @typescript-eslint/require-await -- FastifyPluginAsync's contract
  return async (fastify) => {
    // -----------------------------------------------------------------
    // GET /api/guilds/:guildId/onboarding
    // -----------------------------------------------------------------
    fastify.get(
      "/api/guilds/:guildId/onboarding",
      { preHandler: [requireAuth, validateGuildIdParam, requireGuildAdmin] },
      async (request, reply) => {
        if (reply.sent) return undefined;
        const { guildId } = request.guildAuthorization!;
        try {
          const state = await getOnboardingState(db, guildId);
          return { data: state };
        } catch (err) {
          const code = serviceErrorCode(err);
          if (code) {
            return sendServiceError(reply, code);
          }
          throw err;
        }
      },
    );

    // -----------------------------------------------------------------
    // PATCH /api/guilds/:guildId/onboarding — one section per call.
    // -----------------------------------------------------------------
    fastify.patch(
      "/api/guilds/:guildId/onboarding",
      { preHandler: [requireAuth, validateGuildIdParam, requireCsrfHeader, requireGuildAdmin] },
      async (request, reply) => {
        if (reply.sent) return undefined;
        const parsedBody = onboardingSectionSaveSchema.safeParse(request.body);
        if (!parsedBody.success) {
          return validationError(reply);
        }
        const { guildId } = request.guildAuthorization!;
        try {
          const state = await saveOnboardingSection(db, config, {
            guildId,
            actorUserId: request.authUser!.id,
            actorDiscordId: request.authUser!.discordUserId,
            callerTier: request.guildAuthorization!.tier,
            correlationId: request.id ?? null,
            request: parsedBody.data,
          });
          return { data: state };
        } catch (err) {
          const code = serviceErrorCode(err);
          if (code) {
            return sendServiceError(reply, code);
          }
          throw err;
        }
      },
    );

    // -----------------------------------------------------------------
    // GET /api/guilds/:guildId/onboarding/channels — Step 10 correction
    // round, Gap 2: proxies Bunny's real live channel catalog for the
    // onboarding channel-picker dropdowns. Same Guild-Admin-scoped auth as
    // the rest of onboarding (READ freshness — this is a read, not a
    // sensitive mutation). ALWAYS 200: a Bunny-unreachable/misconfigured/
    // error outcome degrades to `{ available: false, channels: [] }` rather
    // than a 500 — the brief's explicit "never silently treat 'can't reach
    // Bunny' as 'channel doesn't exist' in a way that blocks all
    // onboarding": the picker degrades to disabled/error, the rest of the
    // page keeps working.
    // -----------------------------------------------------------------
    fastify.get(
      "/api/guilds/:guildId/onboarding/channels",
      { preHandler: [requireAuth, validateGuildIdParam, requireGuildAdmin] },
      async (request, reply) => {
        if (reply.sent) return undefined;
        const { guildId } = request.guildAuthorization!;
        const result = await fetchGuildChannelCatalog(config, guildId);
        if (!result.ok) {
          request.log.warn(
            { guildId, reason: result.reason },
            "onboarding/channels: Bunny catalog unavailable — degrading to available:false",
          );
          return { data: { available: false, channels: [] } };
        }
        return {
          data: {
            available: true,
            channels: result.channels.map((c) => ({
              id: c.id,
              name: c.name,
              position: c.position,
              type: c.type,
              canReadHistory: c.canReadHistory,
            })),
          },
        };
      },
    );

    // -----------------------------------------------------------------
    // POST /api/guilds/:guildId/request-activation
    // -----------------------------------------------------------------
    fastify.post(
      "/api/guilds/:guildId/request-activation",
      { preHandler: [requireAuth, validateGuildIdParam, requireCsrfHeader, requireGuildAdmin] },
      async (request, reply) => {
        if (reply.sent) return undefined;
        const { guildId } = request.guildAuthorization!;
        try {
          const result = await createActivationRequest(db, config, request.log, {
            guildId,
            actorUserId: request.authUser!.id,
            actorDiscordId: request.authUser!.discordUserId,
            callerTier: request.guildAuthorization!.tier,
            correlationId: request.id ?? null,
          });
          return { data: { requestId: result.requestId, lifecycleState: result.lifecycleState } };
        } catch (err) {
          const code = serviceErrorCode(err);
          if (code) {
            return sendServiceError(reply, code);
          }
          throw err;
        }
      },
    );

    // -----------------------------------------------------------------
    // POST /api/guilds/:guildId/{pause,resume} — literal Discord guild
    // OWNER only (Superadmin bypasses too), NOT merely GUILD_ADMIN tier.
    // Step 10 correction round, Gap 1: DASHBOARD/10_GUILD_ONBOARDING_AND_APPROVAL.md's
    // permission matrix says "Owner: pause"/"Owner: resume" — a Guild Admin
    // who holds the configured admin role or the Discord ADMINISTRATOR bit
    // but is NOT the guild's Owner must be rejected with 403. See
    // `auth/tier.ts`'s `buildRequireGuildOwner` for the exact mechanism
    // reused (`isCallerGuildOwner`, itself reusing `resolveGuildAuthorization`'s
    // own internal Owner check — no parallel "who is the owner" logic).
    // -----------------------------------------------------------------
    const ownerActions: Record<string, "PAUSE" | "RESUME"> = {
      pause: "PAUSE",
      resume: "RESUME",
    };
    for (const [path, action] of Object.entries(ownerActions)) {
      fastify.post(
        `/api/guilds/:guildId/${path}`,
        { preHandler: [requireAuth, validateGuildIdParam, requireCsrfHeader, requireOwner] },
        async (request, reply) => {
          if (reply.sent) return undefined;
          const { guildId } = request.guildAuthorization!;
          try {
            const result = await transitionGuildLifecycle(db, {
              guildId,
              action,
              callerTier: request.guildAuthorization!.tier,
              actorUserId: request.authUser!.id,
              correlationId: request.id ?? null,
            });
            return {
              data: { guildId, previousState: result.previousState, lifecycleState: result.nextState },
            };
          } catch (err) {
            const code = serviceErrorCode(err);
            if (code) {
              return sendServiceError(reply, code);
            }
            throw err;
          }
        },
      );
    }

    // -----------------------------------------------------------------
    // POST /api/guilds/:guildId/reopen — plain GUILD_ADMIN-scoped (verified
    // against DASHBOARD/10_GUILD_ONBOARDING_AND_APPROVAL.md's state machine:
    // "REJECTED --> CONFIGURING: Guild Admin may re-open" — no "Owner"
    // qualifier, unlike pause/resume above; correctly scoped already, left
    // unchanged).
    // -----------------------------------------------------------------
    fastify.post(
      "/api/guilds/:guildId/reopen",
      { preHandler: [requireAuth, validateGuildIdParam, requireCsrfHeader, requireGuildAdmin] },
      async (request, reply) => {
        if (reply.sent) return undefined;
        const { guildId } = request.guildAuthorization!;
        try {
          const result = await transitionGuildLifecycle(db, {
            guildId,
            action: "REOPEN",
            callerTier: request.guildAuthorization!.tier,
            actorUserId: request.authUser!.id,
            correlationId: request.id ?? null,
          });
          return {
            data: { guildId, previousState: result.previousState, lifecycleState: result.nextState },
          };
        } catch (err) {
          const code = serviceErrorCode(err);
          if (code) {
            return sendServiceError(reply, code);
          }
          throw err;
        }
      },
    );

    // -----------------------------------------------------------------
    // POST /api/admin/guilds/:guildId/{suspend,lift-suspension} — platform-
    // scoped Superadmin actions, no guild-membership check.
    // -----------------------------------------------------------------
    const superadminActions: Record<string, "SUSPEND" | "LIFT_SUSPENSION"> = {
      suspend: "SUSPEND",
      "lift-suspension": "LIFT_SUSPENSION",
    };
    for (const [path, action] of Object.entries(superadminActions)) {
      fastify.post(
        `/api/admin/guilds/:guildId/${path}`,
        { preHandler: [requireAuth, validateGuildIdParam, requireCsrfHeader, requireSuperadmin] },
        async (request, reply) => {
          if (reply.sent) return undefined;
          const { guildId } = request.params as { guildId: string };
          try {
            const result = await transitionGuildLifecycle(db, {
              guildId,
              action,
              callerTier: "SUPERADMIN",
              actorUserId: request.authUser!.id,
              correlationId: request.id ?? null,
            });
            return {
              data: { guildId, previousState: result.previousState, lifecycleState: result.nextState },
            };
          } catch (err) {
            const code = serviceErrorCode(err);
            if (code) {
              return sendServiceError(reply, code);
            }
            throw err;
          }
        },
      );
    }

    // -----------------------------------------------------------------
    // GET /api/admin/activation-requests/:requestId — frozen snapshot detail.
    // -----------------------------------------------------------------
    fastify.get(
      "/api/admin/activation-requests/:requestId",
      { preHandler: [requireAuth, requireSuperadmin] },
      async (request, reply) => {
        const parsedParams = activationRequestIdParamSchema.safeParse(request.params);
        if (!parsedParams.success) {
          return validationError(reply);
        }
        const row = await getActivationRequestById(db, parsedParams.data.requestId);
        if (!row) {
          return sendServiceError(reply, "REQUEST_NOT_FOUND");
        }
        return {
          data: {
            requestId: row.requestId,
            guildId: row.guildId,
            submittedConfigVersionId: row.submittedConfigVersionId,
            requestedBy: row.requestedBy,
            requestedAt: row.requestedAt.toISOString(),
            state: row.state,
            reviewedBy: row.reviewedBy,
            reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
            decisionReason: row.decisionReason,
          },
        };
      },
    );

    // -----------------------------------------------------------------
    // POST /api/admin/activation-requests/:requestId/approve
    // -----------------------------------------------------------------
    fastify.post(
      "/api/admin/activation-requests/:requestId/approve",
      { preHandler: [requireAuth, requireCsrfHeader, requireSuperadmin] },
      async (request, reply) => {
        if (reply.sent) return undefined;
        const parsedParams = activationRequestIdParamSchema.safeParse(request.params);
        if (!parsedParams.success) {
          return validationError(reply);
        }
        try {
          const result = await approveActivationRequest(db, config, request.log, {
            requestId: parsedParams.data.requestId,
            actorUserId: request.authUser!.id,
            actorDiscordId: request.authUser!.discordUserId,
            callerTier: "SUPERADMIN",
            correlationId: request.id ?? null,
          });
          return { data: result };
        } catch (err) {
          const code = serviceErrorCode(err);
          if (code) {
            return sendServiceError(reply, code);
          }
          throw err;
        }
      },
    );

    // -----------------------------------------------------------------
    // POST /api/admin/activation-requests/:requestId/reject — body { reason }
    // -----------------------------------------------------------------
    fastify.post(
      "/api/admin/activation-requests/:requestId/reject",
      { preHandler: [requireAuth, requireCsrfHeader, requireSuperadmin] },
      async (request, reply) => {
        if (reply.sent) return undefined;
        const parsedParams = activationRequestIdParamSchema.safeParse(request.params);
        const parsedBody = rejectActivationRequestSchema.safeParse(request.body);
        if (!parsedParams.success || !parsedBody.success) {
          return validationError(reply);
        }
        try {
          const result = await rejectActivationRequest(db, config, request.log, {
            requestId: parsedParams.data.requestId,
            reason: parsedBody.data.reason,
            actorUserId: request.authUser!.id,
            actorDiscordId: request.authUser!.discordUserId,
            callerTier: "SUPERADMIN",
            correlationId: request.id ?? null,
          });
          return { data: result };
        } catch (err) {
          const code = serviceErrorCode(err);
          if (code) {
            return sendServiceError(reply, code);
          }
          throw err;
        }
      },
    );

    // -----------------------------------------------------------------
    // POST /api/admin/activation-requests/:requestId/request-changes — body { reason }
    // -----------------------------------------------------------------
    fastify.post(
      "/api/admin/activation-requests/:requestId/request-changes",
      { preHandler: [requireAuth, requireCsrfHeader, requireSuperadmin] },
      async (request, reply) => {
        if (reply.sent) return undefined;
        const parsedParams = activationRequestIdParamSchema.safeParse(request.params);
        const parsedBody = requestChangesRequestSchema.safeParse(request.body);
        if (!parsedParams.success || !parsedBody.success) {
          return validationError(reply);
        }
        try {
          const result = await requestChangesOnActivationRequest(db, config, request.log, {
            requestId: parsedParams.data.requestId,
            reason: parsedBody.data.reason,
            actorUserId: request.authUser!.id,
            actorDiscordId: request.authUser!.discordUserId,
            callerTier: "SUPERADMIN",
            correlationId: request.id ?? null,
          });
          return { data: result };
        } catch (err) {
          const code = serviceErrorCode(err);
          if (code) {
            return sendServiceError(reply, code);
          }
          throw err;
        }
      },
    );
  };
}
