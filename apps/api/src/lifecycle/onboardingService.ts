/**
 * Onboarding stepper service (Step 10). `GET/PATCH /api/guilds/:guildId/onboarding`
 * (routes.ts) call exactly these two functions — no route touches
 * `onboardingRepo.ts`/`lifecycleService.ts` directly.
 */
import type { Kysely } from "kysely";
import type { DB } from "../db/codegen-types.js";
import type { OnboardingSectionSaveRequest, OnboardingStateResponse } from "@bunny-command-center/shared";
import type { AppConfig } from "../config.js";
import { fetchGuildChannelCatalog, type BunnyChannel } from "../integrations/bunnyInternalApi.js";
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
  type Executor,
  type OnboardingProgressRow,
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
      | "CHANNEL_PERMISSIONS_MISSING"
      | "QUOTA_OVERRIDE_REQUIRED"
      | "CONCURRENT_MODIFICATION",
    message: string,
  ) {
    super(message);
    this.name = "OnboardingRejectedError";
  }
}

type ChannelSection = "incomingChannel" | "heroChannel" | "communityChannel";

/**
 * Step 10 correction round, Gap 2 (`11_GUILD_CONFIGURATION.md`'s explicit
 * audit-gap closure: "never silently accept an unverified channel id"). The
 * three channel-selecting sections get a LIVE existence check against
 * Bunny's real channel catalog before their save is accepted. Called BEFORE
 * `saveOnboardingSection`'s DB transaction opens (an outbound HTTP call must
 * never happen while holding a MySQL transaction/row locks open).
 * Bunny-unreachable (or any other non-success outcome) fails the save CLOSED
 * — never a silent accept of an unverified id.
 *
 * Step 10 FINAL external-review correction: existence alone is not enough —
 * "Channel save validation must verify the permissions actually required for
 * that field, not merely that an ID exists." The required-permission profile
 * is per-section, grounded in Bunny's REAL current runtime behavior (no
 * speculative requirements):
 *
 *  - `incomingChannel`: Bunny genuinely reads history there for OCR
 *    ingestion AND posts its reminder/Top10 publication into this SAME
 *    channel (`cogs/y_tasks.py`, confirmed by direct code inspection — Bunny
 *    has no separate "community channel" send path today). Requires
 *    `canViewChannel` + `canReadHistory` + `canSendMessages` all `true`.
 *  - `heroChannel`: a Self-bot-only field — Bunny's catalog is merely a
 *    convenient shared channel-id source for it, Bunny itself has no
 *    operational need for any permission there. Existence-only.
 *  - `communityChannel`: `guild_config_selfbot.community_channel_id` exists
 *    in the SHARED schema, but Bunny's live code has ZERO real `.send()`
 *    call targeting it today (verified directly — the "Community" send path
 *    an earlier pass assumed does not exist; Bunny's actual reminder/Top10
 *    posts go to the incoming channel, covered above). Requiring
 *    `canSendMessages` here would be exactly the speculative permission
 *    requirement the correction round explicitly forbids. Existence-only,
 *    unless a real Bunny consumer is found in a future pass — do not
 *    reintroduce this requirement without a fresh, cited source.
 */
const REQUIRED_INCOMING_CHANNEL_PERMISSIONS: ReadonlyArray<{
  readonly key: "canViewChannel" | "canReadHistory" | "canSendMessages";
}> = [{ key: "canViewChannel" }, { key: "canReadHistory" }, { key: "canSendMessages" }];

const CHANNEL_SECTIONS = new Set<ChannelSection>(["incomingChannel", "heroChannel", "communityChannel"]);

async function verifyChannelSaveOrThrow(
  config: AppConfig,
  guildId: string,
  section: ChannelSection,
  channelId: string,
): Promise<void> {
  const result = await fetchGuildChannelCatalog(config, guildId);
  if (!result.ok) {
    throw new OnboardingRejectedError(
      "CHANNEL_VERIFICATION_FAILED",
      `onboarding: could not verify channel ${channelId} against Bunny's live catalog for guild ${guildId} (${result.reason}) — refusing to accept an unverified channel id`,
    );
  }
  const channel: BunnyChannel | undefined = result.channels.find((c) => c.id === channelId);
  if (!channel) {
    throw new OnboardingRejectedError(
      "CHANNEL_NOT_FOUND",
      `onboarding: channel ${channelId} does not exist in guild ${guildId}'s live Bunny channel catalog`,
    );
  }
  if (section === "incomingChannel") {
    const missing = REQUIRED_INCOMING_CHANNEL_PERMISSIONS.filter(({ key }) => !channel[key]).map(
      ({ key }) => key,
    );
    if (missing.length > 0) {
      throw new OnboardingRejectedError(
        "CHANNEL_PERMISSIONS_MISSING",
        `onboarding: channel ${channelId} is missing required Bunny permission(s) for incomingChannel: ${missing.join(", ")}`,
      );
    }
  }
  // heroChannel/communityChannel: existence-only, per this function's own
  // doc comment — no permission bit is required for either today.
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
    },
  };
}

