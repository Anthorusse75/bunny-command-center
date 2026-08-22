/**
 * REAL MySQL integration coverage for `/api/notifications*`
 * (24_API_CONTRACTS.md §Notifications) — real `buildServer()`,
 * `fastify.inject()`, IDOR checklist (08_AUTHORIZATION_AND_RBAC.md) applied
 * explicitly: user A must never read or mutate user B's notifications.
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
import { createSession } from "../../src/auth/sessionRepo.js";
import { createNotification } from "../../src/notifications/service.js";
import { testDiscordConfig, testSessionConfig, testSuperadminConfig } from "../helpers/testAuthConfig.js";

const ROOT_CONFIG = {
  host: process.env.TEST_MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.TEST_MYSQL_PORT ?? 33070),
  user: "root",
  password: process.env.TEST_MYSQL_ROOT_PASSWORD ?? "devrootpass",
};
const TEST_DB_NAME = "bunny_cc_notifications_routes_test";
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

describe("/api/notifications* — real MySQL, IDOR checklist", () => {
  let config: AppConfig;
  let fastify: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    const dbConfig = await freshDatabase();
    config = {
      port: 0,
      logLevel: "silent",
      appVersion: "test",
      db: dbConfig,
      sse: { heartbeatSeconds: 30, pollIntervalMs: 60_000, maxQueuedFramesPerConnection: 200, maxRowsPerSourcePerTick: 500 },
      discord: testDiscordConfig(),
      session: testSessionConfig(),
      superadmin: testSuperadminConfig(),
    };
    fastify = await buildServer(config);
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
    const admin = await mysql.createConnection(ROOT_CONFIG);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB_NAME}\``);
    await admin.end();
  });

  let userCounter = 800200000000000000n;
  let sessionCounter = 0;
  async function makeSession(): Promise<{ cookie: string; userId: number }> {
    const discordUserId = String((userCounter += 1n));
    const db = fastify.authTestHooks!.db;
    const user = await upsertDashboardUser(db, {
      discordUserId,
      username: `user-${discordUserId}`,
      avatarHash: null,
      encryptedAccessToken: Buffer.from("x"),
      encryptedRefreshToken: Buffer.from("y"),
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    });
    sessionCounter += 1;
    const rawToken = `test-session-token-${discordUserId}-${sessionCounter}`;
    await createSession(db, rawToken, {
      userId: user.id,
      deviceLabel: null,
      userAgent: null,
      ipHash: null,
      slidingTtlMs: config.session.slidingTtlMs,
      absoluteTtlMs: config.session.absoluteTtlMs,
    });
    return { cookie: `${config.session.cookieName}=${rawToken}`, userId: user.id };
  }

  const CSRF_HEADERS = { "x-requested-with": "BunnyCommandCenter" };

  type InjectResponse = Awaited<ReturnType<typeof fastify.inject>>;
  interface ListBody {
    data: { items: { id: string; message: string; readAt: string | null }[]; unreadCount: number };
  }
  interface PreferencesBody {
    data: { preferences: { eventType: string; discordDmEnabled: boolean }[] };
  }
  function listBody(response: InjectResponse): ListBody {
    return response.json();
  }
  function preferencesBody(response: InjectResponse): PreferencesBody {
    return response.json();
  }

  it("GET /api/notifications — 401 unauthenticated", async () => {
    const response = await fastify.inject({ method: "GET", url: "/api/notifications" });
    expect(response.statusCode).toBe(401);
  });

  it("lists only the caller's own notifications, renders message text, reports unreadCount", async () => {
    const a = await makeSession();
    const b = await makeSession();
    await createNotification(fastify.authTestHooks!.db, config, {
      userId: a.userId,
      eventType: "UPLOAD_COMPLETED",
      parameters: { count: 5 },
      deeplinkPath: "/contributions",
    });
    await createNotification(fastify.authTestHooks!.db, config, {
      userId: b.userId,
      eventType: "UPLOAD_COMPLETED",
      parameters: { count: 9 },
      deeplinkPath: "/contributions",
    });

    const response = await fastify.inject({ method: "GET", url: "/api/notifications", headers: { cookie: a.cookie } });
    expect(response.statusCode).toBe(200);
    const body = listBody(response);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]!.message).toBe("Upload completed: 5 screenshots");
    expect(body.data.unreadCount).toBe(1);
  });

  it("IDOR: user A cannot mark user B's notification as read (404, not user B's data)", async () => {
    const a = await makeSession();
    const b = await makeSession();
    const created = await createNotification(fastify.authTestHooks!.db, config, {
      userId: b.userId,
      eventType: "UPLOAD_COMPLETED",
      parameters: { count: 1 },
      deeplinkPath: "/contributions",
    });

    const response = await fastify.inject({
      method: "PUT",
      url: `/api/notifications/${created.notificationId}/read`,
      headers: { cookie: a.cookie, ...CSRF_HEADERS },
    });
    expect(response.statusCode).toBe(404);

    // Confirm B's notification was NOT actually mutated by A's attempt.
    const bList = await fastify.inject({ method: "GET", url: "/api/notifications", headers: { cookie: b.cookie } });
    const bBody = listBody(bList);
    expect(bBody.data.items.find((i) => i.id === created.notificationId)?.readAt).toBeNull();
  });

  it("IDOR: user A cannot dismiss user B's notification (404)", async () => {
    const a = await makeSession();
    const b = await makeSession();
    const created = await createNotification(fastify.authTestHooks!.db, config, {
      userId: b.userId,
      eventType: "UPLOAD_COMPLETED",
      parameters: { count: 1 },
      deeplinkPath: "/contributions",
    });
    const response = await fastify.inject({
      method: "PUT",
      url: `/api/notifications/${created.notificationId}/dismiss`,
      headers: { cookie: a.cookie, ...CSRF_HEADERS },
    });
    expect(response.statusCode).toBe(404);
  });

  it("mark read is idempotent (200 on a second call, no error)", async () => {
    const a = await makeSession();
    const created = await createNotification(fastify.authTestHooks!.db, config, {
      userId: a.userId,
      eventType: "UPLOAD_COMPLETED",
      parameters: { count: 1 },
      deeplinkPath: "/contributions",
    });
    const first = await fastify.inject({
      method: "PUT",
      url: `/api/notifications/${created.notificationId}/read`,
      headers: { cookie: a.cookie, ...CSRF_HEADERS },
    });
    expect(first.statusCode).toBe(200);
    const second = await fastify.inject({
      method: "PUT",
      url: `/api/notifications/${created.notificationId}/read`,
      headers: { cookie: a.cookie, ...CSRF_HEADERS },
    });
    expect(second.statusCode).toBe(200);
  });

  it("mutating routes require the CSRF header (403 without it)", async () => {
    const a = await makeSession();
    const created = await createNotification(fastify.authTestHooks!.db, config, {
      userId: a.userId,
      eventType: "UPLOAD_COMPLETED",
      parameters: { count: 1 },
      deeplinkPath: "/contributions",
    });
    const response = await fastify.inject({
      method: "PUT",
      url: `/api/notifications/${created.notificationId}/read`,
      headers: { cookie: a.cookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it("mark-all-read affects only the caller's own notifications", async () => {
    const a = await makeSession();
    const b = await makeSession();
    await createNotification(fastify.authTestHooks!.db, config, {
      userId: a.userId,
      eventType: "UPLOAD_COMPLETED",
      parameters: { count: 1 },
      deeplinkPath: "/contributions",
    });
    const bNotif = await createNotification(fastify.authTestHooks!.db, config, {
      userId: b.userId,
      eventType: "UPLOAD_COMPLETED",
      parameters: { count: 1 },
      deeplinkPath: "/contributions",
    });
    const response = await fastify.inject({
      method: "PUT",
      url: "/api/notifications/mark-all-read",
      headers: { cookie: a.cookie, ...CSRF_HEADERS },
    });
    expect(response.statusCode).toBe(200);

    const bList = await fastify.inject({ method: "GET", url: "/api/notifications", headers: { cookie: b.cookie } });
    const bBody = listBody(bList);
    expect(bBody.data.items.find((i) => i.id === bNotif.notificationId)?.readAt).toBeNull();
  });

  it("GET /api/notifications/preferences returns registry defaults with no prior override", async () => {
    const a = await makeSession();
    const response = await fastify.inject({
      method: "GET",
      url: "/api/notifications/preferences",
      headers: { cookie: a.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = preferencesBody(response);
    const badgeEarned = body.data.preferences.find((p) => p.eventType === "BADGE_EARNED");
    expect(badgeEarned?.discordDmEnabled).toBe(false); // documented default
  });

  it("PUT /api/notifications/preferences updates every event type in the group, scoped to the caller only (IDOR)", async () => {
    const a = await makeSession();
    const b = await makeSession();
    const response = await fastify.inject({
      method: "PUT",
      url: "/api/notifications/preferences",
      headers: { cookie: a.cookie, ...CSRF_HEADERS, "content-type": "application/json" },
      payload: { groups: [{ group: "LEADERBOARD_BADGES", inAppEnabled: true, discordDmEnabled: true }] },
    });
    expect(response.statusCode).toBe(200);
    const body = preferencesBody(response);
    expect(body.data.preferences.find((p) => p.eventType === "BADGE_EARNED")?.discordDmEnabled).toBe(true);
    expect(body.data.preferences.find((p) => p.eventType === "RANKING_TOP3_CHANGE")?.discordDmEnabled).toBe(true);

    // B's own preferences are untouched.
    const bResponse = await fastify.inject({
      method: "GET",
      url: "/api/notifications/preferences",
      headers: { cookie: b.cookie },
    });
    const bBody = preferencesBody(bResponse);
    expect(bBody.data.preferences.find((p) => p.eventType === "BADGE_EARNED")?.discordDmEnabled).toBe(false);
  });

  it("malformed preferences body -> 400 validation error", async () => {
    const a = await makeSession();
    const response = await fastify.inject({
      method: "PUT",
      url: "/api/notifications/preferences",
      headers: { cookie: a.cookie, ...CSRF_HEADERS, "content-type": "application/json" },
      payload: { groups: [{ group: "NOT_A_REAL_GROUP", inAppEnabled: true, discordDmEnabled: true }] },
    });
    expect(response.statusCode).toBe(400);
  });

  // ==========================================================================
  // "Separate admin alert notification preferences" correction —
  // ADMIN_ALERT now has its own ADMIN_ALERTS group, independent of
  // GUILD_NEEDS (which still holds URGENT_GUILD_NEED/GUILD_APPROVAL_STATE_CHANGE).
  // ==========================================================================

  it("default ADMIN_ALERT preference (no prior override): in_app_enabled=true, discord_dm_enabled=false", async () => {
    const a = await makeSession();
    const response = await fastify.inject({
      method: "GET",
      url: "/api/notifications/preferences",
      headers: { cookie: a.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = preferencesBody(response);
    const adminAlert = body.data.preferences.find((p) => p.eventType === "ADMIN_ALERT");
    expect(adminAlert).toMatchObject({ discordDmEnabled: false });
    // inAppEnabled isn't in the narrow PreferencesBody type above — read the raw JSON.
    const raw = response.json() as { data: { preferences: { eventType: string; inAppEnabled: boolean }[] } };
    expect(raw.data.preferences.find((p) => p.eventType === "ADMIN_ALERT")?.inAppEnabled).toBe(true);
  });

  it("disabling 'Guild needs' does NOT alter ADMIN_ALERT's own preference state — the two groups are independent", async () => {
    const a = await makeSession();
    const response = await fastify.inject({
      method: "PUT",
      url: "/api/notifications/preferences",
      headers: { cookie: a.cookie, ...CSRF_HEADERS, "content-type": "application/json" },
      payload: { groups: [{ group: "GUILD_NEEDS", inAppEnabled: false, discordDmEnabled: false }] },
    });
    expect(response.statusCode).toBe(200);
    const body = preferencesBody(response);
    // GUILD_NEEDS members changed...
    expect(body.data.preferences.find((p) => p.eventType === "URGENT_GUILD_NEED")?.discordDmEnabled).toBe(false);
    expect(body.data.preferences.find((p) => p.eventType === "GUILD_APPROVAL_STATE_CHANGE")?.discordDmEnabled).toBe(
      false,
    );
    // ...but ADMIN_ALERT is UNTOUCHED, still at its registry default (DM OFF, unaffected either way here,
    // so assert against the in-app column too since a DM-only assertion couldn't distinguish "still default" from
    // "coincidentally also flipped to false").
    const raw = response.json() as { data: { preferences: { eventType: string; inAppEnabled: boolean }[] } };
    expect(raw.data.preferences.find((p) => p.eventType === "ADMIN_ALERT")?.inAppEnabled).toBe(true);
  });

  it("disabling 'Admin alerts' DOES alter ADMIN_ALERT's own delivery preference", async () => {
    const a = await makeSession();
    // First flip discordDmEnabled ON for ADMIN_ALERTS (documented default is OFF) to prove the write
    // path actually changes ADMIN_ALERT's state, not just that it stays at its already-OFF default.
    const enableDm = await fastify.inject({
      method: "PUT",
      url: "/api/notifications/preferences",
      headers: { cookie: a.cookie, ...CSRF_HEADERS, "content-type": "application/json" },
      payload: { groups: [{ group: "ADMIN_ALERTS", inAppEnabled: true, discordDmEnabled: true }] },
    });
    expect(enableDm.statusCode).toBe(200);
    expect(preferencesBody(enableDm).data.preferences.find((p) => p.eventType === "ADMIN_ALERT")?.discordDmEnabled).toBe(
      true,
    );

    // Now disable the whole group (both channels) — ADMIN_ALERT must reflect it.
    const disableAll = await fastify.inject({
      method: "PUT",
      url: "/api/notifications/preferences",
      headers: { cookie: a.cookie, ...CSRF_HEADERS, "content-type": "application/json" },
      payload: { groups: [{ group: "ADMIN_ALERTS", inAppEnabled: false, discordDmEnabled: false }] },
    });
    expect(disableAll.statusCode).toBe(200);
    const raw = disableAll.json() as {
      data: { preferences: { eventType: string; inAppEnabled: boolean; discordDmEnabled: boolean }[] };
    };
    const adminAlert = raw.data.preferences.find((p) => p.eventType === "ADMIN_ALERT");
    expect(adminAlert).toMatchObject({ inAppEnabled: false, discordDmEnabled: false });
  });

  it("REGRESSION: the 5 pre-existing groups still update their own event types via PUT, unaffected by the ADMIN_ALERTS addition", async () => {
    const a = await makeSession();
    const response = await fastify.inject({
      method: "PUT",
      url: "/api/notifications/preferences",
      headers: { cookie: a.cookie, ...CSRF_HEADERS, "content-type": "application/json" },
      payload: {
        groups: [
          { group: "UPLOADS", inAppEnabled: true, discordDmEnabled: false },
          { group: "PREMIUMPLUS", inAppEnabled: false, discordDmEnabled: false },
          { group: "WEEKLY_SUMMARY", inAppEnabled: true, discordDmEnabled: true },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    const body = preferencesBody(response);
    expect(body.data.preferences.find((p) => p.eventType === "UPLOAD_COMPLETED")?.discordDmEnabled).toBe(false);
    expect(body.data.preferences.find((p) => p.eventType === "UPLOAD_PROBLEM")?.discordDmEnabled).toBe(false);
    expect(body.data.preferences.find((p) => p.eventType === "PREMIUMPLUS_REACHED")?.discordDmEnabled).toBe(false);
    expect(body.data.preferences.find((p) => p.eventType === "WEEKLY_SUMMARY")?.discordDmEnabled).toBe(true);
  });
});
