/**
 * Full-flow integration tests for `/api/auth/*` — real MySQL (fresh DB per
 * suite run), a controlled local Discord OAuth test double for the outbound
 * "Discord" side (test/helpers/discordTestDouble.ts), and Fastify's
 * `inject()` (no real listening socket needed) for driving the app itself.
 *
 * IMPORTANT: this proves PROTOCOL/behavior correctness against a controlled
 * test double, not real Discord OAuth (31_TEST_STRATEGY.md's explicit
 * distinction, restated in this step's HANDOVER).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer } from "../../src/server.js";
import type { AppConfig } from "../../src/config.js";
import { runUp } from "../../migrations/runner.js";
import type { MigratorDbConfig } from "../../migrations/config.js";
import { startDiscordTestDouble, type DiscordTestDouble } from "../helpers/discordTestDouble.js";
import { serializeTransactionCookie, type OAuthTransaction } from "../../src/auth/transactionCookie.js";

const ROOT_CONFIG = {
  host: process.env.TEST_MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.TEST_MYSQL_PORT ?? 33070),
  user: "root",
  password: process.env.TEST_MYSQL_ROOT_PASSWORD ?? "devrootpass",
};
const TEST_DB_NAME = "bunny_cc_auth_routes_test";
const REAL_MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

const TRANSACTION_SIGNING_KEY = Buffer.alloc(32, 0x33);
const TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 0x44);

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

interface ParsedCookie {
  name: string;
  value: string;
  raw: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string | undefined;
  path: string | undefined;
  maxAge: number | undefined;
  expired: boolean; // Max-Age=0 or Expires in the past (clearCookie)
}

function parseSetCookieHeaders(headerValue: string | string[] | undefined): ParsedCookie[] {
  if (!headerValue) return [];
  const values = Array.isArray(headerValue) ? headerValue : [headerValue];
  return values.map((raw) => {
    const parts = raw.split(";").map((p) => p.trim());
    const [nameValue, ...attrParts] = parts;
    const eqIdx = nameValue!.indexOf("=");
    const name = nameValue!.slice(0, eqIdx);
    const value = nameValue!.slice(eqIdx + 1);
    const attrs = attrParts.map((a) => a.toLowerCase());
    const maxAgeAttr = attrParts.find((a) => a.toLowerCase().startsWith("max-age="));
    const maxAge = maxAgeAttr ? Number(maxAgeAttr.split("=")[1]) : undefined;
    return {
      name,
      value,
      raw,
      httpOnly: attrs.includes("httponly"),
      secure: attrs.includes("secure"),
      sameSite: attrParts.find((a) => a.toLowerCase().startsWith("samesite="))?.split("=")[1],
      path: attrParts.find((a) => a.toLowerCase().startsWith("path="))?.split("=")[1],
      maxAge,
      expired: maxAge === 0,
    };
  });
}

let dbConfig: MigratorDbConfig;
let discord: DiscordTestDouble;

function buildTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    logLevel: "info",
    appVersion: "0.1.0-scaffold-test",
    db: dbConfig,
    sse: {
      heartbeatSeconds: 30,
      pollIntervalMs: 5000,
      maxQueuedFramesPerConnection: 200,
      maxRowsPerSourcePerTick: 500,
    },
    discord: {
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      redirectUri: "http://127.0.0.1/api/auth/callback",
      scope: "identify guilds guilds.members.read",
      authorizeBaseUrl: "https://discord.com/oauth2/authorize",
      tokenUrl: discord.tokenUrl,
      apiBaseUrl: discord.apiBaseUrl,
    },
    session: {
      cookieName: "bcc_session",
      transactionCookieName: "bcc_oauth_txn",
      transactionSigningKey: TRANSACTION_SIGNING_KEY,
      tokenEncryptionKey: TOKEN_ENCRYPTION_KEY,
      slidingTtlMs: 30 * 24 * 60 * 60 * 1000,
      absoluteTtlMs: 90 * 24 * 60 * 60 * 1000,
      sweepIntervalMs: 60 * 60 * 1000,
    },
    ...overrides,
  };
}

type TestApp = Awaited<ReturnType<typeof buildServer>>;
let apps: TestApp[] = [];
async function buildApp(overrides: Partial<AppConfig> = {}): Promise<TestApp> {
  const app = await buildServer(buildTestConfig(overrides));
  apps.push(app);
  return app;
}

function findCookie(cookies: ParsedCookie[], name: string): ParsedCookie | undefined {
  return cookies.find((c) => c.name === name);
}

describe("/api/auth/* (real MySQL + local Discord test double)", () => {
  beforeAll(async () => {
    dbConfig = await freshDatabase();
    discord = await startDiscordTestDouble();
  });

  afterEach(async () => {
    discord.state.tokenExchangeStatus = undefined;
    discord.state.tokenExchangeBody = undefined;
    discord.state.identityStatus = undefined;
    discord.state.identityBody = undefined;
    discord.state.receivedTokenRequests = [];
    await Promise.all(apps.map((a) => a.close()));
    apps = [];
  });

  afterAll(async () => {
    await discord.close();
    const admin = await mysql.createConnection(ROOT_CONFIG);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB_NAME}\``);
    await admin.end();
  });

  // -----------------------------------------------------------------------
  // GET /api/auth/login
  // -----------------------------------------------------------------------
  describe("GET /api/auth/login", () => {
    it("redirects to Discord's authorize URL with PKCE challenge + state, and sets a signed transaction cookie", async () => {
      const app = await buildApp();
      const response = await app.inject({ method: "GET", url: "/api/auth/login" });
      expect(response.statusCode).toBe(302);
      const location = new URL(response.headers.location as string);
      expect(location.origin + location.pathname).toBe("https://discord.com/oauth2/authorize");
      expect(location.searchParams.get("client_id")).toBe("test-client-id");
      expect(location.searchParams.get("scope")).toBe("identify guilds guilds.members.read");
      expect(location.searchParams.get("code_challenge_method")).toBe("S256");
      expect(location.searchParams.get("state")).toBeTruthy();
      expect(location.searchParams.get("code_challenge")).toBeTruthy();

      const cookies = parseSetCookieHeaders(response.headers["set-cookie"]);
      const txnCookie = findCookie(cookies, "bcc_oauth_txn");
      expect(txnCookie).toBeDefined();
      expect(txnCookie!.httpOnly).toBe(true);
      expect(txnCookie!.secure).toBe(true);
      expect(txnCookie!.sameSite?.toLowerCase()).toBe("lax");
    });

    it("preserves a safe internal redirect target through the transaction", async () => {
      const app = await buildApp();
      const response = await app.inject({ method: "GET", url: "/api/auth/login?redirect=%2Fguilds%2F42" });
      const cookies = parseSetCookieHeaders(response.headers["set-cookie"]);
      // We can't decrypt the opaque cookie without the key from outside — but
      // we CAN prove the end-to-end effect via the full-flow test below,
      // which asserts the final post-login redirect target.
      expect(findCookie(cookies, "bcc_oauth_txn")).toBeDefined();
    });

    it("falls back to '/' for an unsafe (open-redirect) target instead of honoring it", async () => {
      const app = await buildApp();
      const loginResponse = await app.inject({
        method: "GET",
        url: "/api/auth/login?redirect=" + encodeURIComponent("https://evil.example.com"),
      });
      const cookies = parseSetCookieHeaders(loginResponse.headers["set-cookie"]);
      const txnCookie = findCookie(cookies, "bcc_oauth_txn")!;
      const location = new URL(loginResponse.headers.location as string);

      const callbackResponse = await app.inject({
        method: "GET",
        url: `/api/auth/callback?code=fakecode&state=${location.searchParams.get("state")}`,
        cookies: { bcc_oauth_txn: txnCookie.value },
      });
      expect(callbackResponse.statusCode).toBe(302);
      expect(callbackResponse.headers.location).toBe("/");
    });
  });

  // -----------------------------------------------------------------------
  // Full valid login flow
  // -----------------------------------------------------------------------
  it("VALID LOGIN FLOW: login -> callback -> durable user+session rows -> opaque cookie -> authenticated readback", async () => {
    const app = await buildApp();

    const loginResponse = await app.inject({ method: "GET", url: "/api/auth/login?redirect=%2Fguilds%2F42" });
    const loginCookies = parseSetCookieHeaders(loginResponse.headers["set-cookie"]);
    const txnCookie = findCookie(loginCookies, "bcc_oauth_txn")!;
    const location = new URL(loginResponse.headers.location as string);
    const state = location.searchParams.get("state")!;

    const callbackResponse = await app.inject({
      method: "GET",
      url: `/api/auth/callback?code=real-looking-code&state=${state}`,
      cookies: { bcc_oauth_txn: txnCookie.value },
    });

    expect(callbackResponse.statusCode).toBe(302);
    expect(callbackResponse.headers.location).toBe("/guilds/42"); // deep-link preserved

    const callbackCookies = parseSetCookieHeaders(callbackResponse.headers["set-cookie"]);
    const sessionCookie = findCookie(callbackCookies, "bcc_session")!;
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie.httpOnly).toBe(true);
    expect(sessionCookie.secure).toBe(true);
    expect(sessionCookie.sameSite?.toLowerCase()).toBe("lax");
    expect(sessionCookie.value.length).toBeGreaterThan(20);

    // The pre-auth transaction cookie must be cleared (single-use).
    const clearedTxnCookie = findCookie(callbackCookies, "bcc_oauth_txn");
    expect(clearedTxnCookie?.expired).toBe(true);

    // Discord test double received the real code/verifier pair.
    expect(discord.state.receivedTokenRequests).toHaveLength(1);
    expect(discord.state.receivedTokenRequests[0]!.code).toBe("real-looking-code");

    // Authenticated readback (24_API_CONTRACTS.md "current user/session" contract).
    const sessionResponse = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      cookies: { bcc_session: sessionCookie.value },
    });
    expect(sessionResponse.statusCode).toBe(200);
    const body = sessionResponse.json<{ data: { user: { discordUserId: string; username: string } } }>();
    expect(body.data.user.discordUserId).toBe("700000000001");
    expect(body.data.user.username).toBe("TestDiscordUser");

    // DURABLE effect: dashboard_users / dashboard_sessions rows exist.
    const conn = await mysql.createConnection(dbConfig);
    try {
      const [users] = await conn.query<mysql.RowDataPacket[]>(
        "SELECT * FROM dashboard_users WHERE discord_user_id = ?",
        ["700000000001"],
      );
      expect(users).toHaveLength(1);
      expect(users[0]!.discord_access_token_enc).not.toBeNull();
      // Never plaintext.
      expect(Buffer.from(users[0]!.discord_access_token_enc as Buffer).toString("utf-8")).not.toContain(
        "fake-access-token-value",
      );

      // >= 1 rather than exactly 1: the fixed test-double identity is shared
      // across other `it` blocks in this same file (e.g. the open-redirect
      // fallback test above also completes a real login), so more than one
      // durable session row for this one test-double user can legitimately
      // exist by this point in the suite — what matters here is that AT
      // LEAST one durable row exists for the user this callback just
      // authenticated, proving the durable-write half of the chain.
      const [sessions] = await conn.query<mysql.RowDataPacket[]>(
        "SELECT * FROM dashboard_sessions WHERE user_id = ?",
        [users[0]!.id],
      );
      expect(sessions.length).toBeGreaterThanOrEqual(1);
    } finally {
      await conn.end();
    }
  });

  // -----------------------------------------------------------------------
  // Security edge cases
  // -----------------------------------------------------------------------
  describe("security edge cases", () => {
    it("STATE MISMATCH: callback state not matching the transaction cookie's state -> redirected to login error, no session created", async () => {
      const app = await buildApp();
      const loginResponse = await app.inject({ method: "GET", url: "/api/auth/login" });
      const txnCookie = findCookie(
        parseSetCookieHeaders(loginResponse.headers["set-cookie"]),
        "bcc_oauth_txn",
      )!;

      const callbackResponse = await app.inject({
        method: "GET",
        url: "/api/auth/callback?code=somecode&state=totally-different-state",
        cookies: { bcc_oauth_txn: txnCookie.value },
      });
      expect(callbackResponse.statusCode).toBe(302);
      expect(callbackResponse.headers.location).toBe("/login?error=state_mismatch");
      expect(discord.state.receivedTokenRequests).toHaveLength(0);
    });

    it("MISSING TRANSACTION: callback with no transaction cookie at all fails closed", async () => {
      const app = await buildApp();
      const callbackResponse = await app.inject({
        method: "GET",
        url: "/api/auth/callback?code=somecode&state=some-state",
      });
      expect(callbackResponse.statusCode).toBe(302);
      expect(callbackResponse.headers.location).toBe("/login?error=state_mismatch");
    });

    it("TAMPERED TRANSACTION COOKIE: a forged cookie (wrong signature) fails closed", async () => {
      const app = await buildApp();
      const forged = "forged-payload.forged-signature";
      const callbackResponse = await app.inject({
        method: "GET",
        url: "/api/auth/callback?code=somecode&state=some-state",
        cookies: { bcc_oauth_txn: forged },
      });
      expect(callbackResponse.statusCode).toBe(302);
      expect(callbackResponse.headers.location).toBe("/login?error=state_mismatch");
    });

    it("EXPIRED TRANSACTION: an old (past max-age) transaction is rejected even with a valid signature/state", async () => {
      const app = await buildApp();
      const staleTxn: OAuthTransaction = {
        state: "stale-state-value",
        codeVerifier: "stale-verifier",
        redirect: "/",
        createdAtMs: Date.now() - 60 * 60 * 1000, // 1 hour ago, far past the 10-minute max age
      };
      const cookieValue = serializeTransactionCookie(staleTxn, TRANSACTION_SIGNING_KEY);
      const callbackResponse = await app.inject({
        method: "GET",
        url: "/api/auth/callback?code=somecode&state=stale-state-value",
        cookies: { bcc_oauth_txn: cookieValue },
      });
      expect(callbackResponse.statusCode).toBe(302);
      expect(callbackResponse.headers.location).toBe("/login?error=state_mismatch");
    });

    it("REPLAY: a second callback reusing the exact same (already-consumed) transaction is rejected, not silently re-issuing a session", async () => {
      const app = await buildApp();
      const loginResponse = await app.inject({ method: "GET", url: "/api/auth/login" });
      const txnCookie = findCookie(
        parseSetCookieHeaders(loginResponse.headers["set-cookie"]),
        "bcc_oauth_txn",
      )!;
      const location = new URL(loginResponse.headers.location as string);
      const state = location.searchParams.get("state")!;

      const first = await app.inject({
        method: "GET",
        url: `/api/auth/callback?code=replay-code&state=${state}`,
        cookies: { bcc_oauth_txn: txnCookie.value },
      });
      expect(first.statusCode).toBe(302);
      expect(first.headers.location).not.toContain("error=");

      // Replays the IDENTICAL original cookie value (as if an attacker captured it) a second time.
      const second = await app.inject({
        method: "GET",
        url: `/api/auth/callback?code=replay-code&state=${state}`,
        cookies: { bcc_oauth_txn: txnCookie.value },
      });
      expect(second.statusCode).toBe(302);
      expect(second.headers.location).toBe("/login?error=state_mismatch");
      // Only ONE token exchange actually happened.
      expect(discord.state.receivedTokenRequests).toHaveLength(1);
    });

    it("CONCURRENT REPLAY: two simultaneous callbacks with the same transaction -> exactly one succeeds", async () => {
      const app = await buildApp();
      const loginResponse = await app.inject({ method: "GET", url: "/api/auth/login" });
      const txnCookie = findCookie(
        parseSetCookieHeaders(loginResponse.headers["set-cookie"]),
        "bcc_oauth_txn",
      )!;
      const location = new URL(loginResponse.headers.location as string);
      const state = location.searchParams.get("state")!;

      const [r1, r2] = await Promise.all([
        app.inject({
          method: "GET",
          url: `/api/auth/callback?code=concurrent-code&state=${state}`,
          cookies: { bcc_oauth_txn: txnCookie.value },
        }),
        app.inject({
          method: "GET",
          url: `/api/auth/callback?code=concurrent-code&state=${state}`,
          cookies: { bcc_oauth_txn: txnCookie.value },
        }),
      ]);
      const outcomes = [r1, r2].map((r) =>
        r.headers.location === "/login?error=state_mismatch" ? "rejected" : "accepted",
      );
      expect(outcomes.filter((o) => o === "accepted")).toHaveLength(1);
      expect(outcomes.filter((o) => o === "rejected")).toHaveLength(1);
    });

    it("OAUTH DENIAL: Discord's own ?error= query param maps to a generic i18n'd denial, never a raw Discord string", async () => {
      const app = await buildApp();
      const callbackResponse = await app.inject({
        method: "GET",
        url: "/api/auth/callback?error=access_denied&error_description=The+user+denied+the+request",
      });
      expect(callbackResponse.statusCode).toBe(302);
      expect(callbackResponse.headers.location).toBe("/login?error=oauth_denied");
    });

    it("TOKEN EXCHANGE FAILURE: Discord's token endpoint returning an error status fails closed with the documented message key", async () => {
      discord.state.tokenExchangeStatus = 400;
      discord.state.tokenExchangeBody = { error: "invalid_grant" };
      const app = await buildApp();
      const loginResponse = await app.inject({ method: "GET", url: "/api/auth/login" });
      const txnCookie = findCookie(
        parseSetCookieHeaders(loginResponse.headers["set-cookie"]),
        "bcc_oauth_txn",
      )!;
      const location = new URL(loginResponse.headers.location as string);
      const state = location.searchParams.get("state")!;

      const callbackResponse = await app.inject({
        method: "GET",
        url: `/api/auth/callback?code=bad-code&state=${state}`,
        cookies: { bcc_oauth_txn: txnCookie.value },
      });
      expect(callbackResponse.statusCode).toBe(302);
      expect(callbackResponse.headers.location).toBe("/login?error=token_exchange_failed");
    });

    it("INVALID DISCORD RESPONSE: identity endpoint returning a malformed body fails closed", async () => {
      discord.state.identityStatus = 200;
      discord.state.identityBody = { not_a_valid_shape: true };
      const app = await buildApp();
      const loginResponse = await app.inject({ method: "GET", url: "/api/auth/login" });
      const txnCookie = findCookie(
        parseSetCookieHeaders(loginResponse.headers["set-cookie"]),
        "bcc_oauth_txn",
      )!;
      const location = new URL(loginResponse.headers.location as string);
      const state = location.searchParams.get("state")!;

      const callbackResponse = await app.inject({
        method: "GET",
        url: `/api/auth/callback?code=some-code&state=${state}`,
        cookies: { bcc_oauth_txn: txnCookie.value },
      });
      expect(callbackResponse.statusCode).toBe(302);
      expect(callbackResponse.headers.location).toBe("/login?error=token_exchange_failed");
    });

    it("no Discord/session secret ever appears in any response body or header (30_OBSERVABILITY_AND_AUDIT.md's 'never logged' list is verified separately by code review: routes.ts's only auth-flow log line is a fixed boolean marker, never a token value)", async () => {
      const app = await buildApp();
      const loginResponse = await app.inject({ method: "GET", url: "/api/auth/login" });
      const txnCookie = findCookie(
        parseSetCookieHeaders(loginResponse.headers["set-cookie"]),
        "bcc_oauth_txn",
      )!;
      const location = new URL(loginResponse.headers.location as string);
      const state = location.searchParams.get("state")!;

      const callbackResponse = await app.inject({
        method: "GET",
        url: `/api/auth/callback?code=leak-check-code&state=${state}`,
        cookies: { bcc_oauth_txn: txnCookie.value },
      });
      const sessionCookie = findCookie(
        parseSetCookieHeaders(callbackResponse.headers["set-cookie"]),
        "bcc_session",
      )!;

      const sessionResponse = await app.inject({
        method: "GET",
        url: "/api/auth/session",
        cookies: { bcc_session: sessionCookie.value },
      });

      const haystacks = [
        JSON.stringify(callbackResponse.headers),
        callbackResponse.body,
        JSON.stringify(sessionResponse.headers),
        sessionResponse.body,
      ].join("\n");

      expect(haystacks).not.toContain("fake-access-token-value");
      expect(haystacks).not.toContain("fake-refresh-token-value");
      expect(haystacks).not.toContain("test-client-secret");
    });
  });

  // -----------------------------------------------------------------------
  // requireAuth gate
  // -----------------------------------------------------------------------
  it("GET /api/auth/session without a session cookie -> 401, fails closed", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/auth/session" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error_code: "UNAUTHENTICATED" });
  });

  it("GET /api/auth/session with a garbage/forged session cookie -> 401, fails closed", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      cookies: { bcc_session: "not-a-real-token-at-all" },
    });
    expect(response.statusCode).toBe(401);
  });

  // -----------------------------------------------------------------------
  // Logout / logout-all / individual session management
  // -----------------------------------------------------------------------
  describe("logout / session management", () => {
    async function loginAndGetSessionCookie(app: TestApp): Promise<string> {
      const loginResponse = await app.inject({ method: "GET", url: "/api/auth/login" });
      const txnCookie = findCookie(
        parseSetCookieHeaders(loginResponse.headers["set-cookie"]),
        "bcc_oauth_txn",
      )!;
      const location = new URL(loginResponse.headers.location as string);
      const state = location.searchParams.get("state")!;
      const callbackResponse = await app.inject({
        method: "GET",
        url: `/api/auth/callback?code=login-code-${Math.random()}&state=${state}`,
        cookies: { bcc_oauth_txn: txnCookie.value },
      });
      return findCookie(parseSetCookieHeaders(callbackResponse.headers["set-cookie"]), "bcc_session")!.value;
    }

    it("mutating auth routes require the CSRF header (defense-in-depth beyond SameSite=Lax)", async () => {
      const app = await buildApp();
      const sessionCookie = await loginAndGetSessionCookie(app);
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        cookies: { bcc_session: sessionCookie },
        // Deliberately omits X-Requested-With.
      });
      expect(response.statusCode).toBe(403);
    });

    it("POST /api/auth/logout invalidates the current session — DB row deleted, cookie cleared, subsequent reads 401", async () => {
      const app = await buildApp();
      const sessionCookie = await loginAndGetSessionCookie(app);

      const logoutResponse = await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        cookies: { bcc_session: sessionCookie },
        headers: { "x-requested-with": "BunnyCommandCenter" },
      });
      expect(logoutResponse.statusCode).toBe(200);
      const clearedCookie = findCookie(
        parseSetCookieHeaders(logoutResponse.headers["set-cookie"]),
        "bcc_session",
      );
      expect(clearedCookie?.expired).toBe(true);

      const readback = await app.inject({
        method: "GET",
        url: "/api/auth/session",
        cookies: { bcc_session: sessionCookie },
      });
      expect(readback.statusCode).toBe(401);
    });

    it("POST /api/auth/logout-all invalidates EVERY session for that user, not just the current one", async () => {
      const app = await buildApp();
      const sessionA = await loginAndGetSessionCookie(app);
      const sessionB = await loginAndGetSessionCookie(app); // same Discord user (test double is fixed identity) -> second device

      const logoutAllResponse = await app.inject({
        method: "POST",
        url: "/api/auth/logout-all",
        cookies: { bcc_session: sessionA },
        headers: { "x-requested-with": "BunnyCommandCenter" },
      });
      expect(logoutAllResponse.statusCode).toBe(200);
      expect(
        logoutAllResponse.json<{ data: { revokedCount: number } }>().data.revokedCount,
      ).toBeGreaterThanOrEqual(2);

      const readbackA = await app.inject({
        method: "GET",
        url: "/api/auth/session",
        cookies: { bcc_session: sessionA },
      });
      const readbackB = await app.inject({
        method: "GET",
        url: "/api/auth/session",
        cookies: { bcc_session: sessionB },
      });
      expect(readbackA.statusCode).toBe(401);
      expect(readbackB.statusCode).toBe(401);
    });

    it("GET /api/auth/sessions lists devices; DELETE /api/auth/sessions/:id revokes exactly one, leaving the other valid", async () => {
      const app = await buildApp();
      const sessionA = await loginAndGetSessionCookie(app);
      const sessionB = await loginAndGetSessionCookie(app);

      const listResponse = await app.inject({
        method: "GET",
        url: "/api/auth/sessions",
        cookies: { bcc_session: sessionA },
      });
      expect(listResponse.statusCode).toBe(200);
      const list = listResponse.json<{ data: { id: string; isCurrent: boolean }[] }>().data;
      expect(list.length).toBeGreaterThanOrEqual(2);
      const other = list.find((s) => !s.isCurrent)!;
      expect(other).toBeDefined();

      const revokeResponse = await app.inject({
        method: "DELETE",
        url: `/api/auth/sessions/${other.id}`,
        cookies: { bcc_session: sessionA },
        headers: { "x-requested-with": "BunnyCommandCenter" },
      });
      expect(revokeResponse.statusCode).toBe(200);

      // sessionA (current) still valid; sessionB (revoked) is not.
      const readbackA = await app.inject({
        method: "GET",
        url: "/api/auth/session",
        cookies: { bcc_session: sessionA },
      });
      const readbackB = await app.inject({
        method: "GET",
        url: "/api/auth/session",
        cookies: { bcc_session: sessionB },
      });
      expect(readbackA.statusCode).toBe(200);
      expect(readbackB.statusCode).toBe(401);
    });

    it("DELETE /api/auth/sessions/:id for a nonexistent id -> 404", async () => {
      const app = await buildApp();
      const sessionA = await loginAndGetSessionCookie(app);
      const response = await app.inject({
        method: "DELETE",
        url: "/api/auth/sessions/0000000000000000000000000000000000000000000000000000000000000000",
        cookies: { bcc_session: sessionA },
        headers: { "x-requested-with": "BunnyCommandCenter" },
      });
      expect(response.statusCode).toBe(404);
    });
  });
});
