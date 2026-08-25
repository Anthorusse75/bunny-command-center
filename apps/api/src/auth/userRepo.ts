/**
 * `dashboard_users` data access (25_DATA_MODEL.md DASHBOARD-OWNED list).
 * Discord access/refresh tokens are ALWAYS encrypted before being written
 * here and ALWAYS decrypted only at the point of actual use
 * (`tokenCrypto.ts`) — this module never accepts or returns plaintext
 * tokens itself, only the already-encrypted `Buffer` form, so a caller
 * cannot accidentally persist a plaintext value through it.
 */
import type { Kysely } from "kysely";
import type { DB } from "../db/codegen-types.js";

export interface DashboardUserRow {
  id: number;
  /**
   * Kept as a `string`, exactly as Discord's own API serializes it and
   * exactly as the `dashboard_users.discord_user_id` column stores it
   * (`VARCHAR`, not `BIGINT`) — see migration 0002's own comment. Never
   * pass this through `Number(...)`/`parseInt(...)`/unary `+`/any other
   * numeric coercion anywhere: real snowflakes exceed
   * `Number.MAX_SAFE_INTEGER` and would silently lose precision, risking
   * two different Discord accounts colliding onto one dashboard identity.
   */
  discord_user_id: string;
  username: string;
  avatar_hash: string | null;
  locale: string;
  theme_name: string;
  theme_mode: string;
  discord_access_token_enc: Buffer | null;
  discord_refresh_token_enc: Buffer | null;
  discord_token_expires_at: Date | null;
  /**
   * Step 06 addition (migration 0007) — see that migration's header comment
   * and this step's HANDOVER for the documented deviation from
   * 25_DATA_MODEL.md's literal column placement (moved here, off
   * `dashboard_user_guild_preferences`, since Upload is a GLOBAL route with
   * no per-guild context to hang a per-(user,guild) fact on). Same
   * VARCHAR/never-numeric rationale as `discord_user_id`.
   */
  last_upload_guild_id: string | null;
}

export interface UpsertUserParams {
  discordUserId: string;
  username: string;
  avatarHash: string | null;
  encryptedAccessToken: Buffer;
  encryptedRefreshToken: Buffer;
  tokenExpiresAt: Date;
}

/**
 * Upserts by `discord_user_id` (07_DISCORD_OAUTH.md: "upsert dashboard_users
 * row (keyed by discord_user_id)") — identity is always the OAuth-verified
 * Discord user ID, never a client-editable field
 * (27_SECURITY.md's fix for the Self-bot dashboard's audited defect).
 */
export async function upsertDashboardUser(
  db: Kysely<DB>,
  params: UpsertUserParams,
): Promise<DashboardUserRow> {
  // The Discord user ID travels through this whole function as the EXACT
  // string Discord's API returned — never coerced to a JS number at any
  // point (see DashboardUserRow.discord_user_id's own doc comment).
  const discordUserId = params.discordUserId;
  await db
    .insertInto("dashboard_users")
    .values({
      discord_user_id: discordUserId,
      username: params.username,
      avatar_hash: params.avatarHash,
      discord_access_token_enc: params.encryptedAccessToken,
      discord_refresh_token_enc: params.encryptedRefreshToken,
      discord_token_expires_at: params.tokenExpiresAt,
    })
    .onDuplicateKeyUpdate({
      username: params.username,
      avatar_hash: params.avatarHash,
      discord_access_token_enc: params.encryptedAccessToken,
      discord_refresh_token_enc: params.encryptedRefreshToken,
      discord_token_expires_at: params.tokenExpiresAt,
    })
    .execute();

  const row = await db
    .selectFrom("dashboard_users")
    .selectAll()
    .where("discord_user_id", "=", discordUserId)
    .executeTakeFirstOrThrow();
  return row;
}

export async function findDashboardUserById(
  db: Kysely<DB>,
  id: number,
): Promise<DashboardUserRow | undefined> {
  return db.selectFrom("dashboard_users").selectAll().where("id", "=", id).executeTakeFirst();
}

/**
 * Step 10 addition — resolves a real Discord user id to their
 * `dashboard_users` row, if they have ever logged in. Used to find the
 * Superadmin's (`auth/superadmin.ts`'s single configured
 * `PLATFORM_SUPERADMIN_DISCORD_ID`) internal recipient id for
 * `createNotification()` — deliberately returns `undefined` rather than
 * throwing when absent (a Superadmin who has never logged in has no
 * `dashboard_users` row yet; `activationRequestsService.ts` treats this as
 * "skip the in-app notification, never block the activation-request write
 * on it" — the durable `dashboard_guild_activation_requests` row and audit
 * log entry are the source of truth regardless).
 */
export async function findDashboardUserByDiscordId(
  db: Kysely<DB>,
  discordUserId: string,
): Promise<DashboardUserRow | undefined> {
  return db
    .selectFrom("dashboard_users")
    .selectAll()
    .where("discord_user_id", "=", discordUserId)
    .executeTakeFirst();
}

/**
 * Step 06 addition — records "which guild did this user last upload to"
 * (09_MULTI_GUILD_MODEL.md §Last-used guild), on `dashboard_users` per this
 * step's documented deviation (migration 0007). **Honest wiring status
 * (this step's HANDOVER)**: this function is IMPLEMENTED and unit-tested,
 * but has NO real call site yet — Upload itself (the only real action that
 * would ever call this) is Step 15's scope; this step only builds the
 * placeholder `/upload` route. Provided now so Step 15 does not need its
 * own migration to add this column, matching this step's documented
 * "routes and their auth guards exist now; full feature content arrives
 * per-domain in later steps" pattern applied to the DATA layer too.
 */
export async function setLastUploadGuild(db: Kysely<DB>, userId: number, guildId: string): Promise<void> {
  await db
    .updateTable("dashboard_users")
    .set({ last_upload_guild_id: guildId })
    .where("id", "=", userId)
    .execute();
}

export interface UpdateUserTokensParams {
  encryptedAccessToken: Buffer;
  encryptedRefreshToken: Buffer;
  tokenExpiresAt: Date;
}

/**
 * Step 05's Discord-token-refresh lifecycle (`discordTokenService.ts`,
 * 07_DISCORD_OAUTH.md §Discord token refresh, carry-forward #2 from Step 04):
 * persists a REFRESHED access/refresh token pair (Discord may or may not
 * rotate the refresh token itself — this always writes whatever the refresh
 * response actually returned, rotated or not, never assumes one or the
 * other) without touching `username`/`avatar_hash`/`locale`/theme
 * preferences, unlike `upsertDashboardUser` (which is the LOGIN path and
 * always has fresh identity data to write alongside the tokens). Scoped by
 * internal `id`, never `discord_user_id` re-derived from anywhere
 * client-influenced.
 */
export async function updateDashboardUserTokens(
  db: Kysely<DB>,
  id: number,
  params: UpdateUserTokensParams,
): Promise<void> {
  await db
    .updateTable("dashboard_users")
    .set({
      discord_access_token_enc: params.encryptedAccessToken,
      discord_refresh_token_enc: params.encryptedRefreshToken,
      discord_token_expires_at: params.tokenExpiresAt,
    })
    .where("id", "=", id)
    .execute();
}
