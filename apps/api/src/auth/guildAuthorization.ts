/**
 * `assertGuildMembership` + Guild Admin Resolution (08_AUTHORIZATION_AND_RBAC.md,
 * ADR-006, ADR-007, ADR-004 corrected 2026-08-11 second pass). This is the
 * ONE implementation of both algorithms -- `tier.ts`'s `requireTier` is the
 * only caller in the real request path; no route may re-derive either check
 * itself (IDOR checklist item 2/3).
 *
 * === Documented deviation from the literal 08_AUTHORIZATION_AND_RBAC.md
 * flowchart, operator-resolved (see this step's HANDOVER) ===
 * That document's flowchart has a "RoleValid" branch that, in the rare case
 * where the caller's held-role-ID doesn't match the Dashboard's last-known
 * configured role, consults Bunny OCR's role-catalog endpoint to distinguish
 * "the role was deleted" from "the caller simply doesn't hold it" before
 * applying the fail-safe. `IMPLEMENTATION/README.md`'s LATER, second-pass
 * correction ("Step 05 (RBAC) -> Step 08: no dependency at all, hard or
 * soft") directly contradicts that: it explicitly states Guild Admin
 * Resolution for the current user has ZERO dependency on Bunny OCR, full
 * stop. The operator directing this implementation resolved that
 * contradiction in favor of the LATER correction: this module makes NO
 * Bunny OCR call, ever, in any branch. When the configured role is not
 * found in the caller's live `roles` array, this fails closed to USER
 * WITHOUT attempting to distinguish "role deleted" from "role not held" --
 * both states are indistinguishable here and both deny identically, per the
 * operator's explicit instruction: "Step 05 does not need the complete
 * guild role catalog merely to avoid granting access." The role-catalog /
 * reconfiguration-diagnostic UX remains Step 12's concern.
 */
import type { Kysely } from "kysely";
import type { DB } from "../db/codegen-types.js";
import type { AppConfig } from "../config.js";
import { isSuperadmin } from "./superadmin.js";
import {
  fetchUserGuilds,
  fetchGuildMember,
  hasAdministratorPermission,
  type DiscordGuildSummary,
} from "./discordGuildClient.js";
import { GuildAuthCache, guildsListCacheKey, guildMemberCacheKey } from "./guildAuthCache.js";
import { DiscordTokenService } from "./discordTokenService.js";
import { getGuildPolicy } from "./guildPolicyRepo.js";
import { getAdminOverride } from "./adminOverrideRepo.js";

export type GuildTier = "USER" | "GUILD_ADMIN" | "SUPERADMIN";

/**
 * 08_AUTHORIZATION_AND_RBAC.md §Permission freshness (D-070, mission §70):
 * "Every **sensitive mutation** ... re-resolves the caller's tier **at
 * request time**, never from a value cached in the session or trusted from
 * the client. Every **read** of admin-gated data also re-resolves, subject
 * only to the 60s micro-cache already described."
 *
 * `"READ"` (the default -- every existing call site's prior, unparameterized
 * behavior is unchanged) may be served from the 60s `GuildAuthCache` within
 * its TTL. `"SENSITIVE_MUTATION"` NEVER reads a cached decision -- it always
 * performs a live Discord fetch (still governed by `DiscordTokenService`'s
 * refresh lifecycle) before resolving. The fresh result is still WRITTEN
 * back into the cache afterward (a mutation's fresh read is exactly as valid
 * as any other fresh read for the next 60s) -- only the READ side of the
 * cache is ever skipped, never the write side, so a mutation never makes the
 * cache less accurate for a subsequent read.
 *
 * This is the ONE sanctioned freshness control for the RBAC path -- Steps
 * 10/12's sensitive-mutation routes (guild config write, pause/resume,
 * approval decision, admin role policy change, override toggle, any
 * `operator_commands` enqueue) MUST pass `freshness: "SENSITIVE_MUTATION"`
 * to `requireTier`'s guild-scoped form (`tier.ts`) rather than inventing
 * route-specific cache-clearing logic.
 */
export type AuthorizationFreshness = "READ" | "SENSITIVE_MUTATION";

/** Numeric rank for `requireTier`'s `>=` comparisons -- never re-derived ad hoc elsewhere. */
export const GUILD_TIER_RANK: Record<GuildTier, number> = {
  USER: 0,
  GUILD_ADMIN: 1,
  SUPERADMIN: 2,
};

export interface AuthorizedCaller {
  /** `dashboard_users.id` -- the internal FK used to load/decrypt Discord token material. */
  id: number;
  discordUserId: string;
}

