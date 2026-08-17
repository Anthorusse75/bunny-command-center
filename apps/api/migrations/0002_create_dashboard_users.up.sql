-- Dashboard-owned user identity table (ADR-011, 25_DATA_MODEL.md DASHBOARD-OWNED
-- list, IMPLEMENTATION/04_discord_oauth_sessions.md). One row per Discord user who
-- has ever completed the OAuth login flow, keyed by their real, OAuth-verified
-- Discord user ID -- never a client-editable/self-reported field (07_DISCORD_OAUTH.md,
-- 27_SECURITY.md's "unverified self-reported Discord ID" defect this design closes).
--
-- discord_access_token_enc / discord_refresh_token_enc hold the Discord OAuth
-- grant ENCRYPTED AT REST (application-level AES-256-GCM, ADR-020) -- the
-- plaintext token value never touches this table, never appears in a query log,
-- and is decrypted only in-process, only when a server-side Discord API call
-- needs it (07_DISCORD_OAUTH.md §Discord token refresh). discord_token_expires_at
-- tracks the ACCESS token's expiry (not the refresh token, which Discord does not
-- expire on a fixed schedule) so a refresh can be attempted proactively as well as
-- reactively on a 401.
--
-- discord_user_id is VARCHAR, deliberately NOT a numeric type (correction,
-- 2026-08-16): Discord's HTTP API always serializes Snowflake IDs as JSON
-- strings specifically because they are up to 64 bits and cannot be
-- represented exactly by IEEE-754 doubles (JavaScript's only number type) --
-- values above Number.MAX_SAFE_INTEGER (2^53-1, 16 digits; real snowflakes
-- are commonly 18-19 digits) silently lose precision under ANY numeric
-- conversion. A BIGINT UNSIGNED column would store the exact value in MySQL
-- itself, but every read through this application's stack (mysql2's default
-- BIGINT-to-JS-number coercion, Kysely's generated types) would still
-- silently round it back down to an inexact JS number on the way OUT --
-- which is exactly the class of defect that could let two DIFFERENT
-- Discord accounts collide onto the SAME dashboard identity once their IDs
-- differ only past the 16th significant digit. VARCHAR(24) (real snowflakes
-- top out at 19-20 digits; generous headroom) sidesteps the entire class of
-- risk: strings round-trip through MySQL/mysql2/Kysely/JSON exactly, always,
-- with zero special driver configuration required anywhere in this codebase.
CREATE TABLE dashboard_users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  discord_user_id VARCHAR(24) NOT NULL,
  username VARCHAR(64) NOT NULL,
  avatar_hash VARCHAR(64) NULL,
  locale VARCHAR(8) NOT NULL DEFAULT 'en',
  theme_name VARCHAR(32) NOT NULL DEFAULT 'fusion',
  theme_mode VARCHAR(16) NOT NULL DEFAULT 'system',
  discord_access_token_enc VARBINARY(2048) NULL,
  discord_refresh_token_enc VARBINARY(2048) NULL,
  discord_token_expires_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_dashboard_users_discord_user_id (discord_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
