-- Dashboard-owned per-guild notification default policy (Step 10
-- external-review correction round, Section 11 — closes a real gap: the
-- onboarding "Notifications" section previously round-tripped through
-- `dashboard_guild_onboarding_progress.sections_json` only, with zero real
-- destination table and zero effect on `resolvePreference()` — a Guild
-- Admin's input there had no real operational effect at all).
--
-- Confirmed live (do not repurpose): `dashboard_notification_preferences`
-- (migration 0010) is genuinely PER-USER (`user_id`+`event_type` PK) with no
-- guild concept whatsoever — this is a DIFFERENT, new, per-GUILD table, not
-- a variant of it.
--
-- One row per guild whose default notification policy has ever been set —
-- a single in-app/DM toggle pair is the whole "default policy" per the
-- onboarding UI's simple toggle pair
-- (`notificationsInAppEnabled`/`notificationsDiscordDmEnabled`'s existing
-- shape in `OnboardingStateResponse`). `resolvePreference()`
-- (`apps/api/src/notifications/repo.ts`) consults this ONLY for event types
-- whose registry `group` is non-null (a real user-visible, guild-scoped
-- preference group) AND only when no explicit per-user
-- `dashboard_notification_preferences` row exists for that (user,
-- event_type) — a `group: null` platform-only event (e.g.
-- `NEW_GUILD_PENDING`) NEVER consults this table, by construction.
--
-- `guild_id` is VARCHAR(24), never numeric — same Snowflake-precision
-- rationale as every other guild_id column in this ledger (migration
-- 0004's header comment: Discord Snowflakes are up to 64 bits, well past
-- Number.MAX_SAFE_INTEGER). No FK into the SHARED `guilds` table — the
-- guild itself is a SHARED-table concept (ADR-011/ADR-019), same
-- value-reference-only convention `dashboard_guild_onboarding_progress`
-- (migration 0013) and `dashboard_guild_policy` (migration 0004) already
-- establish for every guild_id column in this ledger.
--
-- `updated_by` is the Discord user id (VARCHAR(24), same convention) of
-- whoever last set this guild's default — a value-reference only, not a FK
-- into `dashboard_users` (the setter need not have a `dashboard_users` row
-- keyed the same way this table would need; matches this ledger's
-- established snowflake-as-VARCHAR(24) convention rather than the internal
-- auto-increment `dashboard_users.id` other tables' `user_id` columns FK
-- into).
CREATE TABLE dashboard_guild_notification_defaults (
  guild_id VARCHAR(24) NOT NULL,
  in_app_enabled TINYINT(1) NOT NULL,
  discord_dm_enabled TINYINT(1) NOT NULL,
  updated_by VARCHAR(24) NOT NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (guild_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
