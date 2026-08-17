/**
 * `dashboard_admin_overrides` data access (migration 0005, ADR-007,
 * 25_DATA_MODEL.md DASHBOARD-OWNED list: "audit-relevant, never
 * hard-deleted, only toggled"). Read by `guildAuthorization.ts`'s
 * `resolveGuildAuthorization`. `setAdminOverride` exists here for the same
 * reason `setGuildAdminRole` does (guildPolicyRepo.ts): the resolution
 * algorithm's tests need to set up override scenarios, but the write ROUTE
 * (`PUT /api/guilds/:guildId/admin-policy/overrides/:userId`) is Step 12's
 * scope.
 */
import type { Kysely } from "kysely";
import type { DB } from "../db/codegen-types.js";

export interface DashboardAdminOverrideRow {
  guildId: string;
  userId: string;
  adminDisabled: boolean;
  setByUserId: string;
  setAt: Date;
}

export async function getAdminOverride(
  db: Kysely<DB>,
  guildId: string,
  userId: string,
): Promise<DashboardAdminOverrideRow | undefined> {
  const row = await db
    .selectFrom("dashboard_admin_overrides")
    .selectAll()
    .where("guild_id", "=", guildId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (!row) {
    return undefined;
  }
  return {
    guildId: row.guild_id,
    userId: row.user_id,
    adminDisabled: Boolean(row.admin_disabled),
    setByUserId: row.set_by_user_id,
    setAt: row.set_at,
  };
}

/**
 * Toggles the ONE row for (guildId, userId) in place -- never deletes,
 * never inserts a second row for the same pair (ADR-007: "restore is
 * instant"; 25_DATA_MODEL.md: "toggled, not silently hard-deleted"). Every
 * call records who made the change and when, even a "restore" (setting
 * `adminDisabled` back to `false`) -- the audit trail is the persisted
 * history of toggles on this single row's `set_by_user_id`/`set_at`, not a
 * separate history table.
 */
export async function setAdminOverride(
  db: Kysely<DB>,
  guildId: string,
  userId: string,
  adminDisabled: boolean,
  setByUserId: string,
  now: Date = new Date(),
): Promise<void> {
  // `admin_disabled` is a TINYINT(1) column -- Kysely's generated type is
  // `number`, not `boolean` (mysql2 does not auto-map TINYINT(1) to a JS
  // boolean the way some other MySQL clients do). Converted explicitly at
  // this ONE boundary so every caller of this repo still works with a real
  // `boolean` (`getAdminOverride` converts back the same way on read).
  const adminDisabledValue = adminDisabled ? 1 : 0;
  await db
    .insertInto("dashboard_admin_overrides")
    .values({
      guild_id: guildId,
      user_id: userId,
      admin_disabled: adminDisabledValue,
      set_by_user_id: setByUserId,
      set_at: now,
    })
    .onDuplicateKeyUpdate({
      admin_disabled: adminDisabledValue,
      set_by_user_id: setByUserId,
      set_at: now,
    })
    .execute();
}