export interface GuildAuthDeps {
  db: Kysely<DB>;
  config: AppConfig;
  cache: GuildAuthCache;
  tokenService: DiscordTokenService;
}

export function createGuildAuthDeps(
  db: Kysely<DB>,
  config: AppConfig,
  cache?: GuildAuthCache,
): GuildAuthDeps {
  return {
    db,
    config,
    cache: cache ?? new GuildAuthCache(),
    tokenService: new DiscordTokenService(db, config),
  };
}

/**
 * Fetches the caller's OWN live guild list (`GET /users/@me/guilds`),
 * subject to the 60s micro-cache (per-user; one Discord call answers
 * membership for every guild at once, see `guildAuthCache.ts`'s doc
 * comment). Goes through `DiscordTokenService.withFreshAccessToken` so an
 * expired access token is transparently refreshed (carry-forward #2) --
 * this is genuinely the FIRST place in the whole codebase that calls
 * `withFreshAccessToken`.
 */
async function getCallerGuilds(
  deps: GuildAuthDeps,
  caller: AuthorizedCaller,
  freshness: AuthorizationFreshness,
): Promise<DiscordGuildSummary[]> {
  const key = guildsListCacheKey(caller.discordUserId);
  // SENSITIVE_MUTATION never reads the cache (D-070) -- it falls straight
  // through to a live fetch below, every time, regardless of TTL.
  if (freshness === "READ") {
    const cached = deps.cache.get<DiscordGuildSummary[]>(key);
    if (cached) {
      return cached;
    }
  }
  const guilds = await deps.tokenService.withFreshAccessToken(caller.id, (accessToken) =>
    fetchUserGuilds(deps.config.discord, accessToken),
  );
  // The fresh result is written back regardless of `freshness` -- a
  // mutation's live read is exactly as cache-worthy as any other fresh
  // read; only the READ SIDE of the cache is ever skipped above.
  deps.cache.set(key, guilds);
  return guilds;
}

async function getCallerGuildMemberRoles(
  deps: GuildAuthDeps,
  caller: AuthorizedCaller,
  guildId: string,
  freshness: AuthorizationFreshness,
): Promise<string[]> {
  const key = guildMemberCacheKey(caller.discordUserId, guildId);
  if (freshness === "READ") {
    const cached = deps.cache.get<string[]>(key);
    if (cached) {
      return cached;
    }
  }
  const member = await deps.tokenService.withFreshAccessToken(caller.id, (accessToken) =>
    fetchGuildMember(deps.config.discord, accessToken, guildId),
  );
  deps.cache.set(key, member.roles);
  return member.roles;
}

/**
 * The mandatory prerequisite gate (08_AUTHORIZATION_AND_RBAC.md
 * `assertGuildMembership`): Superadmin bypasses explicitly and unconditionally
 * (no Discord call is made at all for a Superadmin caller -- tested to
 * confirm this is an ACTUAL bypass, not a coincidental pass); every other
 * caller must have `guildId` present in their own LIVE guild list. Returns
 * `false` (never throws) for "not a member" -- the caller (`tier.ts`) is
 * responsible for turning that into the documented 404.
 *
 * `freshness` defaults to `"READ"` (unchanged behavior for every existing
 * call site) -- pass `"SENSITIVE_MUTATION"` to force a live re-check,
 * bypassing the 60s micro-cache entirely (D-070, see `AuthorizationFreshness`).
 */
export async function assertGuildMembership(
  deps: GuildAuthDeps,
  caller: AuthorizedCaller,
  guildId: string,
  freshness: AuthorizationFreshness = "READ",
): Promise<boolean> {
  if (isSuperadmin(caller.discordUserId, deps.config)) {
    return true;
  }
  const guilds = await getCallerGuilds(deps, caller, freshness);
  return guilds.some((g) => g.id === guildId);
}

/**
 * Step 06 addition (IMPLEMENTATION/06_multi_guild_navigation.md): the guild
 * switcher / `GET /api/users/me/guilds` needs the caller's FULL live guild
 * list (id/owner/permissions/name/icon), not just a yes/no membership
 * answer or a resolved tier for one guild -- exposes the exact same cached
 * fetch `assertGuildMembership`/`resolveGuildAuthorization` already use
 * internally (`apps/api/src/guilds/guildsService.ts` is the one caller), so
 * Step 06 and the existing Step 05 authorization checks share ONE 60s
 * cache entry per user, never two independent Discord calls for the same
 * window. Deliberately a thin wrapper (not a re-implementation) so there is
 * still exactly ONE function that ever calls the Discord guild-list
 * endpoint.
 */
