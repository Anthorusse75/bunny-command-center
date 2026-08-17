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
