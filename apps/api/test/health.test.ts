/**
 * Proves /healthz and /readyz against a REAL MySQL instance in both the
 * positive AND negative case (mission §16/§20: "do NOT simulate DB failure
 * by mocking the readiness function"). Uses Fastify's .inject() rather than
 * a bound port - inject() still runs the full route handler, including the
 * real mysql2 connection attempt in readiness.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { buildServer } from "../src/server.js";
import type { AppConfig } from "../src/config.js";
import { runUp } from "../migrations/runner.js";
import type { MigratorDbConfig } from "../migrations/config.js";
import { testDiscordConfig, testSessionConfig } from "./helpers/testAuthConfig.js";

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

  it("/readyz is 200 once the (empty) Dashboard ledger has been bootstrapped via the migrator", async () => {
    const migratorConfig: MigratorDbConfig = REACHABLE_DB_CONFIG;
    const conn = await mysql.createConnection(migratorConfig);
    try {
      const result = await runUp(conn, "/nonexistent-empty-dir-proves-zero-migrations", migratorConfig);
      expect(result.ok).toBe(true); // zero migrations discovered -> trivially "all applied"
    } finally {
      await conn.end();
    }

    const app = await buildServer(BASE_CONFIG);
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
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
});
