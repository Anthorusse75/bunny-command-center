export { buildAuthRoutes } from "./routes.js";
export {
  buildRequireAuth,
  createSessionCookieRenewalHook,
  requireCsrfHeader,
  resolveAuthenticatedUser,
  type AuthenticatedUser,
  type PendingSessionRenewal,
} from "./requireAuth.js";
export { startSessionSweep, type SessionSweepHandle } from "./sessionSweep.js";
export { sweepExpiredSessions } from "./sessionRepo.js";
export { OAuthTransactionRegistry } from "./oauthTransactionRegistry.js";
export { startOAuthTransactionSweep, type OAuthTransactionSweepHandle } from "./oauthTransactionSweep.js";

// --- Step 05: RBAC (Superadmin, Guild Admin Resolution, IDOR middleware) ---
export { isSuperadmin, type SuperadminConfig } from "./superadmin.js";
export { isSyntacticallyValidSnowflake, snowflakeEquals } from "./snowflake.js";
export {
  fetchUserGuilds,
  fetchGuildMember,
  hasAdministratorPermission,
  isDiscordUnauthorized,
  DiscordGuildFetchError,
  type DiscordGuildSummary,
  type DiscordGuildMember,
} from "./discordGuildClient.js";
export { DiscordTokenService, DiscordReauthRequiredError } from "./discordTokenService.js";
export {
  GuildAuthCache,
  guildsListCacheKey,
  guildMemberCacheKey,
  type GuildAuthCacheKey,
  type GuildAuthCacheSource,
} from "./guildAuthCache.js";
export { getGuildPolicy, setGuildAdminRole, type DashboardGuildPolicyRow } from "./guildPolicyRepo.js";
export { getAdminOverride, setAdminOverride, type DashboardAdminOverrideRow } from "./adminOverrideRepo.js";
export {
  assertGuildMembership,
  resolveGuildAuthorization,
  getCallerGuildsForListing,
  isGuildAdminCapableAnywhere,
  createGuildAuthDeps,
  GUILD_TIER_RANK,
  type GuildTier,
  type GuildAuthDeps,
  type AuthorizedCaller,
  type AuthorizationFreshness,
} from "./guildAuthorization.js";
export {
  buildRequireTier,
  respondReauthRequired,
  type ResolvedGuildAuthorization,
  type RequireTierOptions,
} from "./tier.js";
