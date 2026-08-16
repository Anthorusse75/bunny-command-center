/**
 * The ONE synthetic source adapter Step 03 uses to prove the generic
 * "durable DB change -> poller -> SSE -> client" mechanism end-to-end
 * (03_realtime_infrastructure.md §PROOF OF WIRING). Lives entirely under
 * test/ - apps/api/src/ never imports anything from this file (the
 * dependency direction rule in the practical notes: "apps/api/src/ must
 * never import from migrations/, test/, or scripts/").
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Connection } from "mysql2/promise";
import type { Pool } from "mysql2/promise";
import { z } from "zod";
import { STEP_03_TEST_SCOPE } from "@bunny-command-center/shared";
import type { SourceAdapter, SourceRow } from "../../src/sse/types.js";

export const TEST_SOURCE_TABLE = "dashboard_sse_test_source";
export const TEST_SOURCE_INDEX = 1;
export const TEST_EVENT_TYPE = "dashboard.sse_test_probe_changed";

export const testEventDataSchema = z.object({ label: z.string() }).strict();

const FIXTURE_SQL_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "sse",
  "dashboard_sse_test_source.sql",
);

export async function createTestSourceSchema(conn: Connection): Promise<void> {
  const sql = readFileSync(FIXTURE_SQL_PATH, "utf-8");
  await conn.query(sql);
}

export async function insertTestRow(
  conn: Connection,
  label: string,
  scope: string = STEP_03_TEST_SCOPE,
): Promise<number> {
  const [result] = await conn.query<import("mysql2").ResultSetHeader>(
    `INSERT INTO ${TEST_SOURCE_TABLE} (scope, payload_json) VALUES (?, ?)`,
    [scope, JSON.stringify({ label })],
  );
  return result.insertId;
}

export async function deleteTestRowsUpTo(conn: Connection, maxIdInclusive: number): Promise<void> {
  await conn.query(`DELETE FROM ${TEST_SOURCE_TABLE} WHERE id <= ?`, [maxIdInclusive]);
}

interface TestSourceRow {
  id: number;
  scope: string;
  payload_json: string;
  created_at: Date;
}

export function createTestSourceAdapter(pool: Pool): SourceAdapter {
  return {
    sourceTable: TEST_SOURCE_TABLE,
    sourceIndex: TEST_SOURCE_INDEX,
    async fetchSince(sinceOrdinal, limit): Promise<SourceRow[]> {
      const [rows] = await pool.query<(TestSourceRow & import("mysql2").RowDataPacket)[]>(
        `SELECT id, scope, payload_json, created_at FROM ${TEST_SOURCE_TABLE} WHERE id > ? ORDER BY id ASC LIMIT ?`,
        [sinceOrdinal, limit],
      );
      return rows.map((row) => ({
        ordinal: row.id,
        eventType: TEST_EVENT_TYPE,
        scope: row.scope as SourceRow["scope"],
        data: (typeof row.payload_json === "string"
          ? JSON.parse(row.payload_json)
          : row.payload_json) as unknown,
        occurredAt: row.created_at,
      }));
    },
    async oldestAvailableOrdinal(): Promise<number | null> {
      const [rows] = await pool.query<({ minId: number | null } & import("mysql2").RowDataPacket)[]>(
        `SELECT MIN(id) as minId FROM ${TEST_SOURCE_TABLE}`,
      );
      return rows[0]?.minId ?? null;
    },
  };
}
