/**
 * Multi-guild model core (IMPLEMENTATION/06_multi_guild_navigation.md,
 * 09_MULTI_GUILD_MODEL.md). Builds the caller's real, live-cross-referenced
 * guild list: the caller's OWN Discord OAuth guild membership
 * (`getCallerGuildsForListing`, Step 05's cached fetch) cross-referenced
 * against the SHARED `guilds` table (bot presence -- has Bunny actually been
 * added to this guild?) and layered with the caller's Dashboard-owned
 * preferences (favorite / home-visible / last-used).
 *
 * 09_MULTI_GUILD_MODEL.md §Data model is explicit that the Dashboard NEVER
 * stores a cached copy of Discord membership truth -- this module never
 * persists anything from the Discord fetch; every response is built fresh
 * from the live (60s-micro-cached) source plus the DB-owned preference
 * layer, every call.
 *
 * === Discovered contradiction, flagged and resolved narrowly within this
 * module only (see this step's HANDOVER) ===
 * The SHARED `guilds` table (`vendor/self-bot-schema/database/migrations/
 * 0002_guilds_and_config_versions.up.sql`) stores `guild_id` as a plain
 * `BIGINT UNSIGNED` -- a REAL Discord Snowflake, not a surrogate key. Read
 * through this app's Kysely/mysql2 pool with no `supportBigNumbers`/
 * `bigNumberStrings` configured (`apps/api/src/db/kysely.ts`), a BIGINT
 * column decodes to a plain JS `number`, which silently loses precision for
 * any value past `Number.MAX_SAFE_INTEGER` (16 digits) -- real guild
 * Snowflakes are routinely 18-19 digits. This directly contradicts the
 * "Discord IDs are exact strings everywhere, never Number()/parseInt()/
 * unary +" invariant Steps 04/05 established -- and Step 06 is the FIRST
 * step that ever needs to compare this column against a live OAuth guild
 * ID. This was NOT silently worked around: every query in this module reads
 * `guild_id` via `CAST(guild_id AS CHAR)` so it round-trips as an exact
 * string, matching the invariant used everywhere else in this codebase, and
 * this file's identity comparisons/map keys are ALWAYS the cast string,
 * never the raw codegen `number` column. This fix is deliberately scoped to
 * the queries THIS module issues -- it does not touch the shared migration
 * (forbidden: Step 06 may not modify either bot repo), the kysely-codegen
 * output (still accurately reflects the real column type), or any
 * OTHER pre-existing read of `guilds.guild_id` elsewhere in this codebase
 * (none currently exist outside this module — grep-verified before writing
 * this file). Flagged explicitly rather than assumed pre-handled, per
 * 00_GLOBAL_IMPLEMENTATION_RULES.md #5.
 */
import { sql, type Kysely } from "kysely";
import type { DB } from "../db/codegen-types.js";
import type { DiscordOAuthConfig } from "../config.js";
import {
  getCallerGuildsForListing,
  hasAdministratorPermission,
  type AuthorizedCaller,
  type AuthorizationFreshness,
  type GuildAuthDeps,
} from "../auth/index.js";
import { listPreferencesForUser, setFavorite, setHomeVisibility } from "./guildPreferencesRepo.js";

export interface GuildListEntry {
  guildId: string;
  /** From the caller's own Discord OAuth guild-list response — undefined only if Discord itself omitted it (defensive, never fabricated). */
  name: string | null;
  icon: string | null;
  /** True iff a row exists for this guild in the SHARED `guilds` table — i.e. Bunny has actually been added there, not merely that the caller belongs to the Discord server. */
  botPresent: boolean;
  /** Only meaningful when `botPresent` — the shared `guilds.enabled` flag. */
  enabled: boolean | null;
  isOwner: boolean;
  /** Owner OR holds Discord's `ADMINISTRATOR` permission bit in this guild — the documented condition for "can invite Bunny" (09_MULTI_GUILD_MODEL.md §Guild switching, mission §11). */
  canAdminister: boolean;
  isFavorite: boolean;
  favoritedAt: string | null;
  homeVisible: boolean;
  lastUsedAt: string | null;
}

export interface GuildListResult {
  /** Bot-present guilds only, ordered favorites-first (most-recently-favorited on top) then remaining alphabetically (09_MULTI_GUILD_MODEL.md §Guild switching) — the real, usable switcher list. */
  guilds: GuildListEntry[];
  /** Bot-ABSENT guilds the caller can administer on Discord — the "Invite Bunny to another server" CTA's eligible set (03_INFORMATION_ARCHITECTURE.md §Inter-guild navigation). Alphabetical. */
  inviteEligibleGuilds: GuildListEntry[];
  /** True iff `inviteEligibleGuilds` is non-empty — the exact condition SCREENS/HOME.md's zero-guild state's two sub-cases ("can invite" / "cannot invite") branch on. */
  canInviteBunnyAnywhere: boolean;
}

