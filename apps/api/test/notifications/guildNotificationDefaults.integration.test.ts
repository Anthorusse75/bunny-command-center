/**
 * Step 10 external-review correction round, Section 11 — real-MySQL
 * coverage for `resolvePreference()`'s new 3-tier precedence (personal
 * override > guild default > registry default, with `group === null`
 * platform events NEVER guild-suppressible) and `setGuildNotificationDefault()`.
 * Mirrors `service.integration.test.ts`'s shared-then-dashboard migration
 * setup (00_GLOBAL_IMPLEMENTATION_RULES.md #6: no mocked-DB "integration"
 * tests).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Kysely } from "kysely";
import type { DB } from "../../src/db/codegen-types.js";
import { runUp } from "../../migrations/runner.js";
import type { MigratorDbConfig } from "../../migrations/config.js";
import { createKyselyClient } from "../../src/db/kysely.js";
import { upsertDashboardUser } from "../../src/auth/userRepo.js";
import { createNotification } from "../../src/notifications/service.js";
import {
  resolvePreference,
  setGuildNotificationDefault,
  upsertPreferenceGroup,
} from "../../src/notifications/repo.js";
import { testDiscordConfig, testSessionConfig, testSuperadminConfig } from "../helpers/testAuthConfig.js";
import type { AppConfig } from "../../src/config.js";

const ROOT_CONFIG = {
  host: process.env.TEST_MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.TEST_MYSQL_PORT ?? 33070),
  user: "root",
  password: process.env.TEST_MYSQL_ROOT_PASSWORD ?? "devrootpass",
};
const TEST_DB_NAME = "bunny_cc_guild_notif_defaults_test";
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

describe("resolvePreference() guild-default precedence (Section 11) — real MySQL", () => {
  let db: Kysely<DB>;
  let pool: mysql.Pool;
  let dbConfig: MigratorDbConfig;

  beforeAll(async () => {
    dbConfig = await freshDatabase();
    pool = mysql.createPool(dbConfig);
    db = createKyselyClient(dbConfig);
  });

  afterAll(async () => {
    await db.destroy();
    await pool.end();
    const admin = await mysql.createConnection(ROOT_CONFIG);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB_NAME}\``);
    await admin.end();
  });

  let userCounter = 800200000000000000n;
  async function makeUser(): Promise<{ id: number; discordUserId: string }> {
    const discordUserId = String((userCounter += 1n));
    const user = await upsertDashboardUser(db, {
      discordUserId,
      username: `user-${discordUserId}`,
      avatarHash: null,
      encryptedAccessToken: Buffer.from("x"),
      encryptedRefreshToken: Buffer.from("y"),
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    });
    return { id: user.id, discordUserId };
  }

  it("scenario 1: personal override wins over a guild default that would otherwise apply", async () => {
    const user = await makeUser();
    const guildId = "700000000000000001";
    // Guild default says DM ON; personal override says DM OFF -- personal must win.
    await setGuildNotificationDefault(db, {
      guildId,
      inAppEnabled: true,
      discordDmEnabled: true,
      updatedBy: "999999999999999999",
    });
    await upsertPreferenceGroup(db, user.id, "GUILD_NEEDS", { inAppEnabled: true, discordDmEnabled: false });

    const resolved = await resolvePreference(db, user.id, "GUILD_APPROVAL_STATE_CHANGE", guildId);
    expect(resolved).toEqual({ inAppEnabled: true, discordDmEnabled: false });
  });

  it("scenario 2: guild default wins over the registry default when no personal override exists", async () => {
    const user = await makeUser();
    const guildId = "700000000000000002";
    // Registry default for GUILD_APPROVAL_STATE_CHANGE would normally apply
    // (no personal override written) -- the guild default must override it.
    await setGuildNotificationDefault(db, {
      guildId,
      inAppEnabled: false,
      discordDmEnabled: true,
      updatedBy: "999999999999999999",
    });

    const resolved = await resolvePreference(db, user.id, "GUILD_APPROVAL_STATE_CHANGE", guildId);
    expect(resolved).toEqual({ inAppEnabled: false, discordDmEnabled: true });
  });

  it("scenario 3: no guild context (guildId omitted/null) falls back to the registry default even if a guild default row exists elsewhere", async () => {
    const user = await makeUser();
    const otherGuildId = "700000000000000003";
    await setGuildNotificationDefault(db, {
      guildId: otherGuildId,
      inAppEnabled: false,
      discordDmEnabled: false,
      updatedBy: "999999999999999999",
    });

    const resolvedNoGuild = await resolvePreference(db, user.id, "GUILD_APPROVAL_STATE_CHANGE");
    const resolvedNullGuild = await resolvePreference(db, user.id, "GUILD_APPROVAL_STATE_CHANGE", null);
    // Registry default for GUILD_APPROVAL_STATE_CHANGE, NOT the other guild's
    // default (false/false) -- proves guildId is required to even consult
    // dashboard_guild_notification_defaults.
    expect(resolvedNoGuild).not.toEqual({ inAppEnabled: false, discordDmEnabled: false });
    expect(resolvedNullGuild).toEqual(resolvedNoGuild);
  });

  it("scenario 4: a group=null platform event (NEW_GUILD_PENDING) ALWAYS uses the registry default, even when a guild default row exists for that exact guild", async () => {
    const user = await makeUser();
    const guildId = "700000000000000004";
    // A guild default row exists and explicitly disagrees with whatever the
    // registry default is -- if resolvePreference incorrectly consulted it
    // for a group=null event, this test would catch that regression.
    await setGuildNotificationDefault(db, {
      guildId,
      inAppEnabled: false,
      discordDmEnabled: false,
      updatedBy: "999999999999999999",
    });

    const resolvedWithGuild = await resolvePreference(db, user.id, "NEW_GUILD_PENDING", guildId);
    const resolvedWithoutGuild = await resolvePreference(db, user.id, "NEW_GUILD_PENDING", null);
    // Identical regardless of guild context -- proves group=null is NEVER
    // guild-suppressible.
    expect(resolvedWithGuild).toEqual(resolvedWithoutGuild);
  });

  it("end-to-end: createNotification() for a guild-scoped event actually applies the guild default via the real service (not just the repo function in isolation)", async () => {
    const user = await makeUser();
    const guildId = "700000000000000005";
    await setGuildNotificationDefault(db, {
      guildId,
      inAppEnabled: true,
      discordDmEnabled: false,
      updatedBy: "999999999999999999",
    });

    const config: AppConfig = {
      port: 0,
      logLevel: "silent",
      appVersion: "test",
      db: dbConfig,
      sse: {
        heartbeatSeconds: 30,
        pollIntervalMs: 60_000,
        maxQueuedFramesPerConnection: 200,
        maxRowsPerSourcePerTick: 500,
      },
      discord: testDiscordConfig(),
      session: testSessionConfig(),
      superadmin: testSuperadminConfig(),
      publicUrl: "https://dashboard.example.com",
    };

    const result = await createNotification(db, config, {
      userId: user.id,
      eventType: "GUILD_APPROVAL_STATE_CHANGE",
      parameters: { guildName: "Test Guild", state: "APPROVED" },
      guildId,
      deeplinkPath: `/guild/${guildId}/onboarding`,
    });
    expect(result.inAppEnabled).toBe(true);
    expect(result.discordDmEnabled).toBe(false);

    const [deliveryRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT channel, state FROM dashboard_notification_deliveries WHERE notification_id = ?",
      [result.notificationId],
    );
    const dm = (deliveryRows as { channel: string; state: string }[]).find((r) => r.channel === "DISCORD_DM");
    expect(dm!.state).toBe("SKIPPED_PREFERENCE");
  });
});
