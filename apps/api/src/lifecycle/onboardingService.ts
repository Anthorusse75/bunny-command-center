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
  getOnboardingProgressOrEmpty,
  isVersionImmutable,
  materializeDraftConfigVersion,
  minimumChecklistPassed,
  saveOnboardingSectionData,
  sectionStatuses,
  ConfigVersionRaceError,
} from "./onboardingRepo.js";
import { getLatestActivationRequestForGuild } from "./activationRequestsRepo.js";
import { setGuildAdminRole } from "../auth/guildPolicyRepo.js";
import { setGuildNotificationDefault } from "../notifications/repo.js";
import { materializeSeasonPlanForOpenSeasonIfAny } from "./seasonPlansRepo.js";
import { hasAnyQuotaOverride } from "./seasonQuotas.js";
import type { GuildTier } from "../auth/guildAuthorization.js";
import { lifecyclePermissionsFor } from "./permissionPolicy.js";

export class OnboardingRejectedError extends Error {
  constructor(
    public readonly code:
      | "GUILD_NOT_FOUND"
      | "NOT_EDITABLE"
      | "CHANNEL_VERIFICATION_FAILED"
      | "CHANNEL_NOT_FOUND"
      | "QUOTA_OVERRIDE_REQUIRED"
      | "CONCURRENT_MODIFICATION",
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

// Step 10 external-review correction round, Section 14: this used to be its
// own ad-hoc `NON_EDITABLE_STATES` set, hand-maintained separately from the
// canonical per-state permission matrix (`permissionPolicy.ts`) — now a
// direct call into that single source of truth instead
// (`10_GUILD_ONBOARDING_AND_APPROVAL.md`'s per-state permission matrix:
// config stays editable in every state except `PLATFORM_SUSPENDED`,
// "read-only").

/**
 * Step 10 external-review correction round, Section 8: uses the TRUE
 * read-only `getOnboardingProgressOrEmpty` (never `ensureOnboardingProgressRow`,
 * which INSERTs) — this function backs BOTH `GET /api/guilds/:guildId/onboarding`
 * (`getOnboardingState` below, where a mutating read would be a genuine
 * "GET never mutates" violation) AND the response `saveOnboardingSection`
 * builds AFTER its own mutation has already committed (where the row is
 * guaranteed to already exist, so reading it read-only changes nothing).
 */
async function buildResponse(db: Kysely<DB>, guildId: string): Promise<OnboardingStateResponse> {
  const [guildRow, progress, latestRequest] = await Promise.all([
    getGuildLifecycleRow(db, guildId),
    getOnboardingProgressOrEmpty(db, guildId),
    getLatestActivationRequestForGuild(db, guildId),
  ]);
  if (!guildRow) {
    throw new OnboardingRejectedError("GUILD_NOT_FOUND", `onboarding: no guilds row for ${guildId}`);
  }
  const incoming = progress.sections.incomingChannel?.data as { channelId?: string } | undefined;
  const hero = progress.sections.heroChannel?.data as { channelId?: string } | undefined;
  const community = progress.sections.communityChannel?.data as { channelId?: string | null } | undefined;
  const quotas = progress.sections.seasonQuotas?.data as
    { acceptPlatformDefaults?: boolean; quotaOverrides?: Record<string, number> } | undefined;
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
      seasonQuotaAcceptPlatformDefaults: quotas?.acceptPlatformDefaults ?? false,
      seasonQuotaOverrides: quotas?.quotaOverrides ?? {},
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

  // Step 10 external-review correction round, Section 9: server-side
  // re-validation of the "acceptPlatformDefaults=false requires at least
  // one explicit override" rule — never trust a client-only check. Pure
  // validation, no DB needed, so it runs before the transaction opens
  // (same discipline as the channel-verification check above).
  if (params.request.section === "seasonQuotas") {
    const data = params.request.data;
    if (!data.acceptPlatformDefaults && !hasAnyQuotaOverride(data)) {
      throw new OnboardingRejectedError(
        "QUOTA_OVERRIDE_REQUIRED",
        "onboarding: seasonQuotas.acceptPlatformDefaults=false requires at least one explicit quotaOverrides entry",
      );
    }
  }

  try {
    await db.transaction().execute(async (trx) => {
      const guildRow = await getGuildLifecycleRow(trx, params.guildId);
      if (!guildRow) {
        throw new OnboardingRejectedError(
          "GUILD_NOT_FOUND",
          `onboarding: no guilds row for ${params.guildId}`,
        );
      }
      if (!lifecyclePermissionsFor(guildRow.lifecycleState).configEditable) {
        throw new OnboardingRejectedError(
          "NOT_EDITABLE",
          `onboarding: guild ${params.guildId} is ${guildRow.lifecycleState} (read-only)`,
        );
      }

      // Permission matrix: "DISCOVERED: yes (starts CONFIGURING on first edit)".
      if (guildRow.lifecycleState === "DISCOVERED") {
        await transitionGuildLifecycleInTransaction(trx, db, {
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

      // Step 10 external-review correction round, Section 11: the
      // "Notifications" section used to be a dead end — round-tripped
      // through `sections_json` only, with zero real destination and zero
      // effect on `resolvePreference()`. Mirrors into the new
      // `dashboard_guild_notification_defaults` table (same "mirror into a
      // real table alongside the sections_json buffer" pattern as
      // `adminRolePolicy` immediately above) — plain Guild-Admin-tier is
      // correct here (this section is listed as editable in every
      // non-suspended state at the same tier as every other section; the
      // Owner-only requirement is specific to `adminRolePolicy` and must not
      // be over-applied here).
      if (params.request.section === "notifications") {
        await setGuildNotificationDefault(trx, {
          guildId: params.guildId,
          inAppEnabled: params.request.data.inAppEnabled,
          discordDmEnabled: params.request.data.discordDmEnabled,
          updatedBy: params.actorDiscordId,
        });
      }

      // Step 10 external-review correction round, Sections 6/9: "Season &
      // quotas" materializes into the REAL `guild_config_selfbot.nb_*`
      // columns immediately on save — but ONLY once a draft version already
      // exists (i.e. `incomingChannel`/`heroChannel` were already saved in an
      // earlier call, so `guild_config_bunny`/`guild_config_selfbot`'s NOT
      // NULL channel columns can already be validly populated). If no draft
      // version exists yet, the value simply stays in the `sections_json`
      // buffer for now (this section's real destination genuinely is NOT
      // YET determinable) — `materializeDraftConfigVersion`'s own
      // request-activation-time call already re-applies whatever is in the
      // buffer once the checklist requires both channels to be known, so
      // nothing here is ever lost, only deferred exactly as far as the
      // ordering constraint requires. ** Documented scope limitation **: this
      // does NOT generalize immediate materialization to the CHANNEL
      // sections themselves (they still materialize only at
      // request-activation, unchanged) — that broader change was judged too
      // large/risky to make safely within this correction round's remaining
      // scope and is flagged for a follow-up pass.
      if (params.request.section === "seasonQuotas") {
        const progress = await getOnboardingProgressOrEmpty(trx, params.guildId);
        if (progress.draftConfigVersionId !== null) {
          const currentDraftIsImmutable = await isVersionImmutable(trx, progress.draftConfigVersionId);
          const { versionId, effectiveQuotas } = await materializeDraftConfigVersion(trx, {
            guildId: params.guildId,
            authorDiscordId: params.actorDiscordId,
            sections: progress.sections,
            currentDraftVersionId: progress.draftConfigVersionId,
            currentDraftIsImmutable,
          });
          // Separately: an eligible current season, if any, gets its own
          // guild_season_plans row created-or-updated with these same
          // effective values. If NO eligible season exists, this is a
          // deliberate no-op — the nb_* values just materialized above
          // already durably hold the effective quota as this guild's
          // per-guild default, to be consumed whenever a future season plan
          // is created (see `seasonPlansRepo.ts`'s own doc comment and the
          // accompanying regression test proving this exact behavior).
          await materializeSeasonPlanForOpenSeasonIfAny(trx, {
            guildId: params.guildId,
            quotas: effectiveQuotas,
            materializedVersionId: versionId,
          });
        }
      }
    });
  } catch (err) {
    if (err instanceof ConfigVersionRaceError) {
      throw new OnboardingRejectedError("CONCURRENT_MODIFICATION", err.message);
    }
    throw err;
  }

  return buildResponse(db, params.guildId);
}
