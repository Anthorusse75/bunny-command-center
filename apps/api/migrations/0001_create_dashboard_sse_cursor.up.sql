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
-- ARCHITECTURE ERRATUM (2026-08-16, reviewer-authorized - correctness
-- review's item 9). 25_DATA_MODEL.md's ORIGINAL one-line summary described
-- this table as a "per-connection/per-source watermark" pruned "once older
-- than the replay-retention window." That was a genuine documentary
-- CONTRADICTION, not merely an underspecified detail - it directly conflicts
-- with 26_REALTIME_SSE_AND_SYNC.md's own operative description, which is
-- authoritative for this table's mechanism ("a lightweight internal poller
-- ... watches [sources] for rows newer than the last-seen watermark" /
-- "the durable watermark table ... tracks the last-delivered sequence per
-- underlying source table" - a SERVER-SIDE consumer watermark, never one row
-- per browser connection, and therefore never needing age-based pruning).
-- 25_DATA_MODEL.md's own listed key columns already contradicted its own
-- prose too: `source_table` + `cursor_key` alone, no connection identifier
-- of any kind. IMPLEMENTATION/03_realtime_infrastructure.md's own clause
-- ("if the name differs ... update that document's example to match, and
-- note the correction in the handover") only literally covers a TABLE NAME
-- mismatch (there wasn't one - both docs already agreed on
-- `dashboard_sse_cursor`), so this correction went one step further than
-- that clause's letter, under EXPLICIT reviewer authorization granted for
-- this exact narrow case (see Step-03 HANDOVER) rather than under that
-- clause alone. 25_DATA_MODEL.md's row was corrected to match; nothing else
-- in either frozen document was touched. What this migration implements: a
-- small, bounded set of rows (one per registered source adapter x
-- cursor_key), continuously updated in place - never one row per ephemeral
-- browser connection.
CREATE TABLE dashboard_sse_cursor (
  source_table VARCHAR(64) NOT NULL,
  cursor_key VARCHAR(64) NOT NULL,
  last_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (source_table, cursor_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
