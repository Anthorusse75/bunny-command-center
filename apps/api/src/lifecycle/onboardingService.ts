/**
 * Onboarding stepper service (Step 10). `GET/PATCH /api/guilds/:guildId/onboarding`
 * (routes.ts) call exactly these two functions — no route touches
 * `onboardingRepo.ts`/`lifecycleService.ts` directly.
 */
import type { Kysely } from "kysely";
import type { DB } from "../db/codegen-types.js";
import type { OnboardingSectionSaveRequest, OnboardingStateResponse } from "@bunny-command-center/shared";
import type { AppConfig } from "../config.js";
import { fetchGuildChannelCatalog } from "../integrations/bunnyInternalApi.js";
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
    public readonly code:
      "GUILD_NOT_FOUND" | "NOT_EDITABLE" | "CHANNEL_VERIFICATION_FAILED" | "CHANNEL_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "OnboardingRejectedError";
  }
}

/**
 * Step 10 correction round, Gap 2 (`11_GUILD_CONFIGURATION.md`'s explicit
 * audit-gap closure: "never silently accept an unverified channel id"). The
 * three channel-selecting sections get a LIVE existence check against
 * Bunny's real channel catalog before their save is accepted — this was
 * flagged as a known gap in the prior pass and explicitly required to be
 * closed in this one. Called BEFORE `saveOnboardingSection`'s DB transaction
 * opens (an outbound HTTP call must never happen while holding a MySQL
 * transaction/row locks open). Bunny-unreachable (or any other non-success
 * outcome) fails the save CLOSED — never a silent accept of an unverified id
 * — per this step's explicit brief: "Bunny-unreachable during a save must
 * fail the save closed with a clear 'couldn't verify channel, try again'
 * error."
 */
const CHANNEL_SECTIONS = new Set(["incomingChannel", "heroChannel", "communityChannel"]);

async function verifyChannelExistsOrThrow(
  config: AppConfig,
  guildId: string,
  channelId: string,
): Promise<void> {
  const result = await fetchGuildChannelCatalog(config, guildId);
  if (!result.ok) {
    throw new OnboardingRejectedError(
      "CHANNEL_VERIFICATION_FAILED",
      `onboarding: could not verify channel ${channelId} against Bunny's live catalog for guild ${guildId} (${result.reason}) — refusing to accept an unverified channel id`,
    );
  }
  if (!result.channels.some((c) => c.id === channelId)) {
    throw new OnboardingRejectedError(
      "CHANNEL_NOT_FOUND",
      `onboarding: channel ${channelId} does not exist in guild ${guildId}'s live Bunny channel catalog`,
    );
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
  config: AppConfig,
  params: {
    readonly guildId: string;
    readonly actorUserId: number;
    readonly actorDiscordId: string;
    readonly callerTier: GuildTier;
    readonly correlationId: string | null;
    readonly request: OnboardingSectionSaveRequest;
  },
): Promise<OnboardingStateResponse> {
  // Step 10 correction round, Gap 2: live channel-existence check BEFORE the
  // transaction below even opens (an outbound HTTP call to Bunny must never
  // happen while holding a MySQL transaction open). `communityChannel`'s
  // `channelId` is nullable (optional section) — `null` skips the check
  // entirely, matching the existing "clear the community channel" save path.
  if (CHANNEL_SECTIONS.has(params.request.section)) {
    const channelId = (params.request.data as { channelId: string | null }).channelId;
    if (channelId !== null) {
      await verifyChannelExistsOrThrow(config, params.guildId, channelId);
    }
  }

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
