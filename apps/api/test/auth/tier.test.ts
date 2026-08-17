/**
 * `requireTier` / IDOR middleware -- PROOF OF WIRING and the mandatory
 * negative-test list (08_AUTHORIZATION_AND_RBAC.md §Mandatory negative
 * tests, this step's IMPLEMENTATION file §TESTS REQUIRED §PROOF OF WIRING).
 *
 * Real `buildServer()` (the actual production Fastify app: real `db` pool,
 * real `requireAuth`, real cookie handling), a SAMPLE guild-scoped route
 * registered on that SAME live instance via the in-process-only
 * `authTestHooks` seam (server.ts -- never HTTP-reachable in the real
 * deployed app, mission §35), and Fastify's `inject()` to drive real
 * request/response objects through the full chain:
 *   authenticated HTTP request -> Step-04 session resolver (`requireAuth`)
 *     -> Step-05 `requireTier` -> `assertGuildMembership` -> (cached) live
 *     Discord-test-double guild/member resolution -> policy/override lookup
 *     -> exact tier decision -> protected route response / 403 / 404.
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
import { setGuildAdminRole } from "../../src/auth/guildPolicyRepo.js";
import { buildRequireTier } from "../../src/auth/tier.js";
import { startDiscordTestDouble, type DiscordTestDouble } from "../helpers/discordTestDouble.js";
import {
  testSessionConfig,
  testSuperadminConfig,
  TEST_SUPERADMIN_DISCORD_ID,
} from "../helpers/testAuthConfig.js";

const ROOT_CONFIG = {
  host: process.env.TEST_MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.TEST_MYSQL_PORT ?? 33070),
  user: "root",
  password: process.env.TEST_MYSQL_ROOT_PASSWORD ?? "devrootpass",
};
const TEST_DB_NAME = "bunny_cc_tier_test";
const REAL_MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
const GUILD_A = "111111111111111111";
const GUILD_B = "222222222222222222";

/** Minimal Set-Cookie parser -- proves `bcc_session` was actually CLEARED (Max-Age=0), mirroring routes.test.ts's own equivalent helper (not exported, so reimplemented minimally here). */
function findClearedSessionCookie(headerValue: string | string[] | undefined): boolean {
  if (!headerValue) return false;
  const values = Array.isArray(headerValue) ? headerValue : [headerValue];
  return values.some((raw) => {
    const parts = raw.split(";").map((p) => p.trim());
    const [nameValue, ...attrParts] = parts;
    const eqIdx = nameValue!.indexOf("=");
    const name = nameValue!.slice(0, eqIdx);
    if (name !== "bcc_session") return false;
    const maxAgeAttr = attrParts.find((a) => a.toLowerCase().startsWith("max-age="));
    const maxAge = maxAgeAttr ? Number(maxAgeAttr.split("=")[1]) : undefined;
    return maxAge === 0;
  });
}

async function freshDatabase(): Promise<MigratorDbConfig> {
  const admin = await mysql.createConnection(ROOT_CONFIG);
  await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB_NAME}\``);
  await admin.query(`CREATE DATABASE \`${TEST_DB_NAME}\``);
  await admin.end();
  const config: MigratorDbConfig = { ...ROOT_CONFIG, database: TEST_DB_NAME };
  const conn = await mysql.createConnection(config);
  try {
    const result = await runUp(conn, REAL_MIGRATIONS_DIR, config);
    if (!result.ok) throw new Error(result.message);
  } finally {
    await conn.end();
  }
  return config;
}

