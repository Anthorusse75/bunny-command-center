/**
 * Dedicated bootstrap for the real-browser Playwright E2E suite
 * (apps/web/playwright.config.ts, apps/web/e2e/realtime.spec.ts).
 *
 * This is the ONE place the Step-03 synthetic test source adapter is wired
 * into a REAL, listening `apps/api` process - never into the process
 * `apps/api/src/server.ts` builds for production or for the Vitest
 * integration suite (which registers its own adapters per-test via
 * `apps/api/test/helpers/sseTestSource.ts` against an isolated database).
 * Living under `scripts/` (not `src/`) keeps the one-way dependency rule
 * intact (`src/` never imports from `scripts/` or `test/`) while still being
 * allowed to import test helpers itself.
 *
 * mission §35/§9: this is real production code (`buildServer`, the real
 * poller, the real SSE route) with ONE test-only DB-level seam registered at
 * startup - never an HTTP-reachable debug endpoint. The E2E test drives it
 * exclusively by inserting rows directly into `dashboard_sse_test_source`
 * (the same durable-DB-mutation entrypoint the Step-03 spec's own PROOF OF
 * WIRING section names) and by observing the real SSE stream / real
 * `apps/web` UI - never a debug HTTP call into this process.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import mysql from "mysql2/promise";
import { buildServer } from "../src/server.js";
import type { AppConfig } from "../src/config.js";
import { runUp } from "../migrations/runner.js";
import type { MigratorDbConfig } from "../migrations/config.js";
import { registerEventType, registerSourceAdapter } from "../src/sse/registry.js";

// apps/api/test/helpers is allowed to be imported from scripts/ (only src/ is restricted).
import {
  TEST_EVENT_TYPE,
  createTestSourceAdapter,
  createTestSourceSchema,
  testEventDataSchema,
} from "../test/helpers/sseTestSource.js";

const REAL_MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable for the E2E server: ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  // Two DB identities, matching the production/CI separation convention
  // (migrations/README.md): a DDL-privileged account for migrations/fixture
  // setup, and a narrower runtime account for the app pool. Both may point
  // at the same throwaway local/CI-only database.
  const migratorConfig: MigratorDbConfig = {
    host: process.env["MIGRATOR_DB_HOST"] ?? required("DB_HOST"),
    port: Number(process.env["MIGRATOR_DB_PORT"] ?? process.env["DB_PORT"] ?? 3306),
    user: process.env["MIGRATOR_DB_USER"] ?? required("DB_USER"),
    password: process.env["MIGRATOR_DB_PASSWORD"] ?? required("DB_PASSWORD"),
    database: process.env["MIGRATOR_DB_NAME"] ?? required("DB_NAME"),
  };
  const dbConfig: MigratorDbConfig = {
    host: required("DB_HOST"),
    port: Number(process.env["DB_PORT"] ?? 3306),
    user: required("DB_USER"),
    password: required("DB_PASSWORD"),
    database: required("DB_NAME"),
  };

  // Ensures the Dashboard migration ledger (dashboard_sse_cursor) and the
  // synthetic test source fixture table both exist before the server starts
  // accepting connections - real DDL, the same runner CI/integration tests
  // use, never ad hoc SQL against a table the server will actually query.
  const conn = await mysql.createConnection(migratorConfig);
  try {
    const migrationResult = await runUp(conn, REAL_MIGRATIONS_DIR, migratorConfig);
    if (!migrationResult.ok) {
      throw new Error(`E2E server: Dashboard migration failed: ${migrationResult.message}`);
    }
    await createTestSourceSchema(conn);
  } finally {
    await conn.end();
  }

  registerEventType({ type: TEST_EVENT_TYPE, schema: testEventDataSchema });
  const pool = mysql.createPool(dbConfig);
  registerSourceAdapter(createTestSourceAdapter(pool));

  const config: AppConfig = {
    port: Number(process.env["PORT"] ?? 8090),
    logLevel: process.env["LOG_LEVEL"] ?? "info",
    appVersion: "0.1.0-e2e",
    db: dbConfig,
    sse: {
      // Fast intervals so the E2E suite doesn't need long waits for the
      // real poller/heartbeat to do their thing.
      heartbeatSeconds: Number(process.env["SSE_HEARTBEAT_SECONDS"] ?? 2),
      pollIntervalMs: Number(process.env["SSE_POLL_INTERVAL_MS"] ?? 200),
      maxQueuedFramesPerConnection: 200,
      maxRowsPerSourcePerTick: 500,
    },
  };

  const fastify = await buildServer(config);
  await fastify.listen({ port: config.port, host: "127.0.0.1" });
  console.log(`[e2e-server] listening on http://127.0.0.1:${config.port}`);
}

void main();
