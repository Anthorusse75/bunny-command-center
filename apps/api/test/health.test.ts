/**
 * Proves /healthz and /readyz against a REAL MySQL instance in both the
 * positive AND negative case (mission §16/§20: "do NOT simulate DB failure
 * by mocking the readiness function"). Uses Fastify's .inject() rather than
 * a bound port - inject() still runs the full route handler, including the
 * real mysql2 connection attempt in readiness.ts.
 *
 * Step 10 post-merge correction: /readyz now also gates on the SHARED,
 * Self-bot-owned `schema_migrations` ledger (sharedSchemaCompat.ts) - the
 * real table shape below is copied verbatim from
 * `vendor/self-bot-schema/database/migrate.py`'s own `SCHEMA_MIGRATIONS_DDL`
 * (never a fake shape that happens to differ), so these tests seed exactly
 * the rows the real Self-bot migrator would produce, not an invented
 * approximation.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { buildServer } from "../src/server.js";
import type { AppConfig } from "../src/config.js";
import { runUp } from "../migrations/runner.js";
import type { MigratorDbConfig } from "../migrations/config.js";
import { testDiscordConfig, testSessionConfig, testSuperadminConfig } from "./helpers/testAuthConfig.js";
import { DASHBOARD_MIGRATION_LEDGER_TABLE } from "../src/db/constants.js";

const REACHABLE_DB_CONFIG = {
  host: process.env.TEST_MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.TEST_MYSQL_PORT ?? 33070),
  user: "root",
  password: process.env.TEST_MYSQL_ROOT_PASSWORD ?? "devrootpass",
  database: "bunny_cc_health_test",
};

const BASE_CONFIG: AppConfig = {
  port: 0,
  logLevel: "silent",
  appVersion: "0.1.0-scaffold-test",
  db: REACHABLE_DB_CONFIG,
  sse: {
    heartbeatSeconds: 15,
    pollIntervalMs: 3000,
    maxQueuedFramesPerConnection: 200,
    maxRowsPerSourcePerTick: 500,
  },
  discord: testDiscordConfig(),
  session: testSessionConfig(),
  superadmin: testSuperadminConfig(),
};

async function freshDatabase(): Promise<void> {
  const admin = await mysql.createConnection({
    host: REACHABLE_DB_CONFIG.host,
    port: REACHABLE_DB_CONFIG.port,
    user: REACHABLE_DB_CONFIG.user,
    password: REACHABLE_DB_CONFIG.password,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${REACHABLE_DB_CONFIG.database}\``);
  await admin.query(`CREATE DATABASE \`${REACHABLE_DB_CONFIG.database}\``);
  await admin.end();
}

async function bootstrapEmptyDashboardLedger(): Promise<void> {
  const migratorConfig: MigratorDbConfig = REACHABLE_DB_CONFIG;
  const conn = await mysql.createConnection(migratorConfig);
  try {
    const result = await runUp(conn, "/nonexistent-empty-dir-proves-zero-migrations", migratorConfig);
    expect(result.ok).toBe(true); // zero migrations discovered -> trivially "all applied"
  } finally {
    await conn.end();
  }
}

/**
 * Verbatim copy of `vendor/self-bot-schema/database/migrate.py`'s own
 * `SCHEMA_MIGRATIONS_DDL` - the real, canonical shape of the SHARED ledger
 * `sharedSchemaCompat.ts` reads. Never invent a shape that merely happens to
 * satisfy this test file's own queries.
 */
const SHARED_SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(64) NOT NULL,
  checksum BINARY(32) NOT NULL,
  description VARCHAR(255) NULL,
  state VARCHAR(16) NOT NULL DEFAULT 'STARTED',
  started_at DATETIME(6) NOT NULL,
  finished_at DATETIME(6) NULL,
  applied_at DATETIME(6) NULL,
  applied_by VARCHAR(128) NULL,
  duration_ms INT UNSIGNED NULL,
  success BOOLEAN NULL,
  last_statement_index INT UNSIGNED NULL,
  last_statement_preview VARCHAR(255) NULL,
  error_detail VARCHAR(2000) NULL,
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

async function dropSharedSchemaMigrationsTable(): Promise<void> {
  const conn = await mysql.createConnection(REACHABLE_DB_CONFIG);
  try {
    await conn.query("DROP TABLE IF EXISTS schema_migrations");
  } finally {
    await conn.end();
  }
}