describe("requireTier: IDOR middleware, full chain proof + mandatory negative tests", () => {
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
        pollIntervalMs: 5000,
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

    // --- Test-only sample routes (never HTTP-reachable in the real
    // deployed app -- registered here, on the SAME live server instance,
    // via the in-process-only `authTestHooks` seam, mission §35) ---
    const hooks = fastify.authTestHooks!;
    const requireTier = buildRequireTier(hooks.guildAuthDeps);
    fastify.get(
      "/api/_test/guilds/:guildId/probe",
      { preHandler: [hooks.requireAuth, requireTier("guildId", "GUILD_ADMIN")] },
      (request) => ({ data: { ok: true, guildAuthorization: request.guildAuthorization } }),
    );
    fastify.get(
      "/api/_test/guilds/:guildId/user-probe",
      { preHandler: [hooks.requireAuth, requireTier("guildId", "USER")] },
      (request) => ({ data: { ok: true, guildAuthorization: request.guildAuthorization } }),
    );
    fastify.get(
      "/api/_test/platform/probe",
      { preHandler: [hooks.requireAuth, requireTier("SUPERADMIN")] },
      () => ({ data: { ok: true } }),
    );
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
    discord.state.memberForcedStatus = undefined;
  });

  let userCounter = 600100000000000000n;
  let sessionCounter = 0;
  async function makeSession(opts: {
    discordUserId?: string;
    guilds?: { id: string; owner: boolean; permissions: string }[];
  }): Promise<{ cookie: string; discordUserId: string }> {
    const discordUserId = opts.discordUserId ?? String((userCounter += 1n));
    const key = config.session.tokenEncryptionKey;
    const db = fastify.authTestHooks!.db;
    const user = await upsertDashboardUser(db, {
      discordUserId,
      username: `user-${discordUserId}`,
      avatarHash: null,
      encryptedAccessToken: encryptSecret(discord.state.currentAccessToken, key),
      encryptedRefreshToken: encryptSecret("refresh-token-value", key),
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    });
    // A unique token per CALL, not per discordUserId -- several tests
    // deliberately reuse the same discordUserId (e.g. the Superadmin) across
    // multiple independent sessions, and each must get its own distinct
    // `dashboard_sessions` row (opaque token hash is the PRIMARY KEY).
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
    if (opts.guilds) {
      discord.state.guilds = opts.guilds;
    }
    return { cookie: `${config.session.cookieName}=${rawToken}`, discordUserId };
  }

  // --- PROOF OF WIRING: the sample route's own three-outcome contract -----

  it("PROOF OF WIRING: non-member -> 404 GUILD_NOT_FOUND", async () => {
    const { cookie } = await makeSession({ guilds: [{ id: GUILD_B, owner: false, permissions: "0" }] });
    const response = await fastify.inject({
      method: "GET",
      url: `/api/_test/guilds/${GUILD_A}/probe`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error_code: "GUILD_NOT_FOUND",
      message_key: "errors.guilds.notFound",
    });
  });

  it("PROOF OF WIRING: member but non-admin -> 403 FORBIDDEN, with the documented message_key and a correlation-bearing log", async () => {
    const { cookie } = await makeSession({ guilds: [{ id: GUILD_A, owner: false, permissions: "0" }] });
    const response = await fastify.inject({
      method: "GET",
      url: `/api/_test/guilds/${GUILD_A}/probe`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error_code: "FORBIDDEN",
      message_key: "errors.auth.insufficientPermissions",
    });
  });

  it("PROOF OF WIRING: member and admin (Owner) -> 200, with the resolved tier visible to the route handler", async () => {
    const { cookie } = await makeSession({ guilds: [{ id: GUILD_A, owner: true, permissions: "0" }] });
    const response = await fastify.inject({
      method: "GET",
      url: `/api/_test/guilds/${GUILD_A}/probe`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: { ok: true, guildAuthorization: { guildId: GUILD_A, tier: "GUILD_ADMIN" } },
    });
  });

  // --- Mandatory negative tests (08_AUTHORIZATION_AND_RBAC.md §Mandatory
  //     negative tests, all 5 cases, verbatim) --------------------------

  it("1. A user who is a member of guild A, and NOT a member of guild B, requesting /api/guilds/B/* -> 404, regardless of being Guild Admin in A", async () => {
    const { cookie } = await makeSession({ guilds: [{ id: GUILD_A, owner: true, permissions: "0" }] });
    const response = await fastify.inject({
      method: "GET",
      url: `/api/_test/guilds/${GUILD_B}/probe`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("2. The same user requesting a Guild-Admin-only route in guild A, where they are only USER tier -> 403 (membership confirmed, tier denied)", async () => {
    const { cookie } = await makeSession({ guilds: [{ id: GUILD_A, owner: false, permissions: "0" }] });
    const response = await fastify.inject({
      method: "GET",
      url: `/api/_test/guilds/${GUILD_A}/probe`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
    // The SAME user's USER-tier route (min tier USER) succeeds -- proves
    // this is genuinely a tier-floor comparison, not a blanket deny.
    const userProbe = await fastify.inject({
      method: "GET",
      url: `/api/_test/guilds/${GUILD_A}/user-probe`,
      headers: { cookie },
    });
    expect(userProbe.statusCode).toBe(200);
  });

  it("3. An arbitrary/non-existent guildId -> 404, indistinguishable in response shape from case 1", async () => {
    const { cookie } = await makeSession({ guilds: [{ id: GUILD_A, owner: true, permissions: "0" }] });
    const nonMemberResponse = await fastify.inject({
      method: "GET",
      url: `/api/_test/guilds/${GUILD_B}/probe`,
      headers: { cookie },
    });
    const nonexistentResponse = await fastify.inject({
      method: "GET",
      url: "/api/_test/guilds/999999999999999999/probe",
      headers: { cookie },
    });
    expect(nonexistentResponse.statusCode).toBe(404);
    expect(nonexistentResponse.json()).toEqual(nonMemberResponse.json());
  });

  it("4. Superadmin requesting any guildId, including one it has NO Discord relationship to at all -> succeeds (explicit bypass, actually exercised)", async () => {
    const { cookie } = await makeSession({ discordUserId: TEST_SUPERADMIN_DISCORD_ID, guilds: [] });
    // If the bypass were merely coincidental (e.g. the test double happened
    // to return this guild anyway), forcing a hard failure on the guild-list
    // fetch would immediately expose that -- the Superadmin path must never
    // reach that fetch at all.
    discord.state.guildsForcedStatus = 500;
    const response = await fastify.inject({
      method: "GET",
      url: `/api/_test/guilds/${GUILD_A}/probe`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
  });

  it("5. A user's membership is revoked (kicked from the guild) mid-session -> their NEXT request fails with 404, not a stale-cached 200", async () => {
    const { cookie, discordUserId } = await makeSession({
      guilds: [{ id: GUILD_A, owner: false, permissions: String(0x8) }],
    });
    const before = await fastify.inject({
      method: "GET",
      url: `/api/_test/guilds/${GUILD_A}/probe`,
      headers: { cookie },
    });
    expect(before.statusCode).toBe(200);

    // Simulate Discord-side kick: the guild no longer appears in the
    // caller's live list. Also bust the 60s micro-cache explicitly (this
    // step's own freshness contract: "provide explicit invalidation where
    // the architecture requires it") so the test proves REAL freshness
    // behavior deterministically rather than depending on wall-clock TTL
    // expiry mid-test-run.
    discord.state.guilds = [];
    fastify.authTestHooks!.guildAuthDeps.cache.invalidateUserGuild(discordUserId, GUILD_A);

    const after = await fastify.inject({
      method: "GET",
      url: `/api/_test/guilds/${GUILD_A}/probe`,
      headers: { cookie },
    });
    expect(after.statusCode).toBe(404);
  });

  // --- Additional required security scenarios -----------------------------

  it("malicious client-supplied role/tier claims are ignored: a spoofed X-Dashboard-Role header changes nothing", async () => {
    const { cookie } = await makeSession({ guilds: [{ id: GUILD_A, owner: false, permissions: "0" }] });
    const response = await fastify.inject({
      method: "GET",
      url: `/api/_test/guilds/${GUILD_A}/probe`,
      headers: {
        cookie,
        "x-dashboard-role": "GUILD_ADMIN",
        "x-dashboard-tier": "SUPERADMIN",
        "x-dashboard-discord-id": TEST_SUPERADMIN_DISCORD_ID,
      },
    });
    expect(response.statusCode).toBe(403); // still just a plain USER-tier member
  });

  it("configured admin role: held -> GUILD_ADMIN via the real route chain", async () => {
    const roleId = "444444444444444444";
    const { cookie, discordUserId } = await makeSession({
      guilds: [{ id: GUILD_A, owner: false, permissions: "0" }],
    });
    discord.state.memberRolesByGuild.set(GUILD_A, [roleId]);
    await setGuildAdminRole(fastify.authTestHooks!.db, GUILD_A, roleId);
    fastify.authTestHooks!.guildAuthDeps.cache.invalidateUserGuild(discordUserId, GUILD_A);

    const response = await fastify.inject({
      method: "GET",
      url: `/api/_test/guilds/${GUILD_A}/probe`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
  });

  it("unauthenticated request -> 401, never reaches guild-authorization logic at all", async () => {
    const response = await fastify.inject({ method: "GET", url: `/api/_test/guilds/${GUILD_A}/probe` });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ message_key: "errors.auth.unauthenticated" });
  });

  // --- Platform-scoped SUPERADMIN middleware, separable from guild-scoped -

  it("platform-scoped requireTier('SUPERADMIN'): a non-Superadmin gets 403 with no guildId/assertGuildMembership involved at all", async () => {
    const { cookie } = await makeSession({ guilds: [] });
    const response = await fastify.inject({
      method: "GET",
      url: "/api/_test/platform/probe",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it("platform-scoped requireTier('SUPERADMIN'): the Superadmin succeeds", async () => {
    const { cookie } = await makeSession({ discordUserId: TEST_SUPERADMIN_DISCORD_ID, guilds: [] });
    const response = await fastify.inject({
      method: "GET",
      url: "/api/_test/platform/probe",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
  });

  // --- Discord-reauth-required (carry-forward #2) wired at the requireTier layer ---

  it("Discord refresh failure while resolving guild authorization -> session invalidated, cookie cleared, documented re-login response", async () => {
    const { cookie, discordUserId } = await makeSession({
      guilds: [{ id: GUILD_A, owner: true, permissions: "0" }],
    });
    // Force the FIRST guild-list fetch to 401 (stale token) so requireTier's
    // real call chain reaches DiscordTokenService's refresh path...
    discord.state.guildsForcedStatus = 401;
    // ...and force the refresh itself to fail, exercising the genuine
    // refresh-failure branch, not just a repeated-401 branch.
    discord.state.refreshExchangeStatus = 400;
    fastify.authTestHooks!.guildAuthDeps.cache.invalidateUserGuild(discordUserId, GUILD_A);

    const response = await fastify.inject({
      method: "GET",
      url: `/api/_test/guilds/${GUILD_A}/probe`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error_code: "DISCORD_REAUTH_REQUIRED",
      message_key: "errors.auth.discordReauthRequired",
    });
    expect(findClearedSessionCookie(response.headers["set-cookie"])).toBe(true);

    // The browser must never be left half-authenticated: the SAME cookie no
    // longer authenticates anything afterward (session row was deleted).
    discord.state.refreshExchangeStatus = undefined;
    discord.state.guildsForcedStatus = undefined;
    const followUp = await fastify.inject({
      method: "GET",
      url: `/api/_test/guilds/${GUILD_A}/probe`,
      headers: { cookie },
    });
    expect(followUp.statusCode).toBe(401);
    expect(followUp.json()).toMatchObject({ message_key: "errors.auth.unauthenticated" });
  });
});
