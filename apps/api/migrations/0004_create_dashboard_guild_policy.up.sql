-- Dashboard-owned per-guild admin-role policy (ADR-011, ADR-007, 25_DATA_MODEL.md
-- DASHBOARD-OWNED list, IMPLEMENTATION/05_rbac_superadmin_idor.md). One row per
-- Discord guild that has ever had its Dashboard-admin reference configured; a
-- guild with NO row here (or `admin_role_discord_id IS NULL`) falls back to the
-- documented default: Discord `Administrator` permission grants Guild Admin
-- (08_AUTHORIZATION_AND_RBAC.md's Guild Admin Resolution flowchart, "RoleConfigured
-- -- no" branch).
--
-- `guild_id`/`admin_role_discord_id` are VARCHAR, deliberately NOT numeric --
-- same rationale as `dashboard_users.discord_user_id` (migration 0002's header
-- comment): Discord Snowflakes are up to 64 bits / commonly 18-19 decimal
-- digits, well past Number.MAX_SAFE_INTEGER (16 digits) -- any numeric
-- conversion anywhere in the read/write path risks two different Discord
-- guilds/roles silently colliding once their IDs differ only past the 16th
-- significant digit. VARCHAR(24) round-trips exactly through
-- MySQL/mysql2/Kysely/JSON with zero special driver configuration.
--
-- No row here EVER grants admin by itself -- this table only records WHICH
-- Discord role, if any, a guild's Owner has designated as the Dashboard-admin
-- reference. Whether the CURRENT caller actually holds that role is resolved
-- live, per-request (subject only to the documented 60s micro-cache), from
-- that caller's own OAuth session (`GET /users/@me/guilds/{guild_id}/member`,
-- ADR-004) -- never cached here, never trusted from a client claim.
CREATE TABLE dashboard_guild_policy (
  guild_id VARCHAR(24) NOT NULL,
  admin_role_discord_id VARCHAR(24) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (guild_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
