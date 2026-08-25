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
      data: z
        .object({
          // Category quota keys, this step's minimal shape (real quota
          // editing UI/bounds are 11_GUILD_CONFIGURATION.md/Step 13's scope
          // — this step only needs "at least one category" to satisfy the
          // activation checklist, SCREENS/ONBOARDING.md's own documented
          // minimum).
          categories: z.array(z.string().min(1).max(64)).min(0).max(32),
          acceptPlatformDefaults: z.boolean(),
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
    /** Server-side re-derivation of SCREENS/ONBOARDING.md's minimum checklist (incoming channel, hero channel, at least one quota category) — the ONLY value the "Request activation" button's enabled state may trust; the client's own tally is presentation only. */
    minimumChecklistPassed: z.boolean(),
    latestRequest: latestActivationRequestSummarySchema,
    values: z
      .object({
        incomingChannelId: discordSnowflakeSchema.nullable(),
        heroChannelId: discordSnowflakeSchema.nullable(),
        communityChannelId: discordSnowflakeSchema.nullable(),
        seasonQuotaCategories: z.array(z.string()),
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

/** `POST /api/guilds/:guildId/{pause,resume}` and the Superadmin-only `POST /api/admin/guilds/:guildId/{suspend,lift-suspension}`. */
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