export async function getCallerGuildsForListing(
  deps: GuildAuthDeps,
  caller: AuthorizedCaller,
  freshness: AuthorizationFreshness = "READ",
): Promise<DiscordGuildSummary[]> {
  return getCallerGuilds(deps, caller, freshness);
}

/**
 * Whether the caller is Guild-Admin-capable in AT LEAST ONE guild they
 * belong to (Superadmin always counts) — added for the "Separate admin
 * alert notification preferences" correction (Step 09), which needs to
 * decide whether to show the "Admin alerts" notification-preferences group
 * at all to a given caller. Notification preferences are a per-user
 * (GLOBAL, not per-guild) resource (`dashboard_notification_preferences`
 * has no `guild_id` column) — there is no single `guildId` route param to
 * hand `requireTier`/`resolveGuildAuthorization`, so this reuses the SAME
 * "owner OR Discord ADMINISTRATOR permission bit" signal
 * `apps/api/src/guilds/guildsService.ts`'s `canAdminister` already computes
 * per guild-list entry, applied across the caller's WHOLE live guild list,
 * rather than inventing a second authorization model.
 *
 * DOCUMENTED SIMPLIFICATION vs. the full per-guild `resolveGuildAuthorization`
 * flow: this does NOT additionally consult a guild's configured custom
 * admin role (`dashboard_guild_policy`) or `ADMIN_DISABLED` override —
 * doing so precisely would require ANOTHER live Discord guild-member fetch
 * PER guild the caller belongs to (resolveGuildAuthorization's per-guild
 * role-fetch branch), which does not scale to "check every guild this
 * caller is in" the way a single guild-scoped route's one-guild check does.
 * This is intentionally used ONLY for this kind of presentation/authorization
 * -gating decision (never as a substitute for `requireTier` on an actual
 * guild-scoped mutation route) — a caller with a custom-role-only admin
 * grant in every one of their guilds (no Owner status, no raw
 * ADMINISTRATOR bit anywhere) would under-count as "not admin-capable" here
 * and simply not see the "Admin alerts" toggle, which is a UX gap, not a
 * security one (nothing about actual preference persistence or delivery
 * depends on this check).
 *
 * Fails CLOSED (returns `false`, never throws) on any error resolving the
 * caller's guild list (expired/garbage token material, Discord outage,
 * `DiscordReauthRequiredError`, ...) — a presentation-only gate must never
 * turn an otherwise-healthy preferences read into a hard failure.
 */
export async function isGuildAdminCapableAnywhere(
  deps: GuildAuthDeps,
  caller: AuthorizedCaller,
  freshness: AuthorizationFreshness = "READ",
): Promise<boolean> {
  if (isSuperadmin(caller.discordUserId, deps.config)) {
    return true;
  }
  try {
    const guilds = await getCallerGuilds(deps, caller, freshness);
    return guilds.some((g) => g.owner || hasAdministratorPermission(g.permissions));
  } catch {
    return false;
  }
}

/**
 * Step 10 correction round, Gap 1 (DASHBOARD/10_GUILD_ONBOARDING_AND_APPROVAL.md's
 * permission matrix: "ACTIVE | Owner: pause", "USER_PAUSED | Owner: resume" —
 * literal Discord guild Owner, NOT merely `GUILD_ADMIN` tier. There is no
 * separate `OWNER` entry in `GUILD_TIER_RANK` — Owner-ness is a raw Discord
 * fact (`DiscordGuildSummary.owner`), orthogonal to tier. This is NOT a
 * second, parallel "who is the owner" check: it reuses the exact same
 * private `getCallerGuilds` fetch/cache `resolveGuildAuthorization` already
 * calls internally and reads the exact same `summary.owner` field that
 * function's own Owner branch (above) reads — merely exposed as its own
 * named predicate so `tier.ts`'s `buildRequireGuildOwner` can gate a route on
 * it without re-deriving anything.
 *
 * Superadmin bypasses unconditionally (returns `true`, no Discord call at
 * all) — consistent with `assertGuildMembership`'s own Superadmin bypass
 * immediately above, and with 08_AUTHORIZATION_AND_RBAC.md's general
 * "Platform Superadmin supersedes every other check" pattern this codebase
 * applies everywhere else (there was no pre-existing Owner-gated action to
 * confirm this against, so this is the operator's explicit judgment call,
 * documented here rather than silently assumed).
 *
 * Returns `false` (never throws) for "not the owner" or "not even a member"
 * — callers MUST have already run `assertGuildMembership` for this exact
 * `guildId` first (same precondition `resolveGuildAuthorization` documents).
 */
