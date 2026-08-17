-- Dashboard-owned server-side session store (ADR-011, ADR-020, 25_DATA_MODEL.md
-- DASHBOARD-OWNED list). Durable across `apps/api` restarts (ADR-020's explicit
-- fix for the legacy Bunny dashboard's in-memory MemoryStore defect).
--
-- `id` is the SHA-256 hash (hex) of the opaque, high-entropy (256-bit) session
-- token the browser holds in its `bcc_session` cookie -- the RAW token is never
-- persisted anywhere (25_DATA_MODEL.md: "id PK (opaque token hash, not the raw
-- token)"), so a database read (backup, replication, compromised read replica)
-- can never itself yield a usable session credential.
--
-- Two independent expiries back ADR-020's sliding/absolute TTL rule:
--   expires_at          -- the SLIDING window, pushed forward on every
--                          authenticated request (30 days from last activity).
--   absolute_expires_at -- fixed at creation (90 days from login), NEVER
--                          extended by activity -- forces full re-auth
--                          regardless of how active the session stays.
-- A session is valid only while `NOW() < expires_at AND NOW() < absolute_expires_at`.
CREATE TABLE dashboard_sessions (
  id CHAR(64) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  device_label VARCHAR(255) NULL,
  user_agent VARCHAR(512) NULL,
  ip_hash CHAR(64) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  last_seen_at DATETIME(6) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  absolute_expires_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_dashboard_sessions_user_id (user_id),
  KEY idx_dashboard_sessions_expires_at (expires_at),
  CONSTRAINT fk_dashboard_sessions_user_id FOREIGN KEY (user_id) REFERENCES dashboard_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