/** Fetches bot-presence rows for exactly the given guild IDs from the SHARED `guilds` table — see this module's header comment for the CAST(...AS CHAR) precision-safety rationale. Keyed by the exact-string guild ID. */
async function fetchBotPresence(
  db: Kysely<DB>,
  guildIds: string[],
): Promise<Map<string, { displayName: string | null; enabled: boolean }>> {
  const map = new Map<string, { displayName: string | null; enabled: boolean }>();
  if (guildIds.length === 0) {
    return map;
  }
  const rows = await db
    .selectFrom("guilds")
    .select([sql<string>`CAST(guild_id AS CHAR)`.as("guildIdStr"), "display_name_cache", "enabled"])
    .where(sql<string>`CAST(guild_id AS CHAR)`, "in", guildIds)
    .execute();
  for (const row of rows) {
    map.set(row.guildIdStr, { displayName: row.display_name_cache, enabled: Boolean(row.enabled) });
  }
  return map;
}

function toIso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

/**
 * The real production entrypoint for `GET /api/users/me/guilds`
 * (`24_API_CONTRACTS.md`) and for building the guild switcher client-side.
 * `freshness` mirrors `requireTier`'s own contract — always `"READ"` here
 * (a guild-list fetch is never a sensitive mutation).
 */
export async function buildGuildList(
  deps: GuildAuthDeps,
  caller: AuthorizedCaller,
  userId: number,
  freshness: AuthorizationFreshness = "READ",
): Promise<GuildListResult> {
  const [discordGuilds, preferences] = await Promise.all([
    getCallerGuildsForListing(deps, caller, freshness),
    listPreferencesForUser(deps.db, userId),
  ]);

  const guildIds = discordGuilds.map((g) => g.id);
  const presence = await fetchBotPresence(deps.db, guildIds);

  const entries: GuildListEntry[] = discordGuilds.map((g) => {
    const botInfo = presence.get(g.id);
    const pref = preferences.get(g.id);
    const canAdminister = g.owner || hasAdministratorPermission(g.permissions);
    return {
      guildId: g.id,
      name: g.name ?? null,
      icon: g.icon ?? null,
      botPresent: botInfo !== undefined,
      enabled: botInfo ? botInfo.enabled : null,
      isOwner: g.owner,
      canAdminister,
      isFavorite: pref?.isFavorite ?? false,
      favoritedAt: toIso(pref?.favoritedAt ?? null),
      homeVisible: pref?.homeVisible ?? true,
      lastUsedAt: toIso(pref?.lastUsedAt ?? null),
    };
  });

  const usable = entries.filter((e) => e.botPresent);
  const inviteEligible = entries.filter((e) => !e.botPresent && e.canAdminister);

  const nameKey = (e: GuildListEntry): string => (e.name ?? e.guildId).toLocaleLowerCase();

  const favorites = usable
    .filter((e) => e.isFavorite)
    .sort((a, b) => {
      // Most-recently-favorited first (09_MULTI_GUILD_MODEL.md: "re-favoriting bumping to top").
      const at = a.favoritedAt ? Date.parse(a.favoritedAt) : 0;
      const bt = b.favoritedAt ? Date.parse(b.favoritedAt) : 0;
      return bt - at;
    });
  const rest = usable.filter((e) => !e.isFavorite).sort((a, b) => nameKey(a).localeCompare(nameKey(b)));

  const orderedInviteEligible = inviteEligible.sort((a, b) => nameKey(a).localeCompare(nameKey(b)));

  return {
    guilds: [...favorites, ...rest],
    inviteEligibleGuilds: orderedInviteEligible,
    canInviteBunnyAnywhere: orderedInviteEligible.length > 0,
  };
}

export interface GuildOverviewResult {
  guildId: string;
  botPresent: boolean;
  enabled: boolean | null;
  displayName: string | null;
}

/**
 * The real production entrypoint for `GET /api/guilds/:guildId`
 * (`24_API_CONTRACTS.md`'s "overview summary", USER tier). Deliberately a
 * PLACEHOLDER-shaped response — full guild overview content (PremiumPlus,
 * stock, forecasts) is Step 13's scope
 * (IMPLEMENTATION/06_multi_guild_navigation.md: "full feature content
 * arrives per-domain in later steps"). Called ONLY after `requireTier` has
 * already confirmed membership + USER tier for this exact `guildId` — never
 * re-derives authorization itself.
 */
export async function getGuildOverview(db: Kysely<DB>, guildId: string): Promise<GuildOverviewResult> {
  const row = await db
    .selectFrom("guilds")
    .select([sql<string>`CAST(guild_id AS CHAR)`.as("guildIdStr"), "display_name_cache", "enabled"])
    .where(sql<string>`CAST(guild_id AS CHAR)`, "=", guildId)
    .executeTakeFirst();
  if (!row) {
    return { guildId, botPresent: false, enabled: null, displayName: null };
  }
  return { guildId, botPresent: true, enabled: Boolean(row.enabled), displayName: row.display_name_cache };
}

/** Discord's bot-authorization (add-to-server) URL — DISTINCT from the login OAuth authorize flow (`discordClient.ts`'s `buildAuthorizeUrl`, `scope=identify guilds guilds.members.read`). No `guild_id` param: per Discord's own documented behavior, omitting it lets the AUTHORIZING user pick which of their own administrable guilds to add the bot to from Discord's own consent screen — this module never enumerates/fabricates a per-guild invite link itself (mission §11's "do not fake bot presence" extends to never claiming to know which guild the user will pick). */
export function buildBotInviteUrl(config: DiscordOAuthConfig): string {
  const url = new URL(config.authorizeBaseUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("scope", "bot");
  return url.toString();
}

export { setFavorite, setHomeVisibility };
