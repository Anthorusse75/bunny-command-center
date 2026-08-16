import { sql, type Kysely } from "kysely";
import type { DB } from "../db/codegen-types.js";

/**
 * Durable per-(source_table, cursor_key) watermark repository
 * (dashboard_sse_cursor, migration 0001). Used by the poller
 * (apps/api/src/sse/poller.ts) to know where it left off for each
 * registered source adapter, and to survive a process restart without
 * re-scanning a source table from its beginning.
 *
 * `advance` is a SINGLE atomic `INSERT ... ON DUPLICATE KEY UPDATE
 * last_sequence = GREATEST(...)` statement - not a read-then-write pair -
 * satisfying 03_realtime_infrastructure.md's concurrency requirement
 * ("design the watermark advancement to be safe under concurrent pollers
 * now ... using an atomic conditional update pattern, not a read-then-write
 * race") even though this mission's actual deployment is single-instance.
 * `GREATEST` also guarantees the watermark can never silently regress if two
 * callers race with different values (mission §51: "cursor regression
 * cannot silently move backward").
 */
export interface SseCursorRepo {
  getLastSequence(sourceTable: string, cursorKey: string): Promise<number>;
  advance(sourceTable: string, cursorKey: string, newSequence: number): Promise<void>;
}

export function createSseCursorRepo(db: Kysely<DB>): SseCursorRepo {
  return {
    async getLastSequence(sourceTable, cursorKey) {
      const row = await db
        .selectFrom("dashboard_sse_cursor")
        .select("last_sequence")
        .where("source_table", "=", sourceTable)
        .where("cursor_key", "=", cursorKey)
        .executeTakeFirst();
      return row ? Number(row.last_sequence) : 0;
    },

    async advance(sourceTable, cursorKey, newSequence) {
      await db
        .insertInto("dashboard_sse_cursor")
        .values({ source_table: sourceTable, cursor_key: cursorKey, last_sequence: newSequence })
        .onDuplicateKeyUpdate({
          last_sequence: sql`GREATEST(last_sequence, VALUES(last_sequence))`,
        })
        .execute();
    },
  };
}
