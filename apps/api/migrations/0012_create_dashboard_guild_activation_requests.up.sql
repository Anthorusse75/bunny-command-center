-- Dashboard-owned, durable, IMMUTABLE approval snapshot (Step 10,
-- 25_DATA_MODEL.md DASHBOARD-OWNED list, IMPLEMENTATION/10_onboarding_approval.md,
-- DASHBOARD/10_GUILD_ONBOARDING_AND_APPROVAL.md §Approval workflow). Closes a
-- real TOCTOU gap: without this table, a Superadmin could review one guild
-- config state and approve a DIFFERENT one that was edited in the meantime,
-- with no durable record of which exact configuration was actually
-- reviewed. Every row is written once at `POST /api/guilds/:id/request-activation`
-- time and never mutated in place afterward except by the review decision
-- itself (`state`/`reviewed_by`/`reviewed_at`/`decision_reason`, written
-- EXACTLY ONCE per row -- a re-submission after edits always creates a NEW
-- row, per the doc's explicit "never mutates an existing one" rule).
--
-- `request_id` is CHAR(26), the same time-sortable ULID convention as
-- dashboard_notifications.id (apps/api/src/notifications/id.ts) -- this
-- table's business identity is the request itself, addressed directly in
-- the approve/reject/request-changes route paths
-- (`POST /api/admin/activation-requests/:requestId/...`) specifically so
-- those actions are NEVER addressable by guildId alone (the TOCTOU gap this
-- design exists to close -- IMPLEMENTATION/10_onboarding_approval.md's
-- REJECTION CRITERIA: "any approval action addressable by guildId alone").
--
-- `guild_id` is VARCHAR(24) -- same Snowflake-precision / value-reference-only
-- rationale as every other guild_id column in this ledger (no FK: SHARED
-- `guilds` lives in a different ownership domain, ADR-011/ADR-019).
--
-- `submitted_config_version_id` is a value-reference (NOT a physical FK --
-- same ownership-boundary rule) into the SHARED `guild_configuration_versions.id`
-- (BIGINT UNSIGNED AUTO_INCREMENT there, so the same integer type is used
-- here -- unlike a Discord snowflake, this is an internal DB sequence with
-- no Number()-precision risk).
--
-- `submitted_config_checksum` mirrors `guild_configuration_versions.checksum`'s
-- own real column type (`BINARY(32)`, verified against the live migrated
-- schema) -- re-verified at approval time even if the referenced version
-- row were somehow mutated out-of-band (defense in depth,
-- IMPLEMENTATION/10_onboarding_approval.md: "approve re-verifies
-- submitted_config_checksum still matches the referenced version before
-- flipping guilds.lifecycle_state").
--
-- `requested_by`/`reviewed_by` are Discord user ids -- VARCHAR(24), same
-- Snowflake-precision rationale, never numeric.
--
-- `state` is validated at the application layer against the fixed enum
-- (`PENDING`/`CHANGES_REQUESTED`/`APPROVED`/`REJECTED`) before any write --
-- free VARCHAR here (not an SQL ENUM) matches this ledger's existing
-- convention (e.g. `guilds.lifecycle_state`, `dashboard_notification_deliveries.state`),
-- keeping every enum change purely additive at the schema level.
CREATE TABLE dashboard_guild_activation_requests (
  request_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  guild_id VARCHAR(24) NOT NULL,
  submitted_config_version_id BIGINT UNSIGNED NOT NULL,
  submitted_config_checksum BINARY(32) NOT NULL,
  requested_by VARCHAR(24) NOT NULL,
  requested_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  state VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  reviewed_by VARCHAR(24) NULL,
  reviewed_at DATETIME(6) NULL,
  decision_reason VARCHAR(2000) NULL,
  PRIMARY KEY (request_id),
  -- "Pending guilds" review console listing (Step 11) + this step's own
  -- "does this guild already have a non-terminal request" checks (re-submission
  -- flow: the OLD row is left in its terminal/superseded state, never
  -- mutated -- this index is what makes finding "the current open one, if
  -- any" for a guild cheap).
  KEY ix_dashboard_guild_activation_requests_guild_state (guild_id, state, requested_at),
  KEY ix_dashboard_guild_activation_requests_state_requested (state, requested_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
