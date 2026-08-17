/**
 * Targeted failure-injection test for the sliding-session-cookie correction
 * (`resolveAuthenticatedUser` in requireAuth.ts): if the DB-side sliding-TTL
 * write (`touchSession`) fails, the browser cookie must NOT be renewed —
 * re-emitting `bcc_session` with a Max-Age implying a DB renewal that never
 * actually happened would let the browser and DB sliding expiries silently
 * diverge, defeating the whole point of the correction. The already-
 * authenticated request must still complete normally (no outage).
 *
 * Real MySQL for every lookup EXCEPT the one deliberately-broken write — a
 * `Proxy` wrapping the real `Kysely` client and intercepting only
 * `updateTable("dashboard_sessions")`, the same "wrap the real thing,
 * inject one targeted failure" convention already used by
 * `sse-stream.test.ts`'s `throwingFetchSinceAdapter`/`delayFetchSinceOnce`
 * wrappers — not a mock of the DB layer in general.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Kysely } from "kysely";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { DB } from "../../src/db/codegen-types.js";
import type { AppConfig } from "../../src/config.js";
import { createKyselyClient } from "../../src/db/kysely.js";
import { runUp } from "../../migrations/runner.js";
import type { MigratorDbConfig } from "../../migrations/config.js";
import { upsertDashboardUser } from "../../src/auth/userRepo.js";
import { createSession, findValidSessionByRawToken } from "../../src/auth/sessionRepo.js";
import { encryptSecret } from "../../src/auth/tokenCrypto.js";
import { buildRequireAuth, createSessionCookieRenewalHook } from "../../src/auth/requireAuth.js";
import { testDiscordConfig, testSessionConfig } from "../helpers/testAuthConfig.js";

const ROOT_CONFIG = {
  host: process.env.TEST_MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.TEST_MYSQL_PORT ?? 33070),
  user: "root",
  password: process.env.TEST_MYSQL_ROOT_PASSWORD ?? "devrootpass",
};
const TEST_DB_NAME = "bunny_cc_require_auth_test";
const REAL_MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
const KEY = Buffer.alloc(32, 0x66);

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

/**
 * Wraps a REAL Kysely client, forwarding everything to it (methods bound to
 * the real instance, not the proxy — Kysely's builders rely on private
 * internal state tied to the exact instance they were constructed from) and
 * intercepting only `updateTable("dashboard_sessions")`, the single call
 * `touchSession` makes, to throw instead.
 */
function dbWithBrokenSessionTouch(realDb: Kysely<DB>): Kysely<DB> {
  return new Proxy(realDb, {
    get(target, prop) {
      if (prop === "updateTable") {
        return (table: keyof DB) => {
          if (table === "dashboard_sessions") {
            throw new Error("simulated touchSession DB failure (test)");
          }
          return target.updateTable(table);
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

function fakeRequest(cookies: Record<string, string>): FastifyRequest {
  return {
    cookies,
    log: { warn: () => undefined },
  } as unknown as FastifyRequest;
}

interface FakeReply {
  sentBody: unknown;
  sentCode: number | undefined;
  code(code: number): FakeReply;
  send(body: unknown): FakeReply;
}

function fakeReply(): FastifyReply & FakeReply {
  const reply: FakeReply = {
    sentBody: undefined,
    sentCode: undefined,
    code(code: number) {
      reply.sentCode = code;
      return reply;
    },
    send(body: unknown) {
      reply.sentBody = body;
      return reply;
    },
  };
  return reply as unknown as FastifyReply & FakeReply;
}

describe("requireAuth: touchSession DB-write failure path (real MySQL + targeted failure injection)", () => {
  let realDb: Kysely<DB>;
  let config: AppConfig;

  beforeAll(async () => {
    const dbConfig = await freshDatabase();
    realDb = createKyselyClient(dbConfig);
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
      discord: testDiscordConfig(),
      session: testSessionConfig(),
    };
  });

  afterAll(async () => {
    await realDb.destroy();
    const admin = await mysql.createConnection(ROOT_CONFIG);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB_NAME}\``);
    await admin.end();
  });

  async function makeSession(discordUserId: string, rawToken: string): Promise<{ sessionId: string }> {
    const user = await upsertDashboardUser(realDb, {
      discordUserId,
      username: `user-${discordUserId}`,
      avatarHash: null,
      encryptedAccessToken: encryptSecret("access", KEY),
      encryptedRefreshToken: encryptSecret("refresh", KEY),
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    });
    const session = await createSession(realDb, rawToken, {
      userId: user.id,
      deviceLabel: null,
      userAgent: null,
      ipHash: null,
      slidingTtlMs: config.session.slidingTtlMs,
      absoluteTtlMs: config.session.absoluteTtlMs,
    });
    return { sessionId: session.id };
  }

  it("touchSession failure: the already-authenticated request still completes, but no refreshed bcc_session cookie is prepared, and the DB row's expires_at is genuinely unchanged", async () => {
    const rawToken = "touch-failure-token-1";
    const { sessionId } = await makeSession("950000001", rawToken);
    const beforeRow = await findValidSessionByRawToken(realDb, rawToken);
    expect(beforeRow).toBeDefined();
    const expiresAtBefore = beforeRow!.expires_at.getTime();

    const brokenDb = dbWithBrokenSessionTouch(realDb);
    const requireAuth = buildRequireAuth(brokenDb, config);
    const request = fakeRequest({ [config.session.cookieName]: rawToken });
    const reply = fakeReply();

    // The route handler itself never sees an error — requireAuth resolves
    // normally (no 401), same as a fully healthy renewal.
    await requireAuth(request, reply);
    expect(reply.sentCode).toBeUndefined(); // never sent a 401/error response
    expect(request.authUser).toBeDefined();
    expect(request.authSessionId).toBe(sessionId);

    // The specific correction under test: no renewal was prepared, so the
    // onSend hook (the ONLY place `bcc_session` gets re-issued) must not
    // emit a fresh Set-Cookie for it.
    expect(request.pendingSessionRenewal).toBeUndefined();
    let setCookieCalled = false;
    const onSend = createSessionCookieRenewalHook(config);
    (reply as unknown as { setCookie: () => void }).setCookie = () => {
      setCookieCalled = true;
    };
    const payload = { ok: true };
    const result = await onSend(request, reply, payload);
    expect(result).toBe(payload); // hook still passes the payload through unchanged
    expect(setCookieCalled).toBe(false);

    // Durable proof: the DB row's own expires_at genuinely never moved —
    // this isn't just "the cookie wasn't renewed", the underlying write
    // itself really didn't happen (touchSession's UPDATE threw before any
    // row was touched).
    const afterRow = await findValidSessionByRawToken(realDb, rawToken);
    expect(afterRow).toBeDefined();
    expect(afterRow!.expires_at.getTime()).toBe(expiresAtBefore);
  });

  it("control: with a healthy DB, the same request DOES prepare a renewal (proves the failure test above is actually exercising the failure path, not a broken harness)", async () => {
    const rawToken = "touch-success-token-1";
    await makeSession("950000002", rawToken);

    const requireAuth = buildRequireAuth(realDb, config);
    const request = fakeRequest({ [config.session.cookieName]: rawToken });
    const reply = fakeReply();

    await requireAuth(request, reply);
    expect(request.pendingSessionRenewal).toBeDefined();
    expect(request.pendingSessionRenewal!.rawToken).toBe(rawToken);
  });
});