/** Undoes `bootstrapEmptyDashboardLedger()` - leaves the outer fixture in the same state it had before the nested shared-schema suite ran (no Dashboard ledger table at all), so this suite never depends on running last. */
async function dropDashboardLedgerTable(): Promise<void> {
  const conn = await mysql.createConnection(REACHABLE_DB_CONFIG);
  try {
    await conn.query(`DROP TABLE IF EXISTS \`${DASHBOARD_MIGRATION_LEDGER_TABLE}\``);
  } finally {
    await conn.end();
  }
}

/** Seeds one real-shape `schema_migrations` row exactly like the real Self-bot migrator would leave behind for that `state`. */
async function seedSharedSchemaMigrationRow(
  version: string,
  state: "STARTED" | "APPLIED" | "FAILED",
): Promise<void> {
  const conn = await mysql.createConnection(REACHABLE_DB_CONFIG);
  try {
    await conn.query(SHARED_SCHEMA_MIGRATIONS_DDL);
    await conn.query(
      `INSERT INTO schema_migrations
         (version, checksum, description, state, started_at, finished_at, applied_at, applied_by, success)
       VALUES (?, UNHEX(?), ?, ?, NOW(6), ?, ?, ?, ?)`,
      [
        version,
        "00".repeat(32),
        version,
        state,
        state === "STARTED" ? null : new Date(),
        state === "APPLIED" ? new Date() : null,
        state === "APPLIED" ? "test-migrator" : null,
        state === "APPLIED" ? 1 : state === "FAILED" ? 0 : null,
      ],
    );
  } finally {
    await conn.end();
  }
}

