-- TEST-ONLY fixture table, never applied by any real migration ledger (real
-- or fixture-runner) - proves the generic "durable source -> SSE" mechanism
-- (03_realtime_infrastructure.md: "demonstrates the pattern against a
-- synthetic test table ... clearly marked as a Step 03 test fixture, removed
-- before merge"). Applied directly by test setup code
-- (test/helpers/sseTestSource.ts), not through apps/api/migrations/ - so
-- there is nothing to "remove before merge": it was never part of any
-- mergeable ledger to begin with.
CREATE TABLE IF NOT EXISTS dashboard_sse_test_source (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  scope VARCHAR(64) NOT NULL,
  payload_json JSON NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