export async function getOnboardingState(db: Kysely<DB>, guildId: string): Promise<OnboardingStateResponse> {
  return buildResponse(db, guildId);
}

/** The 4 sections whose real destination is the SHARED `guild_configuration_versions` + sub-tables (never `dashboard_guild_notification_defaults`/`dashboard_guild_policy`, which are separate, non-versioned mirror-writes handled inline in `saveOnboardingSection` above). */
const VERSIONED_SECTIONS = new Set(["incomingChannel", "heroChannel", "communityChannel", "seasonQuotas"]);

/** Whether both channel columns the DRAFT-materialization readiness gate cares about are known, given a `sections` buffer snapshot (read either before or after a save — see the two call sites below for why each needs its own snapshot). */
function channelsKnown(sections: OnboardingProgressRow["sections"]): {
  readonly incomingKnown: boolean;
  readonly heroKnown: boolean;
} {
  return {
    incomingKnown: Boolean((sections.incomingChannel?.data as { channelId?: string } | undefined)?.channelId),
    heroKnown: Boolean((sections.heroChannel?.data as { channelId?: string } | undefined)?.channelId),
  };
}

/**
 * Step 10 external-review FINAL correction, Section 1: the single shared
 * save-time materialization path every VERSIONED section
 * (incomingChannel/heroChannel/communityChannel/seasonQuotas) feeds — called
 * from inside `saveOnboardingSection`'s transaction, AFTER
 * `saveOnboardingSectionData` has already committed this save's own value
 * into the buffer (read-your-own-writes within the same transaction/
 * connection, so this always sees the just-written value).
 *
 * Readiness gate: a real DRAFT version becomes SQL-materializable the moment
 * BOTH `incomingChannel` and `heroChannel` are known — those are the only
 * versioned NOT NULL channel columns (`guild_config_bunny.incoming_channel_id`,
 * `guild_config_selfbot.herowarbot_channel_id`); `communityChannel` is
 * nullable and `seasonQuotas` already has canonical platform defaults, so
 * neither blocks materialization. Before that point, the buffer remains
 * legitimately transient (this function is a safe, cheap no-op) — this is
 * NOT the same gate as the minimum-checklist gate `request-activation` still
 * separately enforces (incoming + hero + a SAVED seasonQuotas section): a
 * DRAFT can exist and be genuinely valid SQL before the guild is eligible to
 * request activation.
 *
 * Once ready: reuses `materializeDraftConfigVersion` (already handles
 * "create the first version" vs. "rotate onto a new draft if the current one
 * is immutable" vs. "update the existing mutable draft in place" uniformly,
 * and is itself a safe no-op if the freshly computed checksum already
 * matches the current draft's stored one — see its own doc comment) exactly
 * the same way `request-activation`'s own defensive call does. On a normal
 * completed onboarding, request-activation will therefore usually find an
 * already-materialized, byte-identical current DRAFT rather than being the
 * first point where channel/quota data becomes real SQL.
 *
 * Step 10 PRE-PR FINAL correction, Blocker 2: `guild_configuration_versions`
 * (this function's own job, above) and `guild_season_plans` (a separate,
 * non-versioned operational entity — 11_GUILD_CONFIGURATION.md: "editing
 * quotas here writes to guild_season_plans directly") must NOT be conflated.
 * A channel-only edit (Incoming/Hero/Community) is not a quota edit and must
 * never create or mutate a `guild_season_plans` row. The season-plan sync is
 * therefore gated separately, on exactly TWO legitimate cases:
 *   (a) this save's OWN triggering section is `seasonQuotas` — a direct,
 *       real quota edit always syncs, regardless of prior readiness; or
 *   (b) `seasonQuotas` was ALREADY saved into the buffer at some EARLIER
 *       point (before either channel was known, so it never had anywhere
 *       real to go yet) and THIS save is the one that just flipped readiness
 *       from false to true — i.e. a channel arriving completes a
 *       previously-deferred quota save, consumed exactly once, right here.
 * `readinessBefore` must be computed from a snapshot taken BEFORE this
 * save's own `saveOnboardingSectionData` call (see the call site) — by the
 * time this function runs, the buffer already reflects the new value, so
 * "was it ready before THIS specific save" cannot be reconstructed from the
 * post-save snapshot alone. Every other channel edit that arrives once
 * readiness was already true earlier (re-editing Hero, setting Community,
 * etc.) correctly falls through both cases and skips the season-plan sync —
 * the DRAFT still updates/rotates immediately, exactly as before.
 */