export async function isCallerGuildOwner(
  deps: GuildAuthDeps,
  caller: AuthorizedCaller,
  guildId: string,
  freshness: AuthorizationFreshness = "READ",
): Promise<boolean> {
  if (isSuperadmin(caller.discordUserId, deps.config)) {
    return true;
  }
  const guilds = await getCallerGuilds(deps, caller, freshness);
  const summary = guilds.find((g) => g.id === guildId);
  return summary?.owner ?? false;
}

/**
 * Guild Admin Resolution (08_AUTHORIZATION_AND_RBAC.md's flowchart, minus
 * the Bunny role-deletion-detection branch -- see this module's header
 * comment). MUST only be called after `assertGuildMembership` has already
 * confirmed membership (or Superadmin) for this exact `guildId` -- this
 * function does not re-derive that decision itself beyond a defensive
 * fail-closed-to-USER fallback if it's ever called for a guild the caller
 * turns out not to belong to (keeps this function safe to unit-test in
 * isolation without ever becoming promotion-capable on its own).
 *
 * `freshness` defaults to `"READ"` (unchanged behavior for every existing
 * call site) -- pass `"SENSITIVE_MUTATION"` to force every underlying
 * Discord fetch this resolution needs to bypass the 60s micro-cache
 * entirely (D-070, see `AuthorizationFreshness`). The `dashboard_guild_policy`/
 * `dashboard_admin_overrides` DB reads below are ALWAYS live (never cached
 * in the first place, by design) -- `freshness` only affects the two
 * Discord-sourced inputs (`getCallerGuilds`/`getCallerGuildMemberRoles`).
 */
export async function resolveGuildAuthorization(
  deps: GuildAuthDeps,
  caller: AuthorizedCaller,
  guildId: string,
  freshness: AuthorizationFreshness = "READ",
): Promise<GuildTier> {
  // Platform Superadmin: GUILD_ADMIN-or-higher everywhere, by design
  // (08_AUTHORIZATION_AND_RBAC.md: "Platform Superadmin: GUILD ADMIN for
  // authorization purposes where the product contract grants it"). Returned
  // as the distinct SUPERADMIN rank so a future platform-scoped
  // `requireTier(guildIdParam, 'SUPERADMIN')` check can still distinguish
  // "the platform Superadmin" from "an ordinary Guild Admin/Owner" within a
  // guild context, per this step's IDOR-middleware separability requirement.
  if (isSuperadmin(caller.discordUserId, deps.config)) {
    return "SUPERADMIN";
  }

  const guilds = await getCallerGuilds(deps, caller, freshness);
  const summary = guilds.find((g) => g.id === guildId);
  if (!summary) {
    // Defensive fail-closed fallback only -- the real request path always
    // calls assertGuildMembership first and 404s before ever reaching here.
    return "USER";
  }

  // Discord guild Owner: always admin, absolute protection -- ADMIN_DISABLED
  // is checked further below and can NEVER reach/demote an Owner, because
  // this branch returns unconditionally before the override is even loaded.
  if (summary.owner) {
    return "GUILD_ADMIN";
  }

  // Individual override: ADMIN_DISABLED removes Guild Admin rights (never
  // Dashboard access -- the caller still resolves to a full USER) and
  // short-circuits every branch below it, but can never reach an Owner
  // (already returned above) or the Superadmin (already returned above).
  const override = await getAdminOverride(deps.db, guildId, caller.discordUserId);
  if (override?.adminDisabled) {
    return "USER";
  }

  const policy = await getGuildPolicy(deps.db, guildId);
  if (policy?.adminRoleDiscordId) {
    const roles = await getCallerGuildMemberRoles(deps, caller, guildId, freshness);
    // Fail-closed either way (role genuinely not held, OR the configured
    // role no longer exists in the guild at all) -- see this module's
    // header comment for why this deliberately never distinguishes the two
    // and never consults Bunny OCR. Never falls back to the
    // Administrator-permission branch below -- a configured role, once
    // set, always takes precedence over the default.
    return roles.includes(policy.adminRoleDiscordId) ? "GUILD_ADMIN" : "USER";
  }

  // No configured role: Discord Administrator permission is the documented
  // default admin reference.
  return hasAdministratorPermission(summary.permissions) ? "GUILD_ADMIN" : "USER";
}
