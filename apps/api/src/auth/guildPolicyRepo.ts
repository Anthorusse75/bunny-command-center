/**
 * `dashboard_guild_policy` data access (migration 0004, ADR-007,
 * 25_DATA_MODEL.md DASHBOARD-OWNED list). Read by
 * `guildAuthorization.ts`'s `resolveGuildAuthorization` on every guild-admin
 * resolution (subject to the 60s micro-cache upstream); the write path
 * exists here because the RESOLUTION algorithm's tests need to set up a
 * configured-role scenario, but no HTTP route calls `setGuildAdminRole` yet
 * -- the admin-policy configuration UI/route
 * (`PUT /api/guilds/:guildId/admin-policy/role`) is explicitly Step 12's
 * scope (`24_API_CONTRACTS.md`), not built here.
 */
import type { Kysely } from "kysely";
import type { DB } from "../db/codegen-types.js";

export interface DashboardGuildPolicyRow {
  guildId: string;
  adminRoleDiscordId: string | null;
}

export async function getGuildPolicy(
  db: Kysely<DB>,
  guildId: string,
): Promise<DashboardGuildPolicyRow | undefined> {
  const row = await db
    .selectFrom("dashboard_guild_policy")
    .select(["guild_id", "admin_role_discord_id"])
    .where("guild_id", "=", guildId)
    .executeTakeFirst();
  if (!row) {
    return undefined;
  }
  return { guildId: row.guild_id, adminRoleDiscordId: row.admin_role_discord_id };
}

/** Upsert -- one row per guild, never deleted. `null` clears the configured role (falls back to the Administrator-permission default). */
export async function setGuildAdminRole(
  db: Kysely<DB>,
  guildId: string,
  adminRoleDiscordId: string | null,
): Promise<void> {
  await db
    .insertInto("dashboard_guild_policy")
    .values({ guild_id: guildId, admin_role_discord_id: adminRoleDiscordId })
    .onDuplicateKeyUpdate({ admin_role_discord_id: adminRoleDiscordId })
    .execute();
}
