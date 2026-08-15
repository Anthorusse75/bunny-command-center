/**
 * Real-MySQL proof of dashboard_sse_cursor's durability and atomic
 * advancement (mission §31: "test the actual cursor repository with real
 * MySQL: insert/update/read/restart-equivalent behavior"). Builds a fresh
 * schema per test run from the REAL committed migration 0001, never a mock.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { Kysely, MysqlDialect } from "kysely";
import { createPool } from "mysql2";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runUp } from "../migrations/runner.js";
import type { MigratorDbConfig } from "../migrations/config.js";
import { createSseCursorRepo } from "../src/sse/cursorRepo.js";
import type { DB } from "../src/db/codegen-types.js";

const ROOT_CONFIG = {
  host: process.env.TEST_MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.TEST_MYSQL_PORT ?? 33070),
  user: "root",
  password: process.env.TEST_MYSQL_ROOT_PASSWORD ?? "devrootpass",
};

const TEST_DB_NAME = "bunny_cc_sse_cursor_test";
const REAL_MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

async function freshDatabase(): Promise<MigratorDbConfig> {
  const admin = await mysql.createConnection(ROOT_CONFIG);
  await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB_NAME}\``);
  await admin.query(`CREATE DATABASE \`${TEST_DB_NAME}\``);
  await admin.end();
  const config: MigratorDbConfig = { ...ROOT_CONFIG, database: TEST_DB_NAME };
  const conn = await mysql.createConnection(config);
  try {
    const result = await runUp(conn, REAL_MIGRATIONS_DIR, config);
    if (!result.ok) {
      throw new Error(`migration failed: ${result.message}`);
    }
  } finally {
    await conn.end();
  }
  return config;
}

describe("dashboard_sse_cursor repository (real MySQL)", () => {
  let db: Kysely<DB>;

  beforeAll(async () => {
    const config = await freshDatabase();
    db = new Kysely<DB>({
      dialect: new MysqlDialect({
        pool: createPool({
          host: config.host,
          port: config.port,
          user: config.user,
          password: config.password,
          database: config.database,
        }),
      }),
    });
  });

  afterAll(async () => {
    await db.destroy();
    const admin = await mysql.createConnection(ROOT_CONFIG);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB_NAME}\``);
    await admin.end();
  });

  it("getLastSequence returns 0 for a source/cursor pair that has never been written", async () => {
    const repo = createSseCursorRepo(db);
    expect(await repo.getLastSequence("no_such_source", "sse_hub")).toBe(0);
  });

  it("advance() then getLastSequence() round-trips (insert path)", async () => {
    const repo = createSseCursorRepo(db);
    await repo.advance("source_a", "sse_hub", 42);
    expect(await repo.getLastSequence("source_a", "sse_hub")).toBe(42);
  });

  it("advance() with a higher value moves the watermark forward (update path)", async () => {
    const repo = createSseCursorRepo(db);
    await repo.advance("source_b", "sse_hub", 10);
    await repo.advance("source_b", "sse_hub", 25);
    expect(await repo.getLastSequence("source_b", "sse_hub")).toBe(25);
  });

  it("advance() with a LOWER value never regresses the watermark (mission §51)", async () => {
    const repo = createSseCursorRepo(db);
    await repo.advance("source_c", "sse_hub", 100);
    await repo.advance("source_c", "sse_hub", 3);
    expect(await repo.getLastSequence("source_c", "sse_hub")).toBe(100);
  });

  it("distinct cursor_key values under the same source_table are independent", async () => {
    const repo = createSseCursorRepo(db);
    await repo.advance("source_d", "consumer_1", 5);
    await repo.advance("source_d", "consumer_2", 999);
    expect(await repo.getLastSequence("source_d", "consumer_1")).toBe(5);
    expect(await repo.getLastSequence("source_d", "consumer_2")).toBe(999);
  });

  it("survives a repository re-creation against the same durable DB (restart-equivalent)", async () => {
    const repo1 = createSseCursorRepo(db);
    await repo1.advance("source_restart", "sse_hub", 77);

    // A brand-new repo instance (simulates a fresh process) sees the same
    // durable value - the watermark lives in MySQL, never process memory.
    const repo2 = createSseCursorRepo(db);
    expect(await repo2.getLastSequence("source_restart", "sse_hub")).toBe(77);
  });

  it("concurrent advances race-safely converge to the maximum value (atomic conditional update, mission concurrency requirement)", async () => {
    const repo = createSseCursorRepo(db);
    await Promise.all([
      repo.advance("source_concurrent", "sse_hub", 5),
      repo.advance("source_concurrent", "sse_hub", 50),
      repo.advance("source_concurrent", "sse_hub", 30),
      repo.advance("source_concurrent", "sse_hub", 12),
    ]);
    // Regardless of arrival order, the highest value submitted always wins -
    // proves the update is a real atomic GREATEST(), not a racy read-modify-write.
    expect(await repo.getLastSequence("source_concurrent", "sse_hub")).toBe(50);
  });
});
