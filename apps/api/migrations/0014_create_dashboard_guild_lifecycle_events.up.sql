-- Dashboard-owned, append-only guild lifecycle-transition event log (Step 10
-- correction round, Gap 3 — the original brief required a
-- `guild_lifecycle_state_changed` SSE source adapter, mirroring migration
-- 0008's `dashboard_notifications.sse_seq` pattern exactly, never a ULID's
-- lexical order (`apps/api/src/sse/types.ts`'s strict `SourceRow.ordinal`
-- contract: "the source table's own durable, strictly-increasing,
-- restart-safe key").
--
-- This table is Dashboard-owned (unlike the SHARED `guilds` table itself),
-- so real cross-table atomicity with the `guilds` UPDATE IS achievable here
-- (`lifecycleRepo.ts`'s guarded lifecycle-transition writer inserts one row
-- here in the SAME transaction as that UPDATE) — unlike the shared `guilds`
-- table + `createNotification()` case (`activationRequestsService.ts`'s own
-- header comment), which cannot share a transaction across two independently
-- transaction-opening modules.
--
-- `guild_id` is VARCHAR(24), same Snowflake-precision/value-reference-only
-- rationale as every other guild_id column in this Dashboard-owned ledger
-- (no FK — the guild itself is a SHARED-table concept, ADR-011/ADR-019).
--
-- `lifecycle_state`/`previous_state` are free VARCHAR(24), validated at the
-- application layer against `stateMachine.ts`'s fixed `LIFECYCLE_STATES`
-- enum before any write — same convention as `guilds.lifecycle_state`
-- itself (10_GUILD_ONBOARDING_AND_APPROVAL.md: "a value outside that enum is
-- rejected before it reaches the database").
--
-- `occurred_at` mirrors `dashboard_notifications.created_at`'s naming/shape
-- (`DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6)`) — the SSE adapter's
-- `SourceRow.occurredAt` field.
CREATE TABLE dashboard_guild_lifecycle_events (
  -- Correction #6-style durable SSE fan-out ordinal (migration 0008's own
  -- header comment has the full rationale for why this must be a real
  -- AUTO_INCREMENT column, never derived from a ULID or any other
  -- process-local/time-based value) — also this table's PRIMARY KEY, since
  -- (unlike dashboard_notifications, whose real business identity is its
  -- own CHAR26 `id`) this table has no other natural business key: it is a
  -- pure, append-only event log.
  sse_seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  guild_id VARCHAR(24) NOT NULL,
  lifecycle_state VARCHAR(24) NOT NULL,
  previous_state VARCHAR(24) NOT NULL,
  occurred_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (sse_seq),
  -- Supports a future "this guild's lifecycle history" listing without a
  -- full table scan — not currently used by any route, added defensively
  -- (mirrors `dashboard_guild_activation_requests`'s own guild_id index).
  KEY ix_dashboard_guild_lifecycle_events_guild (guild_id, sse_seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
