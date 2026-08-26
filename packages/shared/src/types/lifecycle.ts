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
 * `bunnyPermissions` is a user attestation, NOT a live Discord permission
 * check (disclosed deviation, this step's HANDOVER: no bot-token Discord API
 * client exists anywhere in this codebase today — only the OAuth
 * user-token flow, `apps/api/src/auth/discordClient.ts` — building one is
 * judged out of proportion to add silently within this step).
 */
export const onboardingSectionSaveSchema = z.discriminatedUnion("section", [
  z
    .object({
      section: z.literal("bunnyPermissions"),
      data: z.object({ acknowledged: z.boolean() }).strict(),
    })
    .strict(),
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
        bunnyPermissionsAcknowledged: z.boolean(),
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
  })
  .strict();
export type ActivationRequestDetailResponse = z.infer<typeof activationRequestDetailResponseSchema>;

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
