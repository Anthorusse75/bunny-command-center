// Step 06's canonical shared request/response shapes for the multi-guild
// model (24_API_CONTRACTS.md: "validated by Zod schemas in packages/shared",
// ADR-014).
//
// EXTERNAL REVIEW CORRECTION (Step 06 correction pass): at first push,
// `packages/shared/src/types/index.ts` was still the Step-01 placeholder
// (`export {}`) and `apps/web/src/features/guilds/types.ts` hand-duplicated
// its own plain TS interfaces instead — which had already drifted from what
// `apps/api` actually returns: `postFavorite()`/`patchHomeVisibility()`
// claimed `Promise<GuildListEntry>`, but the real backend
// (`apps/api/src/guilds/routes.ts`) returns the narrower preference-row
// shape (`GuildPreferenceResponse` below). This file is now the single
// source of truth on both sides — `apps/api` uses these schemas to validate
// inbound params/bodies, `apps/web` uses the inferred types instead of a
// second, independently-maintained copy.
//
// Snowflake shape duplicated from `apps/api/src/auth/snowflake.ts`'s own
// `SNOWFLAKE_PATTERN` (`/^\d{15,20}$/`) rather than imported —
// `packages/shared` must never depend on `apps/api` (wrong dependency
// direction: shared is consumed BY both apps, never the reverse), and that
// module is Step 04/05's own auth-specific zone, out of this correction's
// scope. Same invariant, same digits-only/15-20-length contract, same
// "never Number()/parseInt()/unary + a Discord ID" discipline as everywhere
// else in this codebase.
import { z } from "zod";

export const discordSnowflakeSchema = z
  .string()
  .regex(/^\d{15,20}$/, "must be a syntactically valid Discord snowflake (15-20 digits)");

/** `:guildId` route param shape for every Step-06 guild-scoped route. */
export const guildIdParamSchema = z.object({ guildId: discordSnowflakeSchema }).strict();
export type GuildIdParam = z.infer<typeof guildIdParamSchema>;

/** `POST /api/users/me/guilds/:guildId/favorite` request body. */
export const favoriteRequestSchema = z.object({ isFavorite: z.boolean() }).strict();
export type FavoriteRequest = z.infer<typeof favoriteRequestSchema>;

/** `PATCH /api/users/me/guilds/:guildId/home-visibility` request body. */
export const homeVisibilityRequestSchema = z.object({ homeVisible: z.boolean() }).strict();
export type HomeVisibilityRequest = z.infer<typeof homeVisibilityRequestSchema>;

/**
 * Mirrors `apps/api/src/guilds/guildPreferencesRepo.ts`'s `GuildPreferenceRow`,
 * JSON-serialized (`Date` -> ISO string over the wire) — the REAL response
 * shape of `POST .../favorite` and `PATCH .../home-visibility`. Deliberately
 * NOT `GuildListEntry` (see this file's header comment on the drift this
 * corrects).
 */
export const guildPreferenceResponseSchema = z
  .object({
    guildId: discordSnowflakeSchema,
    isFavorite: z.boolean(),
    favoritedAt: z.string().nullable(),
    homeVisible: z.boolean(),
    lastUsedAt: z.string().nullable(),
  })
  .strict();
export type GuildPreferenceResponse = z.infer<typeof guildPreferenceResponseSchema>;

/** Mirrors `apps/api/src/guilds/guildsService.ts`'s `GuildListEntry` — one row in `GET /api/users/me/guilds`'s `guilds`/`inviteEligibleGuilds` arrays. */
export const guildListEntrySchema = z
  .object({
    guildId: discordSnowflakeSchema,
    name: z.string().nullable(),
    icon: z.string().nullable(),
    botPresent: z.boolean(),
    enabled: z.boolean().nullable(),
    isOwner: z.boolean(),
    canAdminister: z.boolean(),
    isFavorite: z.boolean(),
    favoritedAt: z.string().nullable(),
    homeVisible: z.boolean(),
    lastUsedAt: z.string().nullable(),
  })
  .strict();
export type GuildListEntry = z.infer<typeof guildListEntrySchema>;

export const guildListResponseSchema = z
  .object({
    guilds: z.array(guildListEntrySchema),
    inviteEligibleGuilds: z.array(guildListEntrySchema),
    canInviteBunnyAnywhere: z.boolean(),
    inviteUrl: z.string(),
  })
  .strict();
export type GuildListResponse = z.infer<typeof guildListResponseSchema>;

/** `08_AUTHORIZATION_AND_RBAC.md`'s three tiers — mirrors `apps/api/src/auth/guildAuthorization.ts`'s `GuildTier`. */
export const guildTierSchema = z.enum(["USER", "GUILD_ADMIN", "SUPERADMIN"]);
export type GuildTier = z.infer<typeof guildTierSchema>;

/** Mirrors `apps/api/src/guilds/routes.ts`'s `GET /api/guilds/:guildId` response. */
export const guildOverviewResponseSchema = z
  .object({
    guildId: discordSnowflakeSchema,
    tier: guildTierSchema,
    botPresent: z.boolean(),
    enabled: z.boolean().nullable(),
    displayName: z.string().nullable(),
  })
  .strict();
export type GuildOverview = z.infer<typeof guildOverviewResponseSchema>;
