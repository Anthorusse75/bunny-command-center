/**
 * REAL MySQL integration coverage for `createNotification()` + the
 * reconciliation watcher (00_GLOBAL_IMPLEMENTATION_RULES.md #6: "mocked-DB
 * 'integration' tests are a rejection-criteria failure" — this suite never
 * mocks `operator_commands`, it applies the REAL shared migrations and
 * writes real rows). Mirrors `test/guilds/routes.test.ts`'s
 * shared-then-dashboard migration setup.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer } from "../../src/server.js";
import type { AppConfig } from "../../src/config.js";
import { runUp } from "../../migrations/runner.js";
import type { MigratorDbConfig } from "../../migrations/config.js";
import { upsertDashboardUser } from "../../src/auth/userRepo.js";
import { createNotification } from "../../src/notifications/service.js";
import { generateNotificationId } from "../../src/notifications/id.js";
import { testDiscordConfig, testSessionConfig, testSuperadminConfig } from "../helpers/testAuthConfig.js";

const ROOT_CONFIG = {
  host: process.env.TEST_MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.TEST_MYSQL_PORT ?? 33070),
  user: "root",
  password: process.env.TEST_MYSQL_ROOT_PASSWORD ?? "devrootpass",
};
const TEST_DB_NAME = "bunny_cc_notifications_service_test";
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const DASHBOARD_MIGRATIONS_DIR = path.join(REPO_ROOT, "apps", "api", "migrations");
const SHARED_MIGRATIONS_DIR = path.join(REPO_ROOT, "vendor", "self-bot-schema", "database", "migrations");

async function freshDatabase(): Promise<MigratorDbConfig> {
  const admin = await mysql.createConnection(ROOT_CONFIG);
  await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB_NAME}\``);
  await admin.query(`CREATE DATABASE \`${TEST_DB_NAME}\``);
  await admin.end();
  const config: MigratorDbConfig = { ...ROOT_CONFIG, database: TEST_DB_NAME };
  const conn = await mysql.createConnection(config);
  try {
    const shared = await runUp(conn, SHARED_MIGRATIONS_DIR, config);
    if (!shared.ok) throw new Error(`shared migrations failed: ${shared.message}`);
    const dashboard = await runUp(conn, DASHBOARD_MIGRATIONS_DIR, config);
    if (!dashboard.ok) throw new Error(`dashboard migrations failed: ${dashboard.message}`);
  } finally {
    await conn.end();
  }
  return config;
}

describe("createNotification() + reconciliation watcher — real MySQL", () => {
  let config: AppConfig;
  let fastify: Awaited<ReturnType<typeof buildServer>>;
  let pool: mysql.Pool;

  beforeAll(async () => {
    const dbConfig = await freshDatabase();
    pool = mysql.createPool(dbConfig);
    config = {
      port: 0,
      logLevel: "silent",
      appVersion: "test",
      db: dbConfig,
      sse: { heartbeatSeconds: 30, pollIntervalMs: 60_000, maxQueuedFramesPerConnection: 200, maxRowsPerSourcePerTick: 500 },
      discord: testDiscordConfig(),
      session: testSessionConfig(),
      superadmin: testSuperadminConfig(),
      publicUrl: "https://dashboard.example.com",
    };
    fastify = await buildServer(config);
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
    await pool.end();
    const admin = await mysql.createConnection(ROOT_CONFIG);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB_NAME}\``);
    await admin.end();
  });

  let userCounter = 800100000000000000n;
  async function makeUser(): Promise<{ id: number; discordUserId: string }> {
    const discordUserId = String((userCounter += 1n));
    const user = await upsertDashboardUser(fastify.authTestHooks!.db, {
      discordUserId,
      username: `user-${discordUserId}`,
      avatarHash: null,
      encryptedAccessToken: Buffer.from("x"),
      encryptedRefreshToken: Buffer.from("y"),
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    });
    return { id: user.id, discordUserId };
  }

  // CAST(... AS CHAR) forces mysql2 to return this BIGINT UNSIGNED column as
  // a genuine string — this test's own connection pool is plain
  // `mysql2.createPool` with no `supportBigNumbers`/`bigNumberStrings`, so
  // reading it as a bare column would silently round through a JS `Number`
  // (exactly the precision-loss bug this whole feature exists to avoid —
  // caught for real: an earlier version of this test read the un-cast
  // column and got "900000000000000000" back for a written
  // "900000000000000001"). Production code never has this problem because
  // `repo.ts` never reads `requested_by_discord_id` back at all.
  async function operatorCommandRow(commandId: string) {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT command_id, command_type, target_service, idempotency_key, CAST(requested_by_discord_id AS CHAR) as requested_by_discord_id, requested_by_role, state, guild_id FROM operator_commands WHERE command_id = ?",
      [commandId],
    );
    return rows[0];
  }

  async function operatorCommandCountForIdempotencyKey(idempotencyKey: string): Promise<number> {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) as c FROM operator_commands WHERE idempotency_key = ?",
      [idempotencyKey],
    );
    return Number(rows[0]!.c);
  }

  async function deliveryRow(notificationId: string, channel: "IN_APP" | "DISCORD_DM") {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT * FROM dashboard_notification_deliveries WHERE notification_id = ? AND channel = ?",
      [notificationId, channel],
    );
    return rows[0];
  }

  it("full DM-enabled flow: notification row + IN_APP SENT + DISCORD_DM PENDING + one real operator_commands SEND_DM row", async () => {
    const user = await makeUser();
    const result = await createNotification(fastify.authTestHooks!.db, config, {
      userId: user.id,
      eventType: "UPLOAD_COMPLETED",
      parameters: { count: 3 },
      deeplinkPath: "/contributions",
    });
    expect(result.inAppEnabled).toBe(true);
    expect(result.discordDmEnabled).toBe(true);

    const [notifRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT * FROM dashboard_notifications WHERE id = ?",
      [result.notificationId],
    );
    expect(notifRows).toHaveLength(1);
    expect(notifRows[0]!.event_type).toBe("UPLOAD_COMPLETED");

    const inApp = await deliveryRow(result.notificationId, "IN_APP");
    expect(inApp!.state).toBe("SENT");

    const dm = await deliveryRow(result.notificationId, "DISCORD_DM");
    expect(dm!.state).toBe("PENDING");
    expect(dm!.operator_command_id).not.toBeNull();

    const command = await operatorCommandRow(dm!.operator_command_id as string);
    expect(command).toBeDefined();
    expect(command!.command_type).toBe("SEND_DM");
    expect(command!.target_service).toBe("bunny_ocr");
    expect(command!.idempotency_key).toBe(result.notificationId);
    // System-generated (no triggeredBy) -> Superadmin identity, role SYSTEM.
    expect(String(command!.requested_by_discord_id)).toBe(config.superadmin.discordUserId);
    expect(command!.requested_by_role).toBe("SYSTEM");
  });

  it("human-triggered notification uses the real acting user's Discord ID as requested_by_discord_id", async () => {
    const user = await makeUser();
    const actorDiscordId = "777777777777777777";
    const result = await createNotification(fastify.authTestHooks!.db, config, {
      userId: user.id,
      eventType: "URGENT_GUILD_NEED",
      parameters: { guildName: "Alpha" },
      guildId: null,
      deeplinkPath: "/guild/x",
      triggeredBy: { discordUserId: actorDiscordId, role: "GUILD_ADMIN" },
    });
    const dm = await deliveryRow(result.notificationId, "DISCORD_DM");
    const command = await operatorCommandRow(dm!.operator_command_id as string);
    expect(String(command!.requested_by_discord_id)).toBe(actorDiscordId);
    expect(command!.requested_by_role).toBe("GUILD_ADMIN");
  });

  it("DM-disabled preference: IN_APP SENT, DISCORD_DM SKIPPED_PREFERENCE, no operator_commands row enqueued", async () => {
    const user = await makeUser();
    // BADGE_EARNED defaults to DM OFF (18_NOTIFICATIONS_AND_DISCORD_DM.md's matrix).
    const result = await createNotification(fastify.authTestHooks!.db, config, {
      userId: user.id,
      eventType: "BADGE_EARNED",
      parameters: { badgeName: "500 shots" },
      deeplinkPath: "/profile/badges",
    });
    expect(result.discordDmEnabled).toBe(false);
    const dm = await deliveryRow(result.notificationId, "DISCORD_DM");
    expect(dm!.state).toBe("SKIPPED_PREFERENCE");
    expect(dm!.operator_command_id).toBeNull();
    const count = await operatorCommandCountForIdempotencyKey(result.notificationId);
    expect(count).toBe(0);
  });

  it("retrying createNotification() with the SAME notificationId (system-generated) creates exactly ONE notification and ONE operator_commands row — proven against the real composite UNIQUE constraint", async () => {
    const user = await makeUser();
    const notificationId = generateNotificationId(); // fixed for this test, reused across both calls below
    const params = {
      notificationId,
      userId: user.id,
      eventType: "UPLOAD_COMPLETED" as const,
      parameters: { count: 1 },
      deeplinkPath: "/contributions",
    };
    const first = await createNotification(fastify.authTestHooks!.db, config, params);
    const second = await createNotification(fastify.authTestHooks!.db, config, params);
    expect(first.notificationId).toBe(second.notificationId);

    const [notifRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) as c FROM dashboard_notifications WHERE id = ?",
      [notificationId],
    );
    expect(Number(notifRows[0]!.c)).toBe(1);
    expect(await operatorCommandCountForIdempotencyKey(notificationId)).toBe(1);

    const dm = await deliveryRow(notificationId, "DISCORD_DM");
    expect(dm!.operator_command_id).not.toBeNull();
  });

  it("retrying createNotification() with the SAME notificationId (human-triggered) also creates exactly ONE operator_commands row", async () => {
    const user = await makeUser();
    const notificationId = generateNotificationId();
    const actorDiscordId = "666666666666666666";
    const params = {
      notificationId,
      userId: user.id,
      eventType: "URGENT_GUILD_NEED" as const,
      parameters: { guildName: "Bravo" },
      deeplinkPath: "/guild/y",
      triggeredBy: { discordUserId: actorDiscordId },
    };
    await createNotification(fastify.authTestHooks!.db, config, params);
    await createNotification(fastify.authTestHooks!.db, config, params);
    expect(await operatorCommandCountForIdempotencyKey(notificationId)).toBe(1);
  });

  it("SEND_DM FAILED -> watcher -> delivery FAILED, while the notification row and IN_APP delivery stay intact", async () => {
    const user = await makeUser();
    const result = await createNotification(fastify.authTestHooks!.db, config, {
      userId: user.id,
      eventType: "UPLOAD_COMPLETED",
      parameters: { count: 2 },
      deeplinkPath: "/contributions",
    });
    const dmBefore = await deliveryRow(result.notificationId, "DISCORD_DM");
    await pool.query("UPDATE operator_commands SET state = 'FAILED', last_error_code = 'DISCORD_FORBIDDEN' WHERE command_id = ?", [
      dmBefore!.operator_command_id,
    ]);

    await fastify.notificationTestHooks!.watcher.runOnceForTests();

    const dmAfter = await deliveryRow(result.notificationId, "DISCORD_DM");
    expect(dmAfter!.state).toBe("FAILED");

    const inApp = await deliveryRow(result.notificationId, "IN_APP");
    expect(inApp!.state).toBe("SENT");
    const [notifRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT dismissed_at FROM dashboard_notifications WHERE id = ?",
      [result.notificationId],
    );
    expect(notifRows).toHaveLength(1);
  });

  it("SEND_DM_DELIVERY_OUTCOME_UNKNOWN -> delivery FAILED, and is never re-enqueued (watcher runs twice, operator_commands row count stays at 1)", async () => {
    const user = await makeUser();
    const result = await createNotification(fastify.authTestHooks!.db, config, {
      userId: user.id,
      eventType: "UPLOAD_COMPLETED",
      parameters: { count: 1 },
      deeplinkPath: "/contributions",
    });
    const dmBefore = await deliveryRow(result.notificationId, "DISCORD_DM");
    await pool.query(
      "UPDATE operator_commands SET state = 'FAILED', last_error_code = 'SEND_DM_DELIVERY_OUTCOME_UNKNOWN' WHERE command_id = ?",
      [dmBefore!.operator_command_id],
    );

    await fastify.notificationTestHooks!.watcher.runOnceForTests();
    await fastify.notificationTestHooks!.watcher.runOnceForTests();

    const dmAfter = await deliveryRow(result.notificationId, "DISCORD_DM");
    expect(dmAfter!.state).toBe("FAILED");
    expect(await operatorCommandCountForIdempotencyKey(result.notificationId)).toBe(1);
  });

  it("a DM payload/enqueue failure (e.g. a malformed recipient discordUserId) never loses the notification or the IN_APP delivery — only DISCORD_DM is marked FAILED", async () => {
    // A user row whose discord_user_id is NOT a syntactically valid
    // Snowflake — found for real via this step's own Playwright E2E suite
    // (the E2E test-login fixture's default id, "900000000001", is only 12
    // digits) and reproduced deliberately here at the integration level.
    const user = await upsertDashboardUser(fastify.authTestHooks!.db, {
      discordUserId: "900000000001",
      username: "malformed-id-user",
      avatarHash: null,
      encryptedAccessToken: Buffer.from("x"),
      encryptedRefreshToken: Buffer.from("y"),
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    });
    const result = await createNotification(fastify.authTestHooks!.db, config, {
      userId: user.id,
      eventType: "UPLOAD_COMPLETED", // DM-enabled by default
      parameters: { count: 1 },
      deeplinkPath: "/contributions",
    });
    const [notifRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT id FROM dashboard_notifications WHERE id = ?",
      [result.notificationId],
    );
    expect(notifRows).toHaveLength(1); // notification survives
    const inApp = await deliveryRow(result.notificationId, "IN_APP");
    expect(inApp!.state).toBe("SENT"); // IN_APP survives
    const dm = await deliveryRow(result.notificationId, "DISCORD_DM");
    expect(dm!.state).toBe("FAILED"); // DM alone is marked FAILED
    expect(await operatorCommandCountForIdempotencyKey(result.notificationId)).toBe(0); // never enqueued
  });

  it("changing a preference affects only FUTURE notifications, never history — proven without any app reload", async () => {
    const user = await makeUser();
    const before = await createNotification(fastify.authTestHooks!.db, config, {
      userId: user.id,
      eventType: "RANKING_TOP3_CHANGE",
      parameters: { guildName: "Alpha", rank: 2 },
      deeplinkPath: "/guild/x/leaderboard",
    });
    // RANKING_TOP3_CHANGE defaults DM OFF — flip the preference ON directly (same write path the PUT route uses).
    await fastify
      .authTestHooks!.db.insertInto("dashboard_notification_preferences")
      .values({ user_id: user.id, event_type: "RANKING_TOP3_CHANGE", in_app_enabled: 1, discord_dm_enabled: 1 })
      .execute();

    const beforeDelivery = await deliveryRow(before.notificationId, "DISCORD_DM");
    expect(beforeDelivery!.state).toBe("SKIPPED_PREFERENCE"); // untouched by the later preference change

    const after = await createNotification(fastify.authTestHooks!.db, config, {
      userId: user.id,
      eventType: "RANKING_TOP3_CHANGE",
      parameters: { guildName: "Alpha", rank: 1 },
      deeplinkPath: "/guild/x/leaderboard",
    });
    const afterDelivery = await deliveryRow(after.notificationId, "DISCORD_DM");
    expect(afterDelivery!.state).toBe("PENDING");
  });
});
