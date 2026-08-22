-- Dashboard-owned durable notification record (Step 09,
-- 25_DATA_MODEL.md DASHBOARD-OWNED list, IMPLEMENTATION/09_notifications_system.md,
-- ADR-013/ADR-014). One row per notification — the durable source of truth;
-- `dashboard_notification_deliveries` (migration 0009) tracks per-channel
-- delivery attempts against THIS row, never the other way around.
--
-- `id` is CHAR(26), ASCII, time-sortable ULID (apps/api/src/notifications/id.ts)
-- -- same shape convention already used by the SHARED schema's own CHAR26 ids
-- (`operator_commands.command_id`, `01_NEW_SELF_BOTS/database/migrations/
-- 0009_operations.up.sql:17`). Being time-sortable lets cursor pagination
-- (`GET /api/notifications`, 24_API_CONTRACTS.md: "cursor-based, default 25,
-- max 100") use `WHERE id < :cursor ORDER BY id DESC` directly, no separate
-- `created_at` tie-break needed.
--
-- `user_id` REFERENCES dashboard_users.id (the internal surrogate PK, never
-- `discord_user_id` -- same convention as `dashboard_user_guild_preferences`,
-- migration 0006) -- ON DELETE CASCADE, consistent with `dashboard_users`'
-- own documented retention ("deleted on explicit account disconnect
-- request").
--
-- `message_key`/`parameters_json` are the durable identity of the
-- notification's content (18_NOTIFICATIONS_AND_DISCORD_DM.md §Localization:
-- "rendered into the recipient's stored language preference ... at
-- delivery/render time, never at creation time") -- this table NEVER stores
-- pre-rendered text.
--
-- `guild_id` is VARCHAR, deliberately NOT numeric -- same Snowflake-precision
-- rationale as every other guild_id-shaped column in this ledger (migrations
-- 0004/0006/0007's header comments) -- and carries no FK (value-reference
-- only, guild existence resolved live from Discord, never enforced via a
-- Dashboard-owned-table FK into a live/external concept).
--
-- === Correction #6 (this step's task brief) — SSE ordinal vs notification
-- business id ===
-- The CHAR26 `id` is NOT Step 03's required durable, strictly-increasing,
-- restart-safe `SourceAdapter.ordinal` (apps/api/src/sse/types.ts:6-9: "the
-- source table's own durable, strictly-increasing, restart-safe key -- an
-- auto-increment PK, or an equivalent monotonic value"). A ULID's timestamp
-- component is millisecond-resolution and ties under concurrent inserts
-- within the same millisecond sort arbitrarily on their random suffix, which
-- is NOT a safe total order for `fetchSince(sinceOrdinal, limit)` (two rows
-- created in the same millisecond could be missed or re-delivered depending
-- on tie-break luck). `sse_seq` below is a dedicated `BIGINT UNSIGNED
-- AUTO_INCREMENT` column purely for this purpose -- InnoDB's AUTO_INCREMENT
-- is exactly the durable, strictly-increasing, restart-safe counter the
-- adapter contract calls for (mission's own "AUTO_INCREMENT is fine and
-- idiomatic here" guidance, quoted in this step's task brief) -- never
-- `Date.now()`/`Math.random()`/a process-local counter. It does not have to
-- be the table's PRIMARY KEY to be AUTO_INCREMENT in InnoDB; it only needs
-- its own indexed key, which `ix_dashboard_notifications_sse_seq` below
-- provides.
CREATE TABLE dashboard_notifications (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  message_key VARCHAR(191) NOT NULL,
  parameters_json JSON NOT NULL,
  guild_id VARCHAR(24) NULL,
  deeplink_path VARCHAR(255) NOT NULL,
  read_at DATETIME(6) NULL,
  dismissed_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  -- Correction #6 — see header comment. Durable SSE fan-out ordinal, distinct
  -- from `id`.
  sse_seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  PRIMARY KEY (id),
  UNIQUE KEY ix_dashboard_notifications_sse_seq (sse_seq),
  -- Per-user notification listing (cursor pagination, ULID `id` is
  -- time-sortable so this single composite key serves both "list mine,
  -- newest first" and the cursor `WHERE user_id=? AND id < :cursor`).
  KEY ix_dashboard_notifications_user_id (user_id, id),
  -- Unread/read filtering (`read_at IS NULL` -- "unread" -- ordered the same
  -- way as the plain listing).
  KEY ix_dashboard_notifications_user_read (user_id, read_at, id),
  CONSTRAINT fk_dashboard_notifications_user
    FOREIGN KEY (user_id) REFERENCES dashboard_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
