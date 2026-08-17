/**
 * `dashboard_user_guild_preferences` data access (migration 0006,
 * IMPLEMENTATION/06_multi_guild_navigation.md, 09_MULTI_GUILD_MODEL.md).
 * One row per (user_id, guild_id) the user has ever favorited/visited/hidden
 * from Home -- a guild the user is merely a live Discord member of has NO
 * row here until a meaningful action happens (09_MULTI_GUILD_MODEL.md
 * §Favorites and Home visibility: "Both default to on for a guild the
 * moment the user's first meaningful action there happens ... not on for
 * every guild a user happens to technically belong to").
 *
 * `last_upload_guild_id` is deliberately NOT read/written here -- see
 * migration 0007's header comment and this step's HANDOVER for the
 * documented deviation (it lives on `dashboard_users`, one row per user,
 * not per (user, guild) -- `userRepo.ts`/`guildsService.ts` own that field).
 */
import type { Kysely } from "kysely";
import type { DB } from "../db/codegen-types.js";

export interface GuildPreferenceRow {
  guildId: string;
  isFavorite: boolean;
  favoritedAt: Date | null;
  homeVisible: boolean;
  lastUsedAt: Date | null;
}

function toRow(row: {
  guild_id: string;
  is_favorite: number;
  favorited_at: Date | null;
  home_visible: number;
  last_used_at: Date | null;
}): GuildPreferenceRow {
  return {
    guildId: row.guild_id,
    isFavorite: Boolean(row.is_favorite),
    favoritedAt: row.favorited_at,
    homeVisible: Boolean(row.home_visible),
    lastUsedAt: row.last_used_at,
  };
}

/** Every preference row the user has, keyed by `guildId` for O(1) lookup while building the cross-referenced guild list (`guildsService.ts`). */
export async function listPreferencesForUser(
  db: Kysely<DB>,
  userId: number,
): Promise<Map<string, GuildPreferenceRow>> {
  const rows = await db
    .selectFrom("dashboard_user_guild_preferences")
    .select(["guild_id", "is_favorite", "favorited_at", "home_visible", "last_used_at"])
    .where("user_id", "=", userId)
    .execute();
  const map = new Map<string, GuildPreferenceRow>();
  for (const row of rows) {
    map.set(row.guild_id, toRow(row));
  }
  return map;
}

export async function getPreference(
  db: Kysely<DB>,
  userId: number,
  guildId: string,
): Promise<GuildPreferenceRow | undefined> {
  const row = await db
    .selectFrom("dashboard_user_guild_preferences")
    .select(["guild_id", "is_favorite", "favorited_at", "home_visible", "last_used_at"])
    .where("user_id", "=", userId)
    .where("guild_id", "=", guildId)
    .executeTakeFirst();
  return row ? toRow(row) : undefined;
}

/**
 * A guild-scoped preference row is created lazily, on first write, with the
 * documented defaults (`is_favorite=0`, `home_visible=1` --
 * 09_MULTI_GUILD_MODEL.md: "Both default to on"). `ON DUPLICATE KEY UPDATE`
 * with the SAME values as the insert keeps this idempotent under concurrent
 * calls without a separate SELECT-then-INSERT race
 * (IMPLEMENTATION/06_multi_guild_navigation.md §Concurrency: "simple
 * idempotent upserts").
 */
async function ensureRow(db: Kysely<DB>, userId: number, guildId: string): Promise<void> {
  await db
    .insertInto("dashboard_user_guild_preferences")
    .values({ user_id: userId, guild_id: guildId, is_favorite: 0, home_visible: 1 })
    .onDuplicateKeyUpdate({ guild_id: guildId })
    .execute();
}

/**
 * Toggles favorite status. `favorited_at` is set to `now` exactly when
 * flipping true (and bumped forward again on every re-favorite, backing
 * 09_MULTI_GUILD_MODEL.md's "re-favoriting bumping to top" ordering rule),
 * and cleared (`NULL`) when flipping false (25_DATA_MODEL.md: "cleared when
 * it flips false").
 */
export async function setFavorite(
  db: Kysely<DB>,
  userId: number,
  guildId: string,
  isFavorite: boolean,
  now: Date = new Date(),
): Promise<GuildPreferenceRow> {
  await ensureRow(db, userId, guildId);
  await db
    .updateTable("dashboard_user_guild_preferences")
    .set({
      is_favorite: isFavorite ? 1 : 0,
      favorited_at: isFavorite ? now : null,
    })
    .where("user_id", "=", userId)
    .where("guild_id", "=", guildId)
    .execute();
  const row = await getPreference(db, userId, guildId);
  if (!row) {
    throw new Error("setFavorite: row vanished immediately after upsert — unexpected concurrent delete.");
  }
  return row;
}

/** Independent of favorite status (09_MULTI_GUILD_MODEL.md §Favorites and Home visibility: "Favoriting is independent of ... home_visible"). */
export async function setHomeVisibility(
  db: Kysely<DB>,
  userId: number,
  guildId: string,
  homeVisible: boolean,
): Promise<GuildPreferenceRow> {
  await ensureRow(db, userId, guildId);
  await db
    .updateTable("dashboard_user_guild_preferences")
    .set({ home_visible: homeVisible ? 1 : 0 })
    .where("user_id", "=", userId)
    .where("guild_id", "=", guildId)
    .execute();
  const row = await getPreference(db, userId, guildId);
  if (!row) {
    throw new Error(
      "setHomeVisibility: row vanished immediately after upsert — unexpected concurrent delete.",
    );
  }
  return row;
}

/**
 * `last_used_at` updates on any meaningful guild-scoped action
 * (09_MULTI_GUILD_MODEL.md §Last-used guild) -- called from the guild
 * overview route (`GET /api/guilds/:guildId`) in this step, and available
 * for later steps' guild-scoped routes to call too. Creates the row lazily
 * like every other write here (viewing a guild for the first time is itself
 * a "meaningful action").
 */
export async function touchLastUsed(
  db: Kysely<DB>,
  userId: number,
  guildId: string,
  now: Date = new Date(),
): Promise<void> {
  await ensureRow(db, userId, guildId);
  await db
    .updateTable("dashboard_user_guild_preferences")
    .set({ last_used_at: now })
    .where("user_id", "=", userId)
    .where("guild_id", "=", guildId)
    .execute();
}
