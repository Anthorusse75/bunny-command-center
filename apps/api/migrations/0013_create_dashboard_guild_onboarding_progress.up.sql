-- Dashboard-owned onboarding-stepper progress tracker (Step 10,
-- IMPLEMENTATION/10_onboarding_approval.md, SCREENS/ONBOARDING.md).
--
-- ** Explicit, disclosed scope decision (00_GLOBAL_IMPLEMENTATION_RULES.md
-- rule 1: "if you find yourself tempted to simplify ... stop and say so
-- explicitly") **: 25_DATA_MODEL.md does not list a dedicated table for the
-- onboarding stepper's own progress/checklist state, because most of the 7
-- sections' real data already lives in the SHARED `guild_config_bunny`/
-- `guild_config_selfbot` sub-tables (incoming/hero/community channel) or an
-- EXISTING Dashboard-owned table (`dashboard_guild_policy.admin_role_discord_id`,
-- migration 0004). Two things, however, have no existing documented home:
--   (a) "Bunny & permissions" section completion is a LIVE Discord
--       permission check, not a stored config value at all -- there is
--       nothing to persist there except a completion marker.
--   (b) "Notifications" section's "guild's default notification policy"
--       (10_GUILD_ONBOARDING_AND_APPROVAL.md step 6, referencing
--       18_NOTIFICATIONS_AND_DISCORD_DM.md) has no per-GUILD policy table --
--       18_NOTIFICATIONS_AND_DISCORD_DM.md's `dashboard_notification_preferences`
--       (migration 0010) is PER-USER only, keyed on `dashboard_users.id`,
--       with no guild scope whatsoever.
-- Rather than silently inventing per-guild rows in the per-USER preferences
-- table (which would be a real, silent schema-meaning change to an existing
-- table outside this step's own ownership) or blocking this step entirely
-- on a cross-step design question, this migration adds ONE new, narrowly-scoped,
-- genuinely Dashboard-owned table that holds exactly the onboarding-stepper's
-- own UI/progress state (never a second copy of real bot config) --
-- `notification_policy_json`'s value is EXPLICITLY PROVISIONAL, flagged in
-- this step's HANDOVER for Step 09/12's owner to ratify or move to a
-- permanent home, mirroring this project's own established precedent for a
-- disclosed cross-step deviation (Step 08's SEND_DM payload_json shape,
-- 09_notifications_system.md HANDOVER).
--
-- `sections_json` holds the persistent per-section checklist state
-- (section key -> {completedAt, ...}) PLUS the two provisional/no-column
-- values above -- one flexible JSON column rather than seven near-duplicate
-- nullable-timestamp columns that would all need the exact same read/write
-- pattern, matching this codebase's existing precedent for this shape of
-- data (`hero_discovery_config`'s threshold fields aside, compare
-- `guild_config_orchestrator.decision_rules_json`,
-- `hero_discovery_candidates`... `criteria_json`).
--
-- `guild_id` is VARCHAR(24) -- same Snowflake-precision / value-reference-only
-- rationale as every other guild_id column in this ledger (no FK: the guild
-- itself is a SHARED-table concept, ADR-011/ADR-019).
--
-- `draft_config_version_id` is a value-reference (no physical FK, same
-- ownership-boundary rule) into the SHARED `guild_configuration_versions.id`
-- currently being edited as this guild's onboarding DRAFT -- NULL until the
-- guild's first section save (permission-matrix row `DISCOVERED`: "starts
-- CONFIGURING on first edit").
CREATE TABLE dashboard_guild_onboarding_progress (
  guild_id VARCHAR(24) NOT NULL,
  draft_config_version_id BIGINT UNSIGNED NULL,
  sections_json JSON NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (guild_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
