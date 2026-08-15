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
-- CORRECTION vs 25_DATA_MODEL.md's summary table, noted per
-- IMPLEMENTATION/03_realtime_infrastructure.md's explicit instruction ("if the
-- name differs from what's shown in 26_REALTIME_SSE_AND_SYNC.md, update that
-- document's example to match, and note the correction in the handover"):
-- 25_DATA_MODEL.md's one-line summary calls this a "per-connection/per-source
-- watermark" and says rows are "pruned once older than the replay-retention
-- window." 26_REALTIME_SSE_AND_SYNC.md's own operative description ("tracks
-- the last-delivered sequence per underlying source table") is authoritative
-- here and is what this migration implements: a small, bounded set of rows
-- (one per registered source adapter x cursor_key), continuously updated in
-- place, never one row per ephemeral browser connection and therefore never
-- needing age-based pruning. See the Step-03 HANDOVER for the full rationale.
CREATE TABLE dashboard_sse_cursor (
  source_table VARCHAR(64) NOT NULL,
  cursor_key VARCHAR(64) NOT NULL,
  last_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (source_table, cursor_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