describe("/healthz and /readyz (real MySQL)", () => {
  beforeAll(async () => {
    await freshDatabase();
  });

  afterAll(async () => {
    const admin = await mysql.createConnection({
      host: REACHABLE_DB_CONFIG.host,
      port: REACHABLE_DB_CONFIG.port,
      user: REACHABLE_DB_CONFIG.user,
      password: REACHABLE_DB_CONFIG.password,
    });
    await admin.query(`DROP DATABASE IF EXISTS \`${REACHABLE_DB_CONFIG.database}\``);
    await admin.end();
  });

  it("/healthz is 200 even before any migration ledger exists", async () => {
    const app = await buildServer(BASE_CONFIG);
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("/readyz is NOT ready before the migration ledger has ever been bootstrapped", async () => {
    const app = await buildServer(BASE_CONFIG);
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(503);
    const body = response.json<{ status: string; reason: string }>();
    expect(body.status).toBe("not_ready");
    expect(body.reason).toMatch(/not yet bootstrapped/);
    await app.close();
  });

  it("DB DOWN: /healthz is STILL 200 with DB_HOST pointed at an unreachable address", async () => {
    const unreachableConfig: AppConfig = {
      ...BASE_CONFIG,
      db: { ...BASE_CONFIG.db, host: "10.255.255.1", port: 3306 },
    };
    const app = await buildServer(unreachableConfig);
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  }, 15000);

  it("DB DOWN: /readyz is NOT ready with DB_HOST pointed at an unreachable address", async () => {
    const unreachableConfig: AppConfig = {
      ...BASE_CONFIG,
      db: { ...BASE_CONFIG.db, host: "10.255.255.1", port: 3306 },
    };
    const app = await buildServer(unreachableConfig);
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(503);
    const body = response.json<{ status: string; reason: string }>();
    expect(body.status).toBe("not_ready");
    expect(body.reason).toMatch(/unreachable/);
    await app.close();
  }, 15000);

  describe("shared-schema compatibility gate (Step 10 post-merge correction)", () => {
    beforeAll(async () => {
      await bootstrapEmptyDashboardLedger();
    });

    afterAll(async () => {
      // Restores the outer fixture's pre-nested-suite state (no Dashboard
      // ledger table at all) - this suite must never depend on running
      // last, or on any other test's expectation about ledger absence.
      await dropDashboardLedgerTable();
    });

    afterEach(async () => {
      // Each case below owns its own SHARED schema_migrations fixture -
      // dropped after every test so cases never leak rows into each other
      // regardless of declaration order.
      await dropSharedSchemaMigrationsTable();
    });

    it("readyz: Dashboard ledger valid, SHARED schema_migrations absent -> 503", async () => {
      const app = await buildServer(BASE_CONFIG);
      const response = await app.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(503);
      const body = response.json<{ status: string; reason: string }>();
      expect(body.status).toBe("not_ready");
      expect(body.reason).toMatch(/schema_migrations table does not exist/);
      await app.close();
    });

    it("readyz: SHARED ledger only through 0014 APPLIED -> 503 (below supported minimum 0015)", async () => {
      await seedSharedSchemaMigrationRow("0014_guild_config_selfbot_legacy_fields", "APPLIED");
      const app = await buildServer(BASE_CONFIG);
      const response = await app.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(503);
      const body = response.json<{ status: string; reason: string }>();
      expect(body.status).toBe("not_ready");
      expect(body.reason).toMatch(/highest applied shared migration 0014 is below/);
      await app.close();
    });

    it("readyz: SHARED ledger through 0015 APPLIED, Dashboard ledger clean -> 200 READY", async () => {
      await seedSharedSchemaMigrationRow("0014_guild_config_selfbot_legacy_fields", "APPLIED");
      await seedSharedSchemaMigrationRow("0015_web_ingestion_and_guild_lifecycle", "APPLIED");
      const app = await buildServer(BASE_CONFIG);
      const response = await app.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ready" });
      await app.close();
    });

    it("readyz: SHARED 0015 row STARTED (never completed) -> 503, unresolved-state explicitly identified", async () => {
      await seedSharedSchemaMigrationRow("0015_web_ingestion_and_guild_lifecycle", "STARTED");
      const app = await buildServer(BASE_CONFIG);
      const response = await app.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(503);
      const body = response.json<{ status: string; reason: string }>();
      expect(body.status).toBe("not_ready");
      expect(body.reason).toMatch(/unresolved migration/);
      expect(body.reason).toMatch(/0015_web_ingestion_and_guild_lifecycle=STARTED/);
      await app.close();
    });

    it("readyz: SHARED 0015 row FAILED -> 503, unresolved-state explicitly identified", async () => {
      await seedSharedSchemaMigrationRow("0015_web_ingestion_and_guild_lifecycle", "FAILED");
      const app = await buildServer(BASE_CONFIG);
      const response = await app.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(503);
      const body = response.json<{ status: string; reason: string }>();
      expect(body.status).toBe("not_ready");
      expect(body.reason).toMatch(/unresolved migration/);
      expect(body.reason).toMatch(/0015_web_ingestion_and_guild_lifecycle=FAILED/);
      await app.close();
    });

    it("readyz: SHARED compatible 0015 plus a newer 0016 APPLIED -> 503 (exceeds supported maximum)", async () => {
      await seedSharedSchemaMigrationRow("0015_web_ingestion_and_guild_lifecycle", "APPLIED");
      await seedSharedSchemaMigrationRow("0016_some_future_migration", "APPLIED");
      const app = await buildServer(BASE_CONFIG);
      const response = await app.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(503);
      const body = response.json<{ status: string; reason: string }>();
      expect(body.status).toBe("not_ready");
      expect(body.reason).toMatch(/highest applied shared migration 0016 exceeds/);
      await app.close();
    });

    // -----------------------------------------------------------------
    // Load-bearing (PR #8 external-review finding): an otherwise-compatible
    // lower APPLIED migration must never hide a partially-applied FUTURE
    // migration. The Self-bot migrator runs DDL statement-by-statement with
    // no surrounding transaction (MySQL DDL implicitly commits), so a
    // STARTED/FAILED row means the physical schema may already be
    // partially mutated - readiness must fail closed regardless of what
    // lower migration is already APPLIED.
    // -----------------------------------------------------------------
    it("readyz: 0015 APPLIED + 0016 STARTED -> 503 (unresolved future migration hides nothing)", async () => {
      await seedSharedSchemaMigrationRow("0015_web_ingestion_and_guild_lifecycle", "APPLIED");
      await seedSharedSchemaMigrationRow("0016_some_future_migration", "STARTED");
      const app = await buildServer(BASE_CONFIG);
      const response = await app.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(503);
      const body = response.json<{ status: string; reason: string }>();
      expect(body.status).toBe("not_ready");
      expect(body.reason).toMatch(/unresolved migration/);
      expect(body.reason).toMatch(/0016_some_future_migration=STARTED/);
      await app.close();
    });

    it("readyz: 0015 APPLIED + 0016 FAILED -> 503 (unresolved future migration hides nothing)", async () => {
      await seedSharedSchemaMigrationRow("0015_web_ingestion_and_guild_lifecycle", "APPLIED");
      await seedSharedSchemaMigrationRow("0016_some_future_migration", "FAILED");
      const app = await buildServer(BASE_CONFIG);
      const response = await app.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(503);
      const body = response.json<{ status: string; reason: string }>();
      expect(body.status).toBe("not_ready");
      expect(body.reason).toMatch(/unresolved migration/);
      expect(body.reason).toMatch(/0016_some_future_migration=FAILED/);
      await app.close();
    });
  });
});
