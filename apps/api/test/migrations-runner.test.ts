/**
 * Proves the migration runner's mandatory Step-01 safety properties against
 * a REAL, disposable MySQL schema — never a mock
 * (00_GLOBAL_IMPLEMENTATION_RULES.md rejection criteria: "a mocked-DB
 * 'integration' test does not satisfy this step"). Uses an isolated fixture
 * directory copied into a temp dir per test, so the checksum-mismatch test
 * can safely mutate a file without ever touching a committed migration
 * (mission requirement: "Do not alter a committed real migration to perform
 * this test").
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runUp, runDown, LEDGER_TABLE } from "../migrations/runner.js";
import type { MigratorDbConfig } from "../migrations/config.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "migrations");

const ROOT_CONFIG: MigratorDbConfig = {
  host: process.env.TEST_MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.TEST_MYSQL_PORT ?? 33070),
  user: "root",
  password: process.env.TEST_MYSQL_ROOT_PASSWORD ?? "devrootpass",
  database: "", // set per-test via config.database below
};

const TEST_DB_NAME = "bunny_cc_migrator_unittest";

async function freshTestDatabase(): Promise<MigratorDbConfig> {
  const admin = await mysql.createConnection({
    host: ROOT_CONFIG.host,
    port: ROOT_CONFIG.port,
    user: ROOT_CONFIG.user,
    password: ROOT_CONFIG.password,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB_NAME}\``);
  await admin.query(`CREATE DATABASE \`${TEST_DB_NAME}\``);
  await admin.end();
  return { ...ROOT_CONFIG, database: TEST_DB_NAME };
}

function copyFixturesToTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "bunny-cc-migrations-test-"));
  cpSync(FIXTURES_DIR, dir, { recursive: true });
  return dir;
}

describe("migration runner (real MySQL)", () => {
  let config: MigratorDbConfig;
  let tempMigrationsDir: string;

  beforeEach(async () => {
    config = await freshTestDatabase();
    tempMigrationsDir = copyFixturesToTempDir();
  });

  afterAll(async () => {
    const admin = await mysql.createConnection({
      host: ROOT_CONFIG.host,
      port: ROOT_CONFIG.port,
      user: ROOT_CONFIG.user,
      password: ROOT_CONFIG.password,
    });
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB_NAME}\``);
    await admin.end();
  });

  it("A. APPLY: fresh DB -> migrations apply successfully, tables exist", async () => {
    const conn = await mysql.createConnection(config);
    try {
      const result = await runUp(conn, tempMigrationsDir, config);
      expect(result.ok).toBe(true);
      expect(result.applied).toEqual([
        "0001_create_dashboard_test_probe",
        "0002_add_dashboard_test_probe_note",
      ]);

      const [tables] = await conn.query<mysql.RowDataPacket[]>(
        "SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = ? AND table_name = 'dashboard_test_probe'",
        [config.database],
      );
      expect(tables).toHaveLength(1);

      interface VersionStateRow extends mysql.RowDataPacket {
        version: string;
        state: string;
      }
      const [ledgerRows] = await conn.query<VersionStateRow[]>(
        `SELECT version, state FROM ${LEDGER_TABLE} ORDER BY version`,
      );
      expect(ledgerRows.map((r) => [r.version, r.state])).toEqual([
        ["0001_create_dashboard_test_probe", "APPLIED"],
        ["0002_add_dashboard_test_probe_note", "APPLIED"],
      ]);
    } finally {
      await conn.end();
    }
  });

  it("B. IDEMPOTENT REAPPLY: running up again is a no-op, no duplicate, no corruption", async () => {
    const conn = await mysql.createConnection(config);
    try {
      const first = await runUp(conn, tempMigrationsDir, config);
      expect(first.ok).toBe(true);

      const second = await runUp(conn, tempMigrationsDir, config);
      expect(second.ok).toBe(true);
      expect(second.applied).toEqual([]);
      expect(second.skipped).toEqual([
        "0001_create_dashboard_test_probe",
        "0002_add_dashboard_test_probe_note",
      ]);

      interface CountRow extends mysql.RowDataPacket {
        count: number;
      }
      const [countRows] = await conn.query<CountRow[]>(`SELECT COUNT(*) as count FROM ${LEDGER_TABLE}`);
      expect(countRows[0]!.count).toBe(2);

      interface ColumnNameRow extends mysql.RowDataPacket {
        COLUMN_NAME: string;
      }
      const [columns] = await conn.query<ColumnNameRow[]>(
        "SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = ? AND table_name = 'dashboard_test_probe'",
        [config.database],
      );
      expect(columns.map((c) => c.COLUMN_NAME).sort()).toEqual(["id", "label", "note"]);
    } finally {
      await conn.end();
    }
  });

  it("C. CHECKSUM MISMATCH: an applied migration modified on disk is rejected, never silently re-applied", async () => {
    const conn = await mysql.createConnection(config);
    try {
      const first = await runUp(conn, tempMigrationsDir, config);
      expect(first.ok).toBe(true);

      // Mutate the FIXTURE COPY (never the committed file in test/fixtures/).
      const mutatedPath = path.join(tempMigrationsDir, "0001_create_dashboard_test_probe.up.sql");
      writeFileSync(
        mutatedPath,
        "CREATE TABLE dashboard_test_probe (\n  id INT NOT NULL AUTO_INCREMENT,\n" +
          "  label VARCHAR(64) NOT NULL,\n  injected_column VARCHAR(1) NULL,\n  PRIMARY KEY (id)\n" +
          ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n",
        "utf-8",
      );

      const second = await runUp(conn, tempMigrationsDir, config);
      expect(second.ok).toBe(false);
      expect(second.message).toMatch(/CHECKSUM MISMATCH/);
      expect(second.message).toMatch(/0001_create_dashboard_test_probe/);

      // Refusal must be total: migration 0002 (untouched, unrelated) must
      // NOT have been (re)applied by this failed run either.
      expect(second.applied).toEqual([]);
    } finally {
      await conn.end();
    }
  });

  it("down reverts applied migrations in reverse order (TEST/LOCAL_DISPOSABLE only, proven separately by config tests)", async () => {
    const conn = await mysql.createConnection(config);
    try {
      await runUp(conn, tempMigrationsDir, config);
      const result = await runDown(conn, tempMigrationsDir, config);
      expect(result.ok).toBe(true);
      expect(result.reverted).toEqual([
        "0002_add_dashboard_test_probe_note",
        "0001_create_dashboard_test_probe",
      ]);

      const [tables] = await conn.query<mysql.RowDataPacket[]>(
        "SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = ? AND table_name = 'dashboard_test_probe'",
        [config.database],
      );
      expect(tables).toHaveLength(0);
    } finally {
      await conn.end();
    }
  });
});
