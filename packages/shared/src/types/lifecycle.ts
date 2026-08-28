// Step 10 (IMPLEMENTATION/10_onboarding_approval.md, DASHBOARD/10_GUILD_ONBOARDING_AND_APPROVAL.md)
// shared request/response shapes for the guild lifecycle state machine,
// onboarding stepper, and snapshot-based approval workflow — the single
// source of truth `apps/api` validates against and `apps/web` consumes
// (same convention as `./guilds.js`).
import { z } from "zod";
import { discordSnowflakeSchema } from "./guilds.js";

/** Mirrors `apps/api/src/lifecycle/stateMachine.ts`'s `LIFECYCLE_STATES`. */
export const lifecycleStateSchema = z.enum([
  "DISCOVERED",
  "CONFIGURING",
  "PENDING_APPROVAL",
  "CHANGES_REQUESTED",
  "ACTIVE",
  "USER_PAUSED",
  "PLATFORM_SUSPENDED",
  "REJECTED",
]);
export type LifecycleStateDto = z.infer<typeof lifecycleStateSchema>;

/** The 7 onboarding sections, SCREENS/ONBOARDING.md's own numbered list (§8 "Review & request activation" is the stepper's own summary view, not a savable section). */
export const ONBOARDING_SECTION_KEYS = [
  "bunnyPermissions",
  "incomingChannel",
  "heroChannel",
  "communityChannel",
  "seasonQuotas",
  "notifications",
  "adminRolePolicy",
] as const;
export const onboardingSectionKeySchema = z.enum(ONBOARDING_SECTION_KEYS);
export type OnboardingSectionKey = z.infer<typeof onboardingSectionKeySchema>;

/**
 * Per-section save payload — a discriminated union so an invalid
 * section/data pairing is rejected by Zod itself, never by ad hoc
 * `if (section === ...)` branching deep in a route handler.
 *
 * `bunnyPermissions` is deliberately ABSENT from this union — Step 10
 * FINAL external-review correction, Section 4. It remains one of the 7
 * `ONBOARDING_SECTION_KEYS` display/checklist keys (the UI still shows it
 * as a section with a completion state), but it is no longer a
 * user-savable section at all: an earlier pass modeled it as a manual
 * `{acknowledged: boolean}` attestation checkbox, which was replaced by a
 * LIVE, client-derived completion check computed from a server-PROXIED
 * Bunny channel catalog (`GET /api/guilds/:guildId/onboarding/channels`
 * relays Bunny's real permission bits; `apps/web/src/screens/OnboardingScreen.tsx`'s
 * `computeBunnyPermissionsStatus` derives the pass/fail check from that data
 * client-side — the API itself does not compute a "completed" verdict for
 * this section) — there is no longer anything for a
 * client to "save" here. The branch was removed entirely (not merely
 * unused) so a `PATCH .../onboarding` with `{section: "bunnyPermissions", ...}`
 * now fails Zod validation outright, per the explicit instruction "there
 * must no longer be two contradictory meanings of 'bunnyPermissions
 * completed'": the live, derived check is the ONLY canonical completion
 * signal — this section's own `dashboard_guild_onboarding_progress` status
 * is intentionally never authoritative and is not writable.
 */
