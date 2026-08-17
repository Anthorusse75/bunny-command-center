-- Dashboard-owned per-(guild, user) individual admin override (ADR-011, ADR-007,
-- 25_DATA_MODEL.md DASHBOARD-OWNED list, IMPLEMENTATION/05_rbac_superadmin_idor.md).
--
-- `admin_disabled = TRUE` REMOVES Guild Admin rights for that specific user in
-- that specific guild WITHOUT ever removing Dashboard access -- the user
-- continues as a full USER (08_AUTHORIZATION_AND_RBAC.md's Guild Admin
-- Resolution flowchart, "HasOverrideDisabled -- yes" branch). It can never
-- demote the guild Owner or the platform Superadmin -- both are checked, and
-- return GUILD ADMIN, BEFORE this table is even consulted (see
-- `apps/api/src/auth/guildAuthorization.ts`'s `resolveGuildAuthorization`).
--
-- One row per (guild_id, user_id) pair, TOGGLED in place, never hard-deleted --
-- 25_DATA_MODEL.md: "audit-relevant, never hard-deleted, only toggled" -- so
-- `set_by_user_id`/`set_at` always reflect the most recent toggle, and the
-- row's mere existence is not itself meaningful (a row with
-- `admin_disabled = FALSE` is the recorded "restored" state, not absence of
-- history).
--
-- `guild_id`/`user_id`/`set_by_user_id` are all raw Discord Snowflakes, stored
-- as VARCHAR for the same exact-identity reason as `dashboard_guild_policy`
-- (this ledger's 0004 migration) and `dashboard_users.discord_user_id`
-- (migration 0002) -- never a numeric type, never converted through
-- Number(...)/parseInt(...)/unary + anywhere in the read/write path.
-- `user_id` deliberately does NOT reference `dashboard_users.id`: an Owner can
-- pre-emptively disable a specific Discord user's future admin rights before
-- that user has ever logged into the Dashboard themselves, so this table's
-- subject must be identifiable independent of `dashboard_users` row existence.
CREATE TABLE dashboard_admin_overrides (
  guild_id VARCHAR(24) NOT NULL,
  user_id VARCHAR(24) NOT NULL,
  admin_disabled TINYINT(1) NOT NULL DEFAULT 0,
  set_by_user_id VARCHAR(24) NOT NULL,
  set_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (guild_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
