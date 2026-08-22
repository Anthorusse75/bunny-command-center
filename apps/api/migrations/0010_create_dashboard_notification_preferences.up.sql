-- Dashboard-owned per-(user, event_type) channel preference override (Step
-- 09, 18_NOTIFICATIONS_AND_DISCORD_DM.md §Preferences UX, 25_DATA_MODEL.md).
--
-- No row exists for an event_type the user has never explicitly changed --
-- the registry default (`packages/shared/src/constants/notifications.ts`'s
-- `NOTIFICATION_EVENT_REGISTRY[eventType].defaultInAppEnabled`/
-- `defaultDiscordDmEnabled`) applies until a row is written. This avoids
-- backfilling 11 rows per user at signup for every event type (same
-- optional-row pattern already used by `dashboard_user_guild_preferences`,
-- migration 0006) and, more importantly, means adding a new event type to
-- the registry later never requires a migration/backfill against this
-- table -- its default simply applies to every user until they change it.
--
-- The UI groups event types (18_NOTIFICATIONS_AND_DISCORD_DM.md: "the
-- underlying data model is per-event-type ... for precision, but the UI
-- groups related event types under one visible toggle pair") -- this table
-- still stores the precise per-event_type rows; the grouping is a
-- presentation-layer expansion (`NOTIFICATION_GROUP_EVENT_TYPES`), not a
-- schema concept.
--
-- `(user_id, event_type)` is the natural, sufficient PK -- preference
-- resolution (`createNotification`'s step 3) is always a point lookup on
-- exactly this pair.
CREATE TABLE dashboard_notification_preferences (
  user_id BIGINT UNSIGNED NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  in_app_enabled TINYINT(1) NOT NULL,
  discord_dm_enabled TINYINT(1) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (user_id, event_type),
  CONSTRAINT fk_dashboard_notification_preferences_user
    FOREIGN KEY (user_id) REFERENCES dashboard_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
