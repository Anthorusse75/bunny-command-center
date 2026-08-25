-- Dashboard-owned cross-feature audit trail (Step 10, 25_DATA_MODEL.md
-- DASHBOARD-OWNED list, IMPLEMENTATION/10_onboarding_approval.md,
-- 30_OBSERVABILITY_AND_AUDIT.md §Audit trail: "WHO / WHAT / WHEN / GUILD /
-- BEFORE / AFTER / CORRELATION / RESULT"). This is the FIRST writer of this
-- table (Step 10) -- every later step's sensitive mutation (config version
-- activation, quota change, admin override toggle, ...) reuses this SAME
-- table rather than inventing a parallel one, per 30_OBSERVABILITY_AND_AUDIT.md's
-- own table.
--
-- `id` is BIGINT UNSIGNED AUTO_INCREMENT (not a CHAR26 ULID like
-- dashboard_notifications) -- this table is never cursor-paginated by a
-- caller-facing API in this step's scope (it is an operator/debugging trail,
-- 30_OBSERVABILITY_AND_AUDIT.md's "append-only ... mirrors the existing
-- configuration_audit_events/operator_command_events convention", both of
-- which use a surrogate/CHAR26 id with no client-facing cursor contract
-- either); a plain AUTO_INCREMENT is the simplest correct choice absent a
-- documented pagination requirement.
--
-- `actor_user_id` REFERENCES dashboard_users.id (internal surrogate PK,
-- same convention as dashboard_notifications.user_id) -- NULLABLE because a
-- future automated/system-triggered audit row (no human actor) must not be
-- forced to fabricate one; every actor this step itself writes IS a real
-- human (Guild Admin/Superadmin), never null, but the column is not
-- artificially constrained to this step's own writers.
--
-- `guild_id` is VARCHAR(24), deliberately NOT numeric -- same Snowflake-precision
-- rationale as every other guild_id-shaped column in this ledger (migrations
-- 0004/0006/0007/0008's header comments) -- value-reference only, no FK
-- (Dashboard-owned table, SHARED `guilds` row lives in a different ownership
-- domain -- 00_GLOBAL_IMPLEMENTATION_RULES.md rule 11 / ADR-011 / ADR-019:
-- no DB-level FK ever crosses an ownership-domain boundary).
--
-- `before_json`/`after_json` are NULLABLE JSON -- not every audited action
-- has a meaningful "before" (e.g. the very first activation request has no
-- prior state to snapshot) or "after" (e.g. a rejection with no lifecycle
-- write attached beyond the request's own state).
--
-- `result` is a short outcome tag (`SUCCESS`/`REJECTED`/...) -- free text,
-- not an enum CHECK, matching this table's cross-feature/future-proof role
-- (30_OBSERVABILITY_AND_AUDIT.md's table lists a wide, growing action set
-- this migration must not have to be re-altered for).
CREATE TABLE dashboard_audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_user_id BIGINT UNSIGNED NULL,
  action VARCHAR(64) NOT NULL,
  guild_id VARCHAR(24) NULL,
  before_json JSON NULL,
  after_json JSON NULL,
  correlation_id VARCHAR(64) NULL,
  result VARCHAR(32) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  -- Per-guild audit history (Superadmin review console, Step 11), newest first.
  KEY ix_dashboard_audit_log_guild_created (guild_id, created_at, id),
  -- Per-actor audit history + cross-service correlation trace lookups
  -- (30_OBSERVABILITY_AND_AUDIT.md §Correlation IDs across the 3 services).
  KEY ix_dashboard_audit_log_actor_created (actor_user_id, created_at, id),
  KEY ix_dashboard_audit_log_correlation (correlation_id),
  CONSTRAINT fk_dashboard_audit_log_actor
    FOREIGN KEY (actor_user_id) REFERENCES dashboard_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
