-- Dashboard-owned per-(user, guild) preference row (ADR-011, 25_DATA_MODEL.md
-- DASHBOARD-OWNED list, IMPLEMENTATION/06_multi_guild_navigation.md).
--
-- One row per (user_id, guild_id) pair the user has ever favorited, hidden
-- from Home, or otherwise interacted with meaningfully. A guild the user is
-- merely a live Discord member of, but has never favorited/visited, has NO
-- row here -- membership truth is never cached Dashboard-side (09_MULTI_GUILD_MODEL.md:
-- "not stored by the Dashboard as a cached copy of truth"), this table only
-- ever records the USER'S OWN preferences layered on top of that live list.
--
-- guild_id is VARCHAR, deliberately NOT numeric -- same rationale as
-- dashboard_guild_policy (migration 0004) / dashboard_users.discord_user_id
-- (migration 0002): Discord Snowflakes exceed Number.MAX_SAFE_INTEGER and
-- must round-trip as exact strings everywhere in this codebase.
--
-- user_id REFERENCES dashboard_users.id (the internal surrogate PK, not the
-- Discord snowflake) -- unlike dashboard_admin_overrides.user_id, a
-- guild-preference row can only ever be created BY the user themselves
-- (toggling their own favorite/home-visibility), so there is no
-- "pre-emptively configure before the user has logged in" scenario to
-- support, and referencing the internal PK lets ON DELETE CASCADE clean up
-- automatically on an explicit account-disconnect deletion
-- (dashboard_users' own header comment: "deleted on explicit account
-- disconnect request").
--
-- favorited_at is DATETIME(6) NULL: NULL when is_favorite=0, set to NOW(6)
-- the moment is_favorite flips true, and left untouched (not cleared) if the
-- row is later un-favorited then re-favorited is intentionally handled by the
-- application layer bumping it forward again -- this column backs the
-- documented ordering rule (09_MULTI_GUILD_MODEL.md: "favorited-at order,
-- with re-favoriting bumping to top"). It is set back to NULL when
-- is_favorite flips back to 0 (25_DATA_MODEL.md: "favorited_at ... set when
-- is_favorite flips true, cleared when it flips false").
--
-- === Documented deviation from 25_DATA_MODEL.md line 59's literal column
-- list, operator-resolved (see this step's HANDOVER) ===
-- 25_DATA_MODEL.md, 09_MULTI_GUILD_MODEL.md, and this step's own
-- IMPLEMENTATION file all literally list `last_upload_guild_id` as a column
-- on THIS table. That placement is a real modeling contradiction: "which
-- guild did I last upload to" is a fact about the USER (Upload is a GLOBAL
-- route, `/upload`, never `/guild/:guildId/upload` --
-- 03_INFORMATION_ARCHITECTURE.md's route table), not a fact about any one
-- (user, guild) pair -- storing it here would mean either writing a
-- redundant copy onto every one of a user's preference rows on each upload,
-- or an awkward single-populated-row-among-many sentinel, plus a
-- chicken-and-egg problem for a user's very first upload before ANY
-- preference row exists yet. The operator directing this implementation
-- resolved this explicitly: `last_upload_guild_id` instead lives on
-- `dashboard_users` (one row per user, nullable value-reference to a guild --
-- migration 0007), NOT here. This table therefore has NO `last_upload_guild_id`
-- column, despite the literal doc text.
--
-- === home_visible DEFAULT, corrected in Step 06's second external-review
-- correction pass (this branch, unmerged) ===
-- This column's DEFAULT was originally `1`, matching an earlier
-- (incorrect) reading of 09_MULTI_GUILD_MODEL.md's "Both default to on"
-- rule as "on for any row this table ever gets, including one created by
-- mere navigation." The application-layer correction (see
-- apps/api/src/guilds/guildPreferencesRepo.ts's `ensureRow` and
-- guildsService.ts's `buildGuildList`) established the CORRECT reading:
-- that rule's actual trigger is a genuine first meaningful action (first
-- upload, first admin action, or explicit onboarding completion -- none of
-- which are Step 06's scope; the real callers are Steps 15/12/10), never
-- mere technical membership or mere viewing/navigation. Both application
-- functions were fixed to default `home_visible` to `false`/`0` --  but
-- this column's own DEFAULT clause, below, still said `1`, a genuine
-- schema/application contradiction if this table were ever created by any
-- path other than `ensureRow` (there currently is none, but a schema
-- default should never silently disagree with its own application layer).
-- Corrected in place, not via a new migration: this migration
-- (`0006_create_dashboard_user_guild_preferences`) has never been applied
-- to any real, persistent environment -- `main` does not have Step 06 at
-- all yet, and this feature branch is unmerged. Every environment that has
-- ever run it (CI, local disposable test databases) tears the schema down
-- and rebuilds it from scratch on every single run, so no real migration
-- ledger anywhere has ever recorded this file's checksum against a
-- persistent target. The runner's checksum-mismatch protection
-- (`apps/api/migrations/runner.ts`'s own header comment) exists
-- specifically to catch an ALREADY-APPLIED migration's on-disk content
-- silently drifting out from under a real, persisted ledger -- a
-- protection this edit cannot violate, because no such ledger exists for
-- this migration anywhere. The additive-only audit
-- (`apps/api/migrations/additive-audit.ts`) is also unaffected: this edits
-- a `DEFAULT` clause inside the original, not-yet-deployed `CREATE TABLE`
-- statement itself, not a `DROP`/`MODIFY`/`ALTER ... DROP` against an
-- existing deployed table.
CREATE TABLE dashboard_user_guild_preferences (
  user_id BIGINT UNSIGNED NOT NULL,
  guild_id VARCHAR(24) NOT NULL,
  is_favorite TINYINT(1) NOT NULL DEFAULT 0,
  favorited_at DATETIME(6) NULL,
  home_visible TINYINT(1) NOT NULL DEFAULT 0,
  last_used_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (user_id, guild_id),
  KEY ix_dashboard_user_guild_preferences_user_favorite (user_id, is_favorite, favorited_at),
  CONSTRAINT fk_dashboard_user_guild_preferences_user
    FOREIGN KEY (user_id) REFERENCES dashboard_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