async function materializeVersionedOnboardingConfigIfReady(
  db: Executor,
  params: {
    readonly guildId: string;
    readonly authorDiscordId: string;
    readonly triggerSection: string;
    readonly readinessBefore: boolean;
  },
): Promise<void> {
  const progress = await getOnboardingProgressOrEmpty(db, params.guildId);
  const { incomingKnown, heroKnown } = channelsKnown(progress.sections);
  if (!incomingKnown || !heroKnown) {
    return;
  }
  const currentDraftIsImmutable =
    progress.draftConfigVersionId !== null
      ? await isVersionImmutable(db, progress.draftConfigVersionId)
      : false;
  const { versionId, effectiveQuotas } = await materializeDraftConfigVersion(db, {
    guildId: params.guildId,
    authorDiscordId: params.authorDiscordId,
    sections: progress.sections,
    currentDraftVersionId: progress.draftConfigVersionId,
    currentDraftIsImmutable,
  });

  const seasonQuotasAlreadySaved = progress.sections.seasonQuotas !== undefined;
  const isDirectQuotaSave = params.triggerSection === "seasonQuotas";
  const isDeferredQuotaConsumption = seasonQuotasAlreadySaved && !params.readinessBefore;
  if (!isDirectQuotaSave && !isDeferredQuotaConsumption) {
    return;
  }

  // Separately: an eligible current season, if any, gets its own
  // guild_season_plans row created-or-updated with these same effective
  // values. If NO eligible season exists, this is a deliberate no-op — the
  // nb_* values just materialized above already durably hold the effective
  // quota as this guild's per-guild default, to be consumed whenever a
  // future season plan is created.
  await materializeSeasonPlanForOpenSeasonIfAny(db, {
    guildId: params.guildId,
    quotas: effectiveQuotas,
    materializedVersionId: versionId,
  });
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
  // Step 10 correction round, Gap 2 (+ FINAL correction, Section 2): live
  // channel existence + required-permission check BEFORE the transaction
  // below even opens (an outbound HTTP call to Bunny must never happen while
  // holding a MySQL transaction open). `communityChannel`'s `channelId` is
  // nullable (optional section) — `null` skips the check entirely, matching
  // the existing "clear the community channel" save path.
  if (CHANNEL_SECTIONS.has(params.request.section as ChannelSection)) {
    const channelId = (params.request.data as { channelId: string | null }).channelId;
    if (channelId !== null) {
      await verifyChannelSaveOrThrow(
        config,
        params.guildId,
        params.request.section as ChannelSection,
        channelId,
      );
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

      // Step 10 PRE-PR FINAL correction, Blocker 2: captured BEFORE this
      // save's own `saveOnboardingSectionData` call below — the "was the
      // DRAFT already materializable before THIS specific save" snapshot
      // `materializeVersionedOnboardingConfigIfReady` needs to tell "a
      // channel arriving just completed a previously-deferred quota save"
      // apart from "both channels were already known, this is an unrelated
      // edit" (see that function's own doc comment for the full rationale).
      // Only computed for a VERSIONED section — every other section's save
      // never affects channel readiness, so this would be a wasted read.
      let readinessBeforeSave = false;
      if (VERSIONED_SECTIONS.has(params.request.section)) {
        const beforeProgress = await getOnboardingProgressOrEmpty(trx, params.guildId);
        const before = channelsKnown(beforeProgress.sections);
        readinessBeforeSave = before.incomingKnown && before.heroKnown;
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

      // Step 10 external-review FINAL correction, Section 1: ONE central
      // save-time materialization path for every VERSIONED section
      // (incomingChannel/heroChannel/communityChannel/seasonQuotas) — an
      // earlier pass only ran this after a `seasonQuotas` save, leaving
      // channel sections materializing solely at request-activation time
      // (a real, disclosed gap this correction closes). See
      // `materializeVersionedOnboardingConfigIfReady`'s own doc comment for
      // the exact readiness/rotation semantics.
      if (VERSIONED_SECTIONS.has(params.request.section)) {
        await materializeVersionedOnboardingConfigIfReady(trx, {
          guildId: params.guildId,
          authorDiscordId: params.actorDiscordId,
          triggerSection: params.request.section,
          readinessBefore: readinessBeforeSave,
        });
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
