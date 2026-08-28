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
-- own UI/progress state (never a second copy of real bot config).
--
-- ** RECLASSIFIED (Step 10 external-review correction round, Section 6) **:
-- `sections_json` is TRANSIENT, PARTIAL-FORM-STATE ONLY -- it MAY continue
-- to hold a section's value ONLY for as long as that section's real
-- destination table/column set is not yet determinable (the ordering
-- problem this migration's own header explains below, e.g. a NOT NULL
-- sub-table column another not-yet-saved section still needs). The moment a
-- section's real destination becomes determinable, its value MUST
-- materialize into that real destination immediately on save -- this table
-- is never again this step's FINAL business-config store for it. Concretely
-- (post-correction-round): "Notifications" now materializes on every save
-- into the real, Dashboard-owned `dashboard_guild_notification_defaults`
-- table (migration 0015) -- the `notification_policy_json` shape this
-- comment originally described as "EXPLICITLY PROVISIONAL" no longer exists
-- as this section's real store; "Season & quotas" materializing into the
-- real `guild_config_selfbot.nb_*`/`guild_season_plans` columns is Section
-- 9 of this same correction round. This paragraph corrects the PRIOR
-- version of this comment, which incorrectly framed this table as an
-- acceptable final store for those two sections.
--
-- `sections_json` still holds the persistent per-section checklist state
-- (section key -> {completedAt, ...}) for every section -- one flexible
-- JSON column rather than seven near-duplicate nullable-timestamp columns
-- that would all need the exact same read/write pattern, matching this
-- codebase's existing precedent for this shape of data
-- (`hero_discovery_config`'s threshold fields aside, compare
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
