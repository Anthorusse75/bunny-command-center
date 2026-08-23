/**
 * REAL MySQL + real local Discord OAuth test double coverage for the
 * "Separate admin alert notification preferences" correction's role-aware
 * visibility gate: `GET`/`PUT /api/notifications/preferences`'s
 * `visibleGroups` field must include `ADMIN_ALERTS` for a Guild-Admin-capable
 * caller and omit it for an ordinary caller who cannot administer any guild.
 *
 * Mirrors `test/guilds/routes.test.ts`'s real-server-instance approach (real
 * `buildServer()`, real DB, real Discord test double via
 * `startDiscordTestDouble()`, `fastify.inject()`) — this is the first
 * notifications-route test file that needs a real Discord guild list at all
 * (every other `test/notifications/*.test.ts` file uses placeholder,
 * non-decryptable encrypted token bytes, which is fine there because none of
 * those tests ever exercise a guild-scoped/RBAC code path).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer } from "../../src/server.js";
import type { AppConfig } from "../../src/config.js";
import { runUp } from "../../migrations/runner.js";
import type { MigratorDbConfig } from "../../migrations/config.js";
import { upsertDashboardUser } from "../../src/auth/userRepo.js";
import { createSession } from "../../src/auth/sessionRepo.js";
import { encryptSecret } from "../../src/auth/tokenCrypto.js";
import { startDiscordTestDouble, type DiscordTestDouble } from "../helpers/discordTestDouble.js";
import { testSessionConfig, testSuperadminConfig } from "../helpers/testAuthConfig.js";

const ROOT_CONFIG = {
  host: process.env.TEST_MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.TEST_MYSQL_PORT ?? 33070),
  user: "root",
  password: process.env.TEST_MYSQL_ROOT_PASSWORD ?? "devrootpass",
};
const TEST_DB_NAME = "bunny_cc_notifications_prefs_visibility_test";
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const DASHBOARD_MIGRATIONS_DIR = path.join(REPO_ROOT, "apps", "api", "migrations");
const SHARED_MIGRATIONS_DIR = path.join(REPO_ROOT, "vendor", "self-bot-schema", "database", "migrations");

const GUILD_A = "111111111111111111";
const GUILD_B = "222222222222222222";

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

describe("GET/PUT /api/notifications/preferences — role-aware 'Admin alerts' group visibility", () => {
  let discord: DiscordTestDouble;
  let config: AppConfig;
  let fastify: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    const dbConfig = await freshDatabase();
    discord = await startDiscordTestDouble();
    config = {
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
      discord: {
        clientId: "x",
        clientSecret: "x",
        redirectUri: "http://localhost/callback",
        scope: "identify guilds guilds.members.read",
        authorizeBaseUrl: discord.baseUrl,
        tokenUrl: discord.tokenUrl,
        apiBaseUrl: discord.apiBaseUrl,
      },
      session: testSessionConfig(),
      superadmin: testSuperadminConfig(),
    };
    fastify = await buildServer(config);
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
    await discord.close();
    const admin = await mysql.createConnection(ROOT_CONFIG);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB_NAME}\``);
    await admin.end();
  });

  afterEach(() => {
    discord.state.guildsForcedStatus = undefined;
    discord.state.guildsForcedBody = undefined;
  });

  let userCounter = 800300000000000000n;
  let sessionCounter = 0;
  async function makeSession(
    guilds: { id: string; owner: boolean; permissions: string }[],
    discordUserId?: string,
  ): Promise<{ cookie: string; discordUserId: string; userId: number }> {
    const id = discordUserId ?? String((userCounter += 1n));
    const key = config.session.tokenEncryptionKey;
    const db = fastify.authTestHooks!.db;
    const user = await upsertDashboardUser(db, {
      discordUserId: id,
      username: `user-${id}`,
      avatarHash: null,
      encryptedAccessToken: encryptSecret(discord.state.currentAccessToken, key),
      encryptedRefreshToken: encryptSecret("refresh-token-value", key),
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    });
    sessionCounter += 1;
    const rawToken = `test-session-token-${id}-${sessionCounter}`;
    await createSession(db, rawToken, {
      userId: user.id,
      deviceLabel: null,
      userAgent: null,
      ipHash: null,
      slidingTtlMs: config.session.slidingTtlMs,
      absoluteTtlMs: config.session.absoluteTtlMs,
    });
    discord.state.guilds = guilds;
    fastify.authTestHooks!.guildAuthDeps.cache.invalidateUserGuild(id, "*");
    return { cookie: `${config.session.cookieName}=${rawToken}`, discordUserId: id, userId: user.id };
  }

  interface PreferencesBody {
    data: { preferences: { eventType: string }[]; visibleGroups: string[] };
  }
  function body(response: Awaited<ReturnType<typeof fastify.inject>>): PreferencesBody {
    return response.json();
  }

  it("an ordinary caller who is not a member of any guild does NOT see ADMIN_ALERTS in visibleGroups, but every other group still appears", async () => {
    const { cookie } = await makeSession([]);
    const response = await fastify.inject({
      method: "GET",
      url: "/api/notifications/preferences",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const { visibleGroups } = body(response).data;
    expect(visibleGroups).not.toContain("ADMIN_ALERTS");
    expect(visibleGroups.sort()).toEqual(
      ["UPLOADS", "GUILD_NEEDS", "PREMIUMPLUS", "LEADERBOARD_BADGES", "WEEKLY_SUMMARY"].sort(),
    );
  });

  it("a caller who is a member of a guild but neither Owner nor holds Discord ADMINISTRATOR anywhere does NOT see ADMIN_ALERTS", async () => {
    const { cookie } = await makeSession([{ id: GUILD_A, owner: false, permissions: "0" }]);
    const response = await fastify.inject({
      method: "GET",
      url: "/api/notifications/preferences",
      headers: { cookie },
    });
    expect(body(response).data.visibleGroups).not.toContain("ADMIN_ALERTS");
  });

  it("a Discord guild OWNER DOES see ADMIN_ALERTS in visibleGroups", async () => {
    const { cookie } = await makeSession([{ id: GUILD_A, owner: true, permissions: "0" }]);
    const response = await fastify.inject({
      method: "GET",
      url: "/api/notifications/preferences",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(body(response).data.visibleGroups).toContain("ADMIN_ALERTS");
  });

  it("a caller holding Discord's ADMINISTRATOR permission bit (not Owner) in at least one guild DOES see ADMIN_ALERTS", async () => {
    // Discord permission bit 0x8 = ADMINISTRATOR (same fixture convention `hasAdministratorPermission` tests use).
    const ADMINISTRATOR_BIT = String(0x8);
    const { cookie } = await makeSession([
      { id: GUILD_A, owner: false, permissions: "0" },
      { id: GUILD_B, owner: false, permissions: ADMINISTRATOR_BIT },
    ]);
    const response = await fastify.inject({
      method: "GET",
      url: "/api/notifications/preferences",
      headers: { cookie },
    });
    expect(body(response).data.visibleGroups).toContain("ADMIN_ALERTS");
  });

  it("the platform Superadmin sees ADMIN_ALERTS even with zero real Discord guild memberships", async () => {
    const superadminId = testSuperadminConfig().discordUserId;
    const { cookie } = await makeSession([], superadminId);
    const response = await fastify.inject({
      method: "GET",
      url: "/api/notifications/preferences",
      headers: { cookie },
    });
    expect(body(response).data.visibleGroups).toContain("ADMIN_ALERTS");
  });

  it("PUT /api/notifications/preferences reports the SAME role-aware visibleGroups as the GET route, consistently", async () => {
    const { cookie } = await makeSession([{ id: GUILD_A, owner: true, permissions: "0" }]);
    const response = await fastify.inject({
      method: "PUT",
      url: "/api/notifications/preferences",
      headers: { cookie, "x-requested-with": "BunnyCommandCenter", "content-type": "application/json" },
      payload: { groups: [{ group: "UPLOADS", inAppEnabled: true, discordDmEnabled: true }] },
    });
    expect(response.statusCode).toBe(200);
    expect(body(response).data.visibleGroups).toContain("ADMIN_ALERTS");
  });

  it("visibility gating never narrows the underlying `preferences` array itself — ADMIN_ALERT's own row is present for a non-admin-capable caller too, just not exposed as a visible group", async () => {
    const { cookie } = await makeSession([]);
    const response = await fastify.inject({
      method: "GET",
      url: "/api/notifications/preferences",
      headers: { cookie },
    });
    const { preferences, visibleGroups } = body(response).data;
    expect(visibleGroups).not.toContain("ADMIN_ALERTS");
    expect(preferences.some((p) => p.eventType === "ADMIN_ALERT")).toBe(true);
  });

  it("a Discord fetch failure (expired/invalid grant) fails CLOSED — ADMIN_ALERTS is simply absent, never a 500", async () => {
    const { cookie, discordUserId } = await makeSession([{ id: GUILD_A, owner: true, permissions: "0" }]);
    discord.state.guildsForcedStatus = 401;
    fastify.authTestHooks!.guildAuthDeps.cache.invalidateUserGuild(discordUserId, "*");
    const response = await fastify.inject({
      method: "GET",
      url: "/api/notifications/preferences",
      headers: { cookie },
    });
    // The preference read itself must still succeed (never a 500/DISCORD_REAUTH_REQUIRED
    // bleeding out of a presentation-only visibility check) — only the gated group is affected.
    expect(response.statusCode).toBe(200);
    expect(body(response).data.visibleGroups).not.toContain("ADMIN_ALERTS");
  });
});
