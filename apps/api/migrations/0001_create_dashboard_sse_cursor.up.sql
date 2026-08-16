-- Dashboard-owned durable SSE watermark table (ADR-011, D-015, 25_DATA_MODEL.md
-- DASHBOARD-OWNED list, 26_REALTIME_SSE_AND_SYNC.md).
--
-- Tracks how far the internal SSE-fanout poller (apps/api/src/sse/poller.ts) has
-- progressed through each durable source table it watches, one row per
-- (source_table, cursor_key). This is the SERVER's own bookkeeping - NOT a
-- per-browser-connection store. A reconnecting browser's `Last-Event-ID` is
-- resolved against the poller's own durable progress here plus the source
-- table itself (real replay reads the source rows again, in order); this
-- table only ever needs to answer "where did the poller leave off."
--
-- `cursor_key` exists (rather than a single row per source_table) so a future
-- scale-out to multiple named consumers of the same source (29_PERFORMANCE_AND_SCALABILITY.md's
-- documented multi-instance escalation path) never needs a schema change -
-- Step 03's own single poller uses the fixed key 'sse_hub'
-- (apps/api/src/sse/poller.ts's SSE_HUB_CURSOR_KEY constant).
--
-- IMPLEMENTATION NOTE (not a correction to either frozen document -
-- IMPLEMENTATION/03_realtime_infrastructure.md only authorizes editing
-- 26_REALTIME_SSE_AND_SYNC.md's example if the TABLE NAME differs from
-- 25_DATA_MODEL.md's; it doesn't here - both name it `dashboard_sse_cursor`,
-- so neither frozen document was touched by Step 03):
-- 25_DATA_MODEL.md's one-line summary describes this table as a
-- "per-connection/per-source watermark" pruned "once older than the
-- replay-retention window," while 26_REALTIME_SSE_AND_SYNC.md's own operative
-- description calls it a table that "tracks the last-delivered sequence per
-- underlying source table." These two summaries emphasize the table
-- differently rather than actually conflicting on shape, and Step 03 treats
-- this as an underspecified implementation detail, not a contradiction to
-- resolve by editing either document. What this migration implements: a
-- small, bounded set of rows (one per registered source adapter x
-- cursor_key), continuously updated in place - never one row per ephemeral
-- browser connection, and therefore never needing age-based pruning. See the
-- Step-03 HANDOVER for the full rationale.
CREATE TABLE dashboard_sse_cursor (
  source_table VARCHAR(64) NOT NULL,
  cursor_key VARCHAR(64) NOT NULL,
  last_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (source_table, cursor_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
