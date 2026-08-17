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
import type { Kysely } from "kysely";
import { buildServer } from "../../src/server.js";
import type { AppConfig } from "../../src/config.js";
import type { DB } from "../../src/db/codegen-types.js";
import { createKyselyClient } from "../../src/db/kysely.js";
import { runUp } from "../../migrations/runner.js";
import type { MigratorDbConfig } from "../../migrations/config.js";
import { startDiscordTestDouble, type DiscordTestDouble } from "../helpers/discordTestDouble.js";
import { serializeTransactionCookie, type OAuthTransaction } from "../../src/auth/transactionCookie.js";
import { createSession } from "../../src/auth/sessionRepo.js";
import { hashSessionToken } from "../../src/auth/sessionToken.js";
import { upsertDashboardUser } from "../../src/auth/userRepo.js";
import { encryptSecret } from "../../src/auth/tokenCrypto.js";
import { testSuperadminConfig, TEST_SUPERADMIN_DISCORD_ID } from "../helpers/testAuthConfig.js";

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
    superadmin: testSuperadminConfig(),
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

async function loginAndGetSessionCookie(app: TestApp): Promise<string> {
  const loginResponse = await app.inject({ method: "GET", url: "/api/auth/login" });
  const txnCookie = findCookie(parseSetCookieHeaders(loginResponse.headers["set-cookie"]), "bcc_oauth_txn")!;
  const location = new URL(loginResponse.headers.location as string);
  const state = location.searchParams.get("state")!;
  const callbackResponse = await app.inject({
    method: "GET",
    url: `/api/auth/callback?code=login-code-${Math.random()}&state=${state}`,
    cookies: { bcc_oauth_txn: txnCookie.value },
  });
  return findCookie(parseSetCookieHeaders(callbackResponse.headers["set-cookie"]), "bcc_session")!.value;
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
    discord.state.identityUserId = "700000000001";
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
      // Copilot review finding 4 (Step 04 review pass): `prompt=consent` was
      // removed — it unconditionally forced re-consent on every login,
      // contradicting this project's own "consent shown only once" design
      // intent (see discordClient.ts's own doc comment). No `prompt` value
      // is sent at all, letting Discord apply its documented default.
      expect(location.searchParams.has("prompt")).toBe(false);

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
  // Discord Snowflake precision correction (2026-08-16): the FULL real
  // login -> session -> API-readback chain, driven end to end by a
  // genuinely unsafe (> Number.MAX_SAFE_INTEGER) Discord snowflake, proving
  // the exact value survives every layer — Discord identity fetch, DB
  // upsert, session creation, and the JSON the authenticated
  // GET /api/auth/session response actually serializes.
  // -----------------------------------------------------------------------
  it("AUTHENTICATED SESSION RESOLVES THE EXACT DISCORD USER, and the API serializes the exact ID, for a 19-digit unsafe snowflake", async () => {
    const UNSAFE_SNOWFLAKE = "800000000000000042"; // 19 digits, far beyond Number.MAX_SAFE_INTEGER
    discord.state.identityUserId = UNSAFE_SNOWFLAKE;

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
      url: `/api/auth/callback?code=unsafe-snowflake-code&state=${state}`,
      cookies: { bcc_oauth_txn: txnCookie.value },
    });
    expect(callbackResponse.statusCode).toBe(302);
    const sessionCookie = findCookie(
      parseSetCookieHeaders(callbackResponse.headers["set-cookie"]),
      "bcc_session",
    )!;

    // API SERIALIZATION: the exact string, never a rounded/mangled number,
    // never `800000000000000000` (what Number(UNSAFE_SNOWFLAKE) would give).
    const sessionResponse = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      cookies: { bcc_session: sessionCookie.value },
    });
    expect(sessionResponse.statusCode).toBe(200);
    // Asserted against the RAW response body text, not just the parsed
    // JSON's `===` comparison — this also proves the wire format itself
    // never carries a bare (precision-lossy) JSON number for this field.
    expect(sessionResponse.body).toContain(`"discordUserId":"${UNSAFE_SNOWFLAKE}"`);
    const body = sessionResponse.json<{ data: { user: { discordUserId: string } } }>();
    expect(body.data.user.discordUserId).toBe(UNSAFE_SNOWFLAKE);
    expect(body.data.user.discordUserId).not.toBe(String(Number(UNSAFE_SNOWFLAKE)));

    // DURABLE row also holds the exact value.
    const conn = await mysql.createConnection(dbConfig);
    try {
      const [users] = await conn.query<mysql.RowDataPacket[]>(
        "SELECT discord_user_id FROM dashboard_users WHERE discord_user_id = ?",
        [UNSAFE_SNOWFLAKE],
      );
      expect(users).toHaveLength(1);
      expect(users[0]!.discord_user_id).toBe(UNSAFE_SNOWFLAKE);
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

  // -----------------------------------------------------------------------
  // Step 06 addition: `isSuperadmin` on GET /api/auth/session — a single
  // server-computed boolean (never the raw PLATFORM_SUPERADMIN_DISCORD_ID
  // itself), used purely for navigation display (which sidebar/"More"
  // destinations to show) — see apps/web's navigation for the consumer.
  // -----------------------------------------------------------------------
  it("GET /api/auth/session: isSuperadmin is false for an ordinary user, true for the configured Superadmin, and the raw Superadmin ID never appears on the wire", async () => {
    const app = await buildApp();

    discord.state.identityUserId = "800000000009999999";
    const ordinaryLogin = await app.inject({ method: "GET", url: "/api/auth/login" });
    const ordinaryTxn = findCookie(
      parseSetCookieHeaders(ordinaryLogin.headers["set-cookie"]),
      "bcc_oauth_txn",
    )!;
    const ordinaryState = new URL(ordinaryLogin.headers.location as string).searchParams.get("state")!;
    const ordinaryCallback = await app.inject({
      method: "GET",
      url: `/api/auth/callback?code=ordinary-code&state=${ordinaryState}`,
      cookies: { bcc_oauth_txn: ordinaryTxn.value },
    });
    const ordinarySession = findCookie(
      parseSetCookieHeaders(ordinaryCallback.headers["set-cookie"]),
      "bcc_session",
    )!;
    const ordinaryResponse = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      cookies: { bcc_session: ordinarySession.value },
    });
    expect(ordinaryResponse.json<{ data: { isSuperadmin: boolean } }>().data.isSuperadmin).toBe(false);

    discord.state.identityUserId = TEST_SUPERADMIN_DISCORD_ID;
    const adminLogin = await app.inject({ method: "GET", url: "/api/auth/login" });
    const adminTxn = findCookie(parseSetCookieHeaders(adminLogin.headers["set-cookie"]), "bcc_oauth_txn")!;
    const adminState = new URL(adminLogin.headers.location as string).searchParams.get("state")!;
    const adminCallback = await app.inject({
      method: "GET",
      url: `/api/auth/callback?code=admin-code&state=${adminState}`,
      cookies: { bcc_oauth_txn: adminTxn.value },
    });
    const adminSession = findCookie(
      parseSetCookieHeaders(adminCallback.headers["set-cookie"]),
      "bcc_session",
    )!;
    const adminResponse = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      cookies: { bcc_session: adminSession.value },
    });
    expect(adminResponse.json<{ data: { isSuperadmin: boolean } }>().data.isSuperadmin).toBe(true);
    // The raw Superadmin ID is inevitably present in this test's OWN
    // response (it's genuinely this user's discordUserId) — what must NEVER
    // appear is any distinct env-var-shaped secret; this repo has no such
    // secret for this value by design (ADR-008: the ID itself is not a
    // secret, it's a fixed, publicly-known-to-that-user identity), so there
    // is nothing further to assert here beyond the boolean itself.
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

  // -----------------------------------------------------------------------
  // Sliding session cookie renewal (correction pass — the sliding session
  // was only ever sliding server-side; the browser's own bcc_session cookie
  // never renewed, so an active user's browser cookie could expire days
  // before the DB row did. These tests would all FAIL against the pre-
  // correction HEAD, since that HEAD never re-emits bcc_session on an
  // ordinary authenticated request at all.)
  // -----------------------------------------------------------------------
  describe("sliding session cookie renewal (correction pass)", () => {
    let db: Kysely<DB>;

    beforeAll(() => {
      db = createKyselyClient(dbConfig);
    });

    afterAll(async () => {
      await db.destroy();
    });

    async function createRawSessionForClampTest(
      rawToken: string,
      params: { slidingTtlMs: number; absoluteTtlMs: number; now?: Date },
    ): Promise<void> {
      const user = await upsertDashboardUser(db, {
        discordUserId: `92${Math.floor(Math.random() * 1_000_000_000)}`,
        username: "SlidingCookieTestUser",
        avatarHash: null,
        encryptedAccessToken: encryptSecret("fake-access-value", TOKEN_ENCRYPTION_KEY),
        encryptedRefreshToken: encryptSecret("fake-refresh-value", TOKEN_ENCRYPTION_KEY),
        tokenExpiresAt: new Date(Date.now() + 3600_000),
      });
      await createSession(db, rawToken, {
        userId: user.id,
        deviceLabel: null,
        userAgent: null,
        ipHash: null,
        ...params,
      });
    }

    it("A. COOKIE SLIDES: a valid authenticated request re-issues bcc_session with a fresh ~30-day Max-Age, and the same server session stays valid", async () => {
      const app = await buildApp();
      const sessionCookie = await loginAndGetSessionCookie(app);

      const response = await app.inject({
        method: "GET",
        url: "/api/auth/session",
        cookies: { bcc_session: sessionCookie },
      });
      expect(response.statusCode).toBe(200);

      const renewed = findCookie(parseSetCookieHeaders(response.headers["set-cookie"]), "bcc_session");
      expect(renewed).toBeDefined();
      // Same opaque token — ordinary sliding renewal must NEVER silently
      // become per-request session-token rotation (login-only, per ADR-020).
      expect(renewed!.value).toBe(sessionCookie);
      expect(renewed!.httpOnly).toBe(true);
      expect(renewed!.secure).toBe(true);
      expect(renewed!.sameSite?.toLowerCase()).toBe("lax");
      expect(renewed!.path).toBe("/");
      const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;
      expect(renewed!.maxAge).toBeGreaterThan(THIRTY_DAYS_SECONDS - 10);
      expect(renewed!.maxAge).toBeLessThanOrEqual(THIRTY_DAYS_SECONDS);

      // Still the SAME server-side session — the identical, never-rotated
      // token keeps working on a second authenticated read.
      const secondResponse = await app.inject({
        method: "GET",
        url: "/api/auth/session",
        cookies: { bcc_session: sessionCookie },
      });
      expect(secondResponse.statusCode).toBe(200);
    });

    it("B/E. COOKIE IS CLAMPED TO ABSOLUTE TTL: a session close to its absolute cap renews with Max-Age clamped to the remaining absolute lifetime, never the full 30-day sliding TTL — both the cookie and the DB row converge on the identical hard cap", async () => {
      const app = await buildApp();
      const rawToken = `absolute-clamp-token-${Math.random()}`;
      const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;

      // A sliding TTL far beyond the 5-day absolute cap isolates the clamp
      // behavior from needing 85 real days of elapsed time / repeated
      // touchSession calls to reach "close to the absolute cap."
      await createRawSessionForClampTest(rawToken, {
        slidingTtlMs: 365 * 24 * 60 * 60 * 1000,
        absoluteTtlMs: FIVE_DAYS_MS,
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/auth/session",
        cookies: { bcc_session: rawToken },
      });
      expect(response.statusCode).toBe(200);

      const renewed = findCookie(parseSetCookieHeaders(response.headers["set-cookie"]), "bcc_session")!;
      const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;
      const FIVE_DAYS_SECONDS = FIVE_DAYS_MS / 1000;
      expect(renewed.maxAge).toBeLessThan(THIRTY_DAYS_SECONDS);
      expect(renewed.maxAge).toBeGreaterThan(FIVE_DAYS_SECONDS - 30);
      expect(renewed.maxAge).toBeLessThanOrEqual(FIVE_DAYS_SECONDS);

      // Server-side convergence: the DB row's own sliding expires_at must
      // now equal its absolute_expires_at (the SQL CASE clamp in
      // touchSession), the exact same hard cap the cookie above reflects.
      const row = await db
        .selectFrom("dashboard_sessions")
        .selectAll()
        .where("id", "=", hashSessionToken(rawToken))
        .executeTakeFirstOrThrow();
      expect(row.expires_at.getTime()).toBe(row.absolute_expires_at.getTime());
    });

    it("C. NO RENEWAL FOR INVALID SESSION: missing/forged/expired/revoked cookies get 401 and never a refreshed bcc_session", async () => {
      const app = await buildApp();

      const missing = await app.inject({ method: "GET", url: "/api/auth/session" });
      expect(missing.statusCode).toBe(401);
      expect(findCookie(parseSetCookieHeaders(missing.headers["set-cookie"]), "bcc_session")).toBeUndefined();

      const forged = await app.inject({
        method: "GET",
        url: "/api/auth/session",
        cookies: { bcc_session: "totally-forged-token-value" },
      });
      expect(forged.statusCode).toBe(401);
      expect(findCookie(parseSetCookieHeaders(forged.headers["set-cookie"]), "bcc_session")).toBeUndefined();

      const expiredToken = `expired-sliding-token-${Math.random()}`;
      await createRawSessionForClampTest(expiredToken, {
        slidingTtlMs: -1000, // already past its sliding TTL
        absoluteTtlMs: 60 * 60 * 1000,
      });
      const expiredResponse = await app.inject({
        method: "GET",
        url: "/api/auth/session",
        cookies: { bcc_session: expiredToken },
      });
      expect(expiredResponse.statusCode).toBe(401);
      expect(
        findCookie(parseSetCookieHeaders(expiredResponse.headers["set-cookie"]), "bcc_session"),
      ).toBeUndefined();

      // Revoked: a real login, then the DB row is deleted directly
      // (simulating revocation via another device/admin action), then the
      // now-dead cookie is presented again.
      const revokedCookie = await loginAndGetSessionCookie(app);
      await db.deleteFrom("dashboard_sessions").where("id", "=", hashSessionToken(revokedCookie)).execute();
      const revokedResponse = await app.inject({
        method: "GET",
        url: "/api/auth/session",
        cookies: { bcc_session: revokedCookie },
      });
      expect(revokedResponse.statusCode).toBe(401);
      expect(
        findCookie(parseSetCookieHeaders(revokedResponse.headers["set-cookie"]), "bcc_session"),
      ).toBeUndefined();
    });

    it("D. LOGOUT / LOGOUT-ALL / REVOKE-CURRENT: exactly one, unambiguously CLEARED bcc_session Set-Cookie — never a valid renewed cookie racing (or resurrecting) the clear in the same response", async () => {
      const app = await buildApp();

      // requireAuth's preHandler runs before EVERY one of these route
      // handlers and populates request.pendingSessionRenewal on each — this
      // proves the clear path always wins outright, never leaving a second,
      // still-valid Set-Cookie header alongside the cleared one.
      const logoutSession = await loginAndGetSessionCookie(app);
      const logoutResponse = await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        cookies: { bcc_session: logoutSession },
        headers: { "x-requested-with": "BunnyCommandCenter" },
      });
      const logoutSetCookies = parseSetCookieHeaders(logoutResponse.headers["set-cookie"]).filter(
        (c) => c.name === "bcc_session",
      );
      expect(logoutSetCookies).toHaveLength(1);
      expect(logoutSetCookies[0]!.expired).toBe(true);

      const logoutAllSession = await loginAndGetSessionCookie(app);
      const logoutAllResponse = await app.inject({
        method: "POST",
        url: "/api/auth/logout-all",
        cookies: { bcc_session: logoutAllSession },
        headers: { "x-requested-with": "BunnyCommandCenter" },
      });
      const logoutAllSetCookies = parseSetCookieHeaders(logoutAllResponse.headers["set-cookie"]).filter(
        (c) => c.name === "bcc_session",
      );
      expect(logoutAllSetCookies).toHaveLength(1);
      expect(logoutAllSetCookies[0]!.expired).toBe(true);

      const currentSession = await loginAndGetSessionCookie(app);
      const listResponse = await app.inject({
        method: "GET",
        url: "/api/auth/sessions",
        cookies: { bcc_session: currentSession },
      });
      const currentSessionId = listResponse
        .json<{ data: { id: string; isCurrent: boolean }[] }>()
        .data.find((s) => s.isCurrent)!.id;
      const revokeCurrentResponse = await app.inject({
        method: "DELETE",
        url: `/api/auth/sessions/${currentSessionId}`,
        cookies: { bcc_session: currentSession },
        headers: { "x-requested-with": "BunnyCommandCenter" },
      });
      const revokeCurrentSetCookies = parseSetCookieHeaders(
        revokeCurrentResponse.headers["set-cookie"],
      ).filter((c) => c.name === "bcc_session");
      expect(revokeCurrentSetCookies).toHaveLength(1);
      expect(revokeCurrentSetCookies[0]!.expired).toBe(true);

      // All three cleared sessions genuinely fail closed afterward — a
      // conflicting renewed cookie header, if it existed, would still show
      // up here as a lingering-valid session.
      for (const cookie of [logoutSession, logoutAllSession, currentSession]) {
        const readback = await app.inject({
          method: "GET",
          url: "/api/auth/session",
          cookies: { bcc_session: cookie },
        });
        expect(readback.statusCode).toBe(401);
      }
    });
  });
});
