/**
 * Onboarding stepper service (Step 10). `GET/PATCH /api/guilds/:guildId/onboarding`
 * (routes.ts) call exactly these two functions — no route touches
 * `onboardingRepo.ts`/`lifecycleService.ts` directly.
 */
import type { Kysely } from "kysely";
import type { DB } from "../db/codegen-types.js";
import type { OnboardingSectionSaveRequest, OnboardingStateResponse } from "@bunny-command-center/shared";
import { getGuildLifecycleRow } from "./lifecycleRepo.js";
import { transitionGuildLifecycleInTransaction } from "./lifecycleService.js";
import {
  ensureOnboardingProgressRow,
  minimumChecklistPassed,
  saveOnboardingSectionData,
  sectionStatuses,
} from "./onboardingRepo.js";
import { getLatestActivationRequestForGuild } from "./activationRequestsRepo.js";
import { setGuildAdminRole } from "../auth/guildPolicyRepo.js";
import type { GuildTier } from "../auth/guildAuthorization.js";

export class OnboardingRejectedError extends Error {
  constructor(
    public readonly code: "GUILD_NOT_FOUND" | "NOT_EDITABLE",
    message: string,
  ) {
    super(message);
    this.name = "OnboardingRejectedError";
  }
}

// 10_GUILD_ONBOARDING_AND_APPROVAL.md's per-state permission matrix: config
// stays editable in every state except PLATFORM_SUSPENDED ("read-only").
const NON_EDITABLE_STATES = new Set(["PLATFORM_SUSPENDED"]);

async function buildResponse(db: Kysely<DB>, guildId: string): Promise<OnboardingStateResponse> {
  const [guildRow, progress, latestRequest] = await Promise.all([
    getGuildLifecycleRow(db, guildId),
    ensureOnboardingProgressRow(db, guildId),
    getLatestActivationRequestForGuild(db, guildId),
  ]);
  if (!guildRow) {
    throw new OnboardingRejectedError("GUILD_NOT_FOUND", `onboarding: no guilds row for ${guildId}`);
  }
  const incoming = progress.sections.incomingChannel?.data as { channelId?: string } | undefined;
  const hero = progress.sections.heroChannel?.data as { channelId?: string } | undefined;
  const community = progress.sections.communityChannel?.data as { channelId?: string | null } | undefined;
  const quotas = progress.sections.seasonQuotas?.data as { categories?: string[] } | undefined;
  const notifications = progress.sections.notifications?.data as
    { inAppEnabled?: boolean; discordDmEnabled?: boolean } | undefined;
  const adminRole = progress.sections.adminRolePolicy?.data as
    { adminRoleDiscordId?: string | null } | undefined;
  const bunnyPermissions = progress.sections.bunnyPermissions?.data as { acknowledged?: boolean } | undefined;

  return {
    guildId,
    lifecycleState: guildRow.lifecycleState,
    sections: sectionStatuses(progress.sections),
    minimumChecklistPassed: minimumChecklistPassed(progress.sections),
    latestRequest: latestRequest
      ? {
          requestId: latestRequest.requestId,
          state: latestRequest.state,
          decisionReason: latestRequest.decisionReason,
        }
      : null,
    values: {
      incomingChannelId: incoming?.channelId ?? null,
      heroChannelId: hero?.channelId ?? null,
      communityChannelId: community?.channelId ?? null,
      seasonQuotaCategories: quotas?.categories ?? [],
      notificationsInAppEnabled: notifications?.inAppEnabled ?? null,
      notificationsDiscordDmEnabled: notifications?.discordDmEnabled ?? null,
      adminRoleDiscordId: adminRole?.adminRoleDiscordId ?? null,
      bunnyPermissionsAcknowledged: bunnyPermissions?.acknowledged ?? false,
    },
  };
}

export async function getOnboardingState(db: Kysely<DB>, guildId: string): Promise<OnboardingStateResponse> {
  return buildResponse(db, guildId);
}

export async function saveOnboardingSection(
  db: Kysely<DB>,
  params: {
    readonly guildId: string;
    readonly actorUserId: number;
    readonly actorDiscordId: string;
    readonly callerTier: GuildTier;
    readonly correlationId: string | null;
    readonly request: OnboardingSectionSaveRequest;
  },
): Promise<OnboardingStateResponse> {
  await db.transaction().execute(async (trx) => {
    const guildRow = await getGuildLifecycleRow(trx, params.guildId);
    if (!guildRow) {
      throw new OnboardingRejectedError("GUILD_NOT_FOUND", `onboarding: no guilds row for ${params.guildId}`);
    }
    if (NON_EDITABLE_STATES.has(guildRow.lifecycleState)) {
      throw new OnboardingRejectedError(
        "NOT_EDITABLE",
        `onboarding: guild ${params.guildId} is ${guildRow.lifecycleState} (read-only)`,
      );
    }

    // Permission matrix: "DISCOVERED: yes (starts CONFIGURING on first edit)".
    if (guildRow.lifecycleState === "DISCOVERED") {
      await transitionGuildLifecycleInTransaction(trx, {
        guildId: params.guildId,
        action: "START_CONFIGURING",
        callerTier: params.callerTier,
        actorUserId: params.actorUserId,
        correlationId: params.correlationId,
      });
    }

    await saveOnboardingSectionData(trx, params.guildId, params.request);

    // Section 7 ("Admin role policy") mirrors into the EXISTING
    // `dashboard_guild_policy` table (migration 0004, Step 05) — reusing
    // `setGuildAdminRole` rather than inventing a parallel store for the
    // same fact. Disclosed interpretation (00_GLOBAL_IMPLEMENTATION_RULES.md
    // rule 1): `guildPolicyRepo.ts`'s own header comment reserves
    // `PUT /api/guilds/:guildId/admin-policy/role` for Step 12's standalone
    // post-onboarding editing route — this onboarding save uses the SAME
    // underlying repo function through the onboarding-specific endpoint,
    // which is a distinct route serving a distinct (first-time setup) UX,
    // not a duplicate of Step 12's future route.
    if (params.request.section === "adminRolePolicy") {
      await setGuildAdminRole(trx, params.guildId, params.request.data.adminRoleDiscordId);
    }
  });

  return buildResponse(db, params.guildId);
}