export const onboardingSectionSaveSchema = z.discriminatedUnion("section", [
  z
    .object({
      section: z.literal("incomingChannel"),
      data: z.object({ channelId: discordSnowflakeSchema }).strict(),
    })
    .strict(),
  z
    .object({
      section: z.literal("heroChannel"),
      data: z.object({ channelId: discordSnowflakeSchema }).strict(),
    })
    .strict(),
  z
    .object({
      section: z.literal("communityChannel"),
      data: z.object({ channelId: discordSnowflakeSchema.nullable() }).strict(),
    })
    .strict(),
  z
    .object({
      section: z.literal("seasonQuotas"),
      // Step 10 external-review correction round, Section 9: REPLACES the
      // prior fake category-string model (which had no numeric value at
      // all and could never actually express a real quota) with the real
      // 5-numeric-value model matching `guild_config_selfbot`'s real
      // `nb_gc_hero`/`nb_gc_titan`/`nb_hol`/`nb_hero`/`nb_titan` columns
      // (confirmed-live canonical defaults: 912/380/600/1200/600).
      // Effective quota = the canonical default + any explicit override in
      // `quotaOverrides`. If `acceptPlatformDefaults` is `false`, the
      // server requires at least one explicit override (rejects the save
      // otherwise, apps/api's `onboardingService.ts`) — there is no
      // meaningful "reject all defaults, override nothing" state.
      data: z
        .object({
          acceptPlatformDefaults: z.boolean(),
          quotaOverrides: z
            .object({
              gcHero: z.number().int().min(0).max(1_000_000).optional(),
              gcTitan: z.number().int().min(0).max(1_000_000).optional(),
              hol: z.number().int().min(0).max(1_000_000).optional(),
              hero: z.number().int().min(0).max(1_000_000).optional(),
              titan: z.number().int().min(0).max(1_000_000).optional(),
            })
            .strict(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      section: z.literal("notifications"),
      data: z
        .object({
          inAppEnabled: z.boolean(),
          discordDmEnabled: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      section: z.literal("adminRolePolicy"),
      data: z.object({ adminRoleDiscordId: discordSnowflakeSchema.nullable() }).strict(),
    })
    .strict(),
]);
export type OnboardingSectionSaveRequest = z.infer<typeof onboardingSectionSaveSchema>;

export const onboardingSectionStatusSchema = z
  .object({
    completed: z.boolean(),
    completedAt: z.string().nullable(),
  })
  .strict();

export const activationRequestStateSchema = z.enum(["PENDING", "CHANGES_REQUESTED", "APPROVED", "REJECTED"]);
export type ActivationRequestState = z.infer<typeof activationRequestStateSchema>;

/**
 * The guild's most recent activation-request decision, surfaced to the
 * Guild Admin via `GET/PATCH /api/guilds/:guildId/onboarding` (the Guild
 * Admin has no `SUPERADMIN`-tier access to `GET /api/admin/activation-requests/:requestId`,
 * so this is the only path the Superadmin's reason can reach their screen —
 * SCREENS/ONBOARDING.md §Rejected / Changes requested: "the Superadmin's
 * reason surfaced prominently"). `null` iff the guild has never submitted a
 * request at all.
 */
export const latestActivationRequestSummarySchema = z
  .object({
    requestId: z.string(),
    state: activationRequestStateSchema,
    decisionReason: z.string().nullable(),
  })
  .strict()
  .nullable();

export const onboardingStateResponseSchema = z
  .object({
    guildId: discordSnowflakeSchema,
    lifecycleState: lifecycleStateSchema,
    sections: z.record(onboardingSectionKeySchema, onboardingSectionStatusSchema),
    /** Server-side re-derivation of SCREENS/ONBOARDING.md's minimum checklist (incoming channel, hero channel, season & quotas section saved) — the ONLY value the "Request activation" button's enabled state may trust; the client's own tally is presentation only. */
    minimumChecklistPassed: z.boolean(),
    latestRequest: latestActivationRequestSummarySchema,
    values: z
      .object({
        incomingChannelId: discordSnowflakeSchema.nullable(),
        heroChannelId: discordSnowflakeSchema.nullable(),
        communityChannelId: discordSnowflakeSchema.nullable(),
        // Step 10 external-review correction round, Section 9: replaces
        // the fake `seasonQuotaCategories: string[]` field with the real
        // numeric shape.
        seasonQuotaAcceptPlatformDefaults: z.boolean(),
        seasonQuotaOverrides: z
          .object({
            gcHero: z.number().int().optional(),
            gcTitan: z.number().int().optional(),
            hol: z.number().int().optional(),
            hero: z.number().int().optional(),
            titan: z.number().int().optional(),
          })
          .strict(),
        notificationsInAppEnabled: z.boolean().nullable(),
        notificationsDiscordDmEnabled: z.boolean().nullable(),
        adminRoleDiscordId: discordSnowflakeSchema.nullable(),
      })
      .strict(),
  })
  .strict();
export type OnboardingStateResponse = z.infer<typeof onboardingStateResponseSchema>;

/** `POST /api/guilds/:guildId/request-activation` — empty body, everything server-derived. */
export const requestActivationResponseSchema = z
  .object({ requestId: z.string(), lifecycleState: lifecycleStateSchema })
  .strict();
export type RequestActivationResponse = z.infer<typeof requestActivationResponseSchema>;

/** `POST /api/guilds/:guildId/{pause,resume}` and the Superadmin-only `POST /api/admin/platform/guilds/:guildId/{suspend,unsuspend}`. */
export const lifecycleTransitionResponseSchema = z
  .object({
    guildId: discordSnowflakeSchema,
    previousState: lifecycleStateSchema,
    lifecycleState: lifecycleStateSchema,
  })
  .strict();
export type LifecycleTransitionResponse = z.infer<typeof lifecycleTransitionResponseSchema>;

/** `:requestId` route-param shape for the activation-request review endpoints (CHAR26 ULID, same shape as `apps/api/src/notifications/id.ts`'s ids). */
export const activationRequestIdParamSchema = z
  .object({
    requestId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "must be a syntactically valid CHAR26 id"),
  })
  .strict();
export type ActivationRequestIdParam = z.infer<typeof activationRequestIdParamSchema>;

export const requestChangesRequestSchema = z.object({ reason: z.string().min(1).max(2000) }).strict();
export const rejectActivationRequestSchema = z.object({ reason: z.string().min(1).max(2000) }).strict();

/**
 * The 5 real effective quota values (`guild_config_selfbot.nb_*`), same
 * shape as `OnboardingStateResponse.values.seasonQuotaOverrides` but always
 * fully populated (default-filled), never partial — see
 * `apps/api/src/lifecycle/seasonQuotas.ts#EffectiveQuotas`.
 */
export const effectiveQuotasSchema = z
  .object({
    gcHero: z.number().int(),
    gcTitan: z.number().int(),
    hol: z.number().int(),
    hero: z.number().int(),
    titan: z.number().int(),
  })
  .strict();
export type EffectiveQuotasResponse = z.infer<typeof effectiveQuotasSchema>;

/**
 * The frozen, checksummed portion of `submittedConfigVersionId`'s
 * materialized configuration — incoming/Hero/community channel + the 5
 * effective quotas, per `getMaterializedConfigSnapshot`'s exact scope (see
 * that function's doc comment for what is and is not included and why).
 * `null` only if the referenced version row is unexpectedly missing — the
 * review screen must show "snapshot unavailable" for that, never fabricate
 * zeros/blanks.
 */
export const materializedConfigSnapshotSchema = z
  .object({
    incomingChannelId: discordSnowflakeSchema.nullable(),
    heroChannelId: discordSnowflakeSchema.nullable(),
    communityChannelId: discordSnowflakeSchema.nullable(),
    quotas: effectiveQuotasSchema,
  })
  .strict()
  .nullable();

/** The frozen snapshot a Superadmin reviews — `GET /api/admin/activation-requests/:requestId`. */
export const activationRequestDetailResponseSchema = z
  .object({
    requestId: z.string(),
    guildId: discordSnowflakeSchema,
    submittedConfigVersionId: z.number(),
    requestedBy: discordSnowflakeSchema,
    requestedAt: z.string(),
    state: activationRequestStateSchema,
    reviewedBy: discordSnowflakeSchema.nullable(),
    reviewedAt: z.string().nullable(),
    decisionReason: z.string().nullable(),
    // NOT the ENTIRE materialized version — only the frozen fields this
    // review screen actually needs (see materializedConfigSnapshotSchema).
    // Live, never-frozen-by-this-checksum concerns (admin-role policy, live
    // notification-defaults, live Bunny-permission status) are deliberately
    // absent from this response — the review screen must source those, if
    // at all, from elsewhere and present them as visually/structurally
    // separate from this snapshot.
    configSnapshot: materializedConfigSnapshotSchema,
  })
  .strict();
export type ActivationRequestDetailResponse = z.infer<typeof activationRequestDetailResponseSchema>;

/**
 * `POST /api/admin/activation-requests/:requestId/{approve,reject,request-changes}`
 * — matches `activationRequestsService.ts`'s `DecisionResult` exactly
 * (`{ requestId, lifecycleState }`). `lifecycleState` is `null` for
 * reject/request-changes (those decisions do not change the GUILD's
 * lifecycle state, only the request's own `state`) and the guild's new
 * state (typically `ACTIVE`) for approve.
 */
export const activationDecisionResponseSchema = z
  .object({
    requestId: z.string(),
    lifecycleState: lifecycleStateSchema.nullable(),
  })
  .strict();
export type ActivationDecisionResponse = z.infer<typeof activationDecisionResponseSchema>;

/**
 * Step 10 correction round, Gap 2 — `GET /api/guilds/:guildId/onboarding/channels`,
 * proxying Bunny OCR's real `GET /internal/guilds/{guild_id}/channels`
 * (`apps/api/src/integrations/bunnyInternalApi.ts`). `available: false`
 * covers EVERY "couldn't get a real answer from Bunny" outcome
 * (misconfigured, unreachable, non-200, malformed body, Bunny not in the
 * guild) — deliberately collapsed into one flag rather than a granular
 * error enum, because the onboarding channel pickers only ever need to
 * distinguish "here is a real list" from "show a degraded/disabled picker,
 * do not block the rest of the page" (this step's brief: "never silently
 * treat 'can't reach Bunny' as 'channel doesn't exist' in a way that blocks
 * all onboarding"). `channels` is always `[]` when `available` is `false`.
 */
export const onboardingChannelDtoSchema = z
  .object({
    id: discordSnowflakeSchema,
    name: z.string(),
    position: z.number(),
    type: z.string(),
    canReadHistory: z.boolean(),
    // Step 10 external-review Phase 2, Section 12: VIEW_CHANNEL and
    // SEND_MESSAGES, alongside the pre-existing READ_MESSAGE_HISTORY —
    // backs the "Bunny & permissions" live checklist (derived from these
    // real facts at read time, never a stored attestation).
    canViewChannel: z.boolean(),
    canSendMessages: z.boolean(),
  })
  .strict();
export type OnboardingChannelDto = z.infer<typeof onboardingChannelDtoSchema>;

export const onboardingChannelCatalogResponseSchema = z
  .object({
    available: z.boolean(),
    channels: z.array(onboardingChannelDtoSchema),
  })
  .strict();
export type OnboardingChannelCatalogResponse = z.infer<typeof onboardingChannelCatalogResponseSchema>;

/**
 * Step 10 external-review Phase 2, Section 13 — `GET
 * /api/guilds/:guildId/onboarding/roles`, proxying Bunny's real, already-
 * merged `GET /internal/guilds/{guild_id}/roles` (Step 08, Workstream E;
 * `apps/api/src/integrations/bunnyInternalApi.ts`'s `fetchGuildRoleCatalog`).
 * Same `available: false` degradation convention as the channel catalog
 * above — the Admin Role Policy dropdown degrades gracefully rather than
 * blocking the rest of onboarding when Bunny is unreachable.
 */
export const onboardingRoleDtoSchema = z
  .object({
    id: discordSnowflakeSchema,
    name: z.string(),
    color: z.number(),
    position: z.number(),
    managed: z.boolean(),
    mentionable: z.boolean(),
    hoist: z.boolean(),
  })
  .strict();
export type OnboardingRoleDto = z.infer<typeof onboardingRoleDtoSchema>;

export const onboardingRoleCatalogResponseSchema = z
  .object({
    available: z.boolean(),
    roles: z.array(onboardingRoleDtoSchema),
  })
  .strict();
export type OnboardingRoleCatalogResponse = z.infer<typeof onboardingRoleCatalogResponseSchema>;
