-- Dashboard-owned per-channel delivery attempt against a
-- `dashboard_notifications` row (Step 09, ADR-013, 25_DATA_MODEL.md). Exactly
-- one row per (notification, channel) -- `IN_APP` is written `SENT`
-- synchronously at notification-creation time (ADR-013: "not really
-- 'delivery' ... created SENT synchronously ... for a uniform audit trail
-- rather than a functional retry need"); `DISCORD_DM` starts `PENDING` (or
-- `SKIPPED_PREFERENCE` if the recipient's preference has DM off) and is
-- later updated by this step's reconciliation watcher
-- (apps/api/src/notifications/reconciliationWatcher.ts), never by
-- `operator_commands` itself and never by a second Dashboard-side retry
-- loop.
--
-- === Correction #2 (this step's task brief) — reconciliation source ===
-- `operator_command_id` is a VALUE-REFERENCE only, no physical FK, into the
-- SHARED `operator_commands.command_id` (25_DATA_MODEL.md §Cross-database
-- consistency: "no DB-level FK ever crosses an ownership-domain boundary in
-- this system" -- same precedent as `hero_reference_catalog_versions.
-- build_operator_command_id`, `web_upload_intake.upload_item_id`). The
-- watcher reads the corresponding `operator_commands` row directly by this
-- id and maps its `state`/`last_error_code` onto `state` below -- it never
-- watches `operator_command_events` (an earlier ADR-013 draft's wording,
-- corrected: the real merged Bunny OCR Step 08 consumer does not write rows
-- there for SEND_DM, see this step's HANDOVER).
--
-- No surrogate PK: `(notification_id, channel)` is the natural, sufficient
-- primary key -- a notification structurally has at most one delivery
-- attempt row per channel (`createNotification`'s "create/ensure" language,
-- never a second row for a retried creation).
CREATE TABLE dashboard_notification_deliveries (
  notification_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  channel VARCHAR(16) NOT NULL,
  state VARCHAR(24) NOT NULL,
  operator_command_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  attempt_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  last_attempted_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (notification_id, channel),
  -- Pending-delivery reconciliation scan: "every DISCORD_DM row still
  -- PENDING, give me its operator_command_id" -- the watcher's one query.
  KEY ix_dashboard_notification_deliveries_pending (channel, state),
  CONSTRAINT fk_dashboard_notification_deliveries_notification
    FOREIGN KEY (notification_id) REFERENCES dashboard_notifications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
