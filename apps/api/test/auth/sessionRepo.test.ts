/**
 * Real MySQL integration tests for the session/user lifecycle
 * (00_GLOBAL_IMPLEMENTATION_RULES.md: mocked-DB "integration" tests are a
 * rejection-criteria failure). Follows the exact fresh-database-per-suite
 * convention already established by test/health.test.ts /
 * test/migrations-runner.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Kysely } from "kysely";
import type { DB } from "../../src/db/codegen-types.js";
import { createKyselyClient } from "../../src/db/kysely.js";
import { runUp } from "../../migrations/runner.js";
import type { MigratorDbConfig } from "../../migrations/config.js";
import { upsertDashboardUser } from "../../src/auth/userRepo.js";
import {
  createSession,
  deleteAllSessionsForUser,
  deleteSessionById,
  deleteSessionByRawToken,
  findValidSessionByRawToken,
  listSessionsForUser,
  sweepExpiredSessions,
  touchSession,
} from "../../src/auth/sessionRepo.js";
import { encryptSecret } from "../../src/auth/tokenCrypto.js";

const ROOT_CONFIG = {
  host: process.env.TEST_MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.TEST_MYSQL_PORT ?? 33070),
  user: "root",
  password: process.env.TEST_MYSQL_ROOT_PASSWORD ?? "devrootpass",
};
const TEST_DB_NAME = "bunny_cc_session_repo_test";
const REAL_MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
const KEY = Buffer.alloc(32, 0x42);

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

describe("session/user lifecycle (real MySQL)", () => {
  let db: Kysely<DB>;

  beforeAll(async () => {
    const config = await freshDatabase();
    db = createKyselyClient(config);
  });

  afterAll(async () => {
    await db.destroy();
    const admin = await mysql.createConnection(ROOT_CONFIG);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB_NAME}\``);
    await admin.end();
  });

  async function makeUser(discordUserId: string): Promise<number> {
    const user = await upsertDashboardUser(db, {
      discordUserId,
      username: `user-${discordUserId}`,
      avatarHash: null,
      encryptedAccessToken: encryptSecret("access-token", KEY),
      encryptedRefreshToken: encryptSecret("refresh-token", KEY),
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    });
    return user.id;
  }

  it("upsertDashboardUser is idempotent by discord_user_id (real OAuth-verified identity, never a client claim)", async () => {
    const first = await upsertDashboardUser(db, {
      discordUserId: "900000111",
      username: "OriginalName",
      avatarHash: null,
      encryptedAccessToken: encryptSecret("a1", KEY),
      encryptedRefreshToken: encryptSecret("r1", KEY),
      tokenExpiresAt: new Date(Date.now() + 1000),
    });
    const second = await upsertDashboardUser(db, {
      discordUserId: "900000111",
      username: "RenamedOnDiscord",
      avatarHash: "abc123",
      encryptedAccessToken: encryptSecret("a2", KEY),
      encryptedRefreshToken: encryptSecret("r2", KEY),
      tokenExpiresAt: new Date(Date.now() + 2000),
    });
    expect(second.id).toBe(first.id);
    expect(second.username).toBe("RenamedOnDiscord");
  });

  it("stores Discord tokens ENCRYPTED — the raw plaintext never appears in the persisted column", async () => {
    const plaintextAccess = "plaintext-access-token-marker-xyz";
    const user = await upsertDashboardUser(db, {
      discordUserId: "900000222",
      username: "u",
      avatarHash: null,
      encryptedAccessToken: encryptSecret(plaintextAccess, KEY),
      encryptedRefreshToken: encryptSecret("refresh", KEY),
      tokenExpiresAt: new Date(Date.now() + 1000),
    });
    expect(user.discord_access_token_enc).not.toBeNull();
    expect(user.discord_access_token_enc!.toString("utf-8")).not.toContain(plaintextAccess);
  });

  it("creates a session and finds it back by its raw token", async () => {
    const userId = await makeUser("900000301");
    const created = await createSession(db, "raw-token-1", {
      userId,
      deviceLabel: null,
      userAgent: "vitest",
      ipHash: "hash",
      slidingTtlMs: 30 * 24 * 60 * 60 * 1000,
      absoluteTtlMs: 90 * 24 * 60 * 60 * 1000,
    });
    const found = await findValidSessionByRawToken(db, "raw-token-1");
    expect(found?.id).toBe(created.id);
    expect(found?.user_id).toBe(userId);
  });

  it("the raw token is never persisted — only its SHA-256 hash (id column)", async () => {
    const userId = await makeUser("900000302");
    await createSession(db, "raw-token-plaintext-marker", {
      userId,
      deviceLabel: null,
      userAgent: null,
      ipHash: null,
      slidingTtlMs: 1000 * 60,
      absoluteTtlMs: 1000 * 60,
    });
    const raw = await db
      .selectFrom("dashboard_sessions")
      .select(["id"])
      .where("user_id", "=", userId)
      .execute();
    for (const row of raw) {
      expect(row.id).not.toContain("raw-token-plaintext-marker");
    }
  });

  it("an expired (sliding TTL) session is NOT returned by findValidSessionByRawToken (fails closed)", async () => {
    const userId = await makeUser("900000303");
    await createSession(db, "raw-token-expired", {
      userId,
      deviceLabel: null,
      userAgent: null,
      ipHash: null,
      slidingTtlMs: -1000, // already expired at creation
      absoluteTtlMs: 60_000,
    });
    const found = await findValidSessionByRawToken(db, "raw-token-expired");
    expect(found).toBeUndefined();
  });

  it("a session past its absolute TTL is NOT returned even if sliding TTL alone would still be valid", async () => {
    const userId = await makeUser("900000304");
    await createSession(db, "raw-token-absolute-expired", {
      userId,
      deviceLabel: null,
      userAgent: null,
      ipHash: null,
      slidingTtlMs: 60_000,
      absoluteTtlMs: -1000, // already past absolute cap
    });
    const found = await findValidSessionByRawToken(db, "raw-token-absolute-expired");
    expect(found).toBeUndefined();
  });

  it("touchSession extends the sliding window but never past the absolute cap", async () => {
    const userId = await makeUser("900000305");
    const now = new Date();
    const created = await createSession(db, "raw-token-touch", {
      userId,
      deviceLabel: null,
      userAgent: null,
      ipHash: null,
      slidingTtlMs: 1000, // 1s sliding window
      absoluteTtlMs: 2000, // 2s absolute cap
      now,
    });

    // Touch with a huge sliding TTL — must still be clamped to absolute_expires_at.
    await touchSession(db, created.id, 100_000_000, now);
    const row = await db
      .selectFrom("dashboard_sessions")
      .selectAll()
      .where("id", "=", created.id)
      .executeTakeFirstOrThrow();
    expect(row.expires_at.getTime()).toBe(row.absolute_expires_at.getTime());
  });

  it("deleteSessionByRawToken removes exactly that session (single-device logout)", async () => {
    const userId = await makeUser("900000306");
    await createSession(db, "raw-token-logout-a", {
      userId,
      deviceLabel: null,
      userAgent: null,
      ipHash: null,
      slidingTtlMs: 60_000,
      absoluteTtlMs: 60_000,
    });
    await createSession(db, "raw-token-logout-b", {
      userId,
      deviceLabel: null,
      userAgent: null,
      ipHash: null,
      slidingTtlMs: 60_000,
      absoluteTtlMs: 60_000,
    });

    await deleteSessionByRawToken(db, "raw-token-logout-a");

    expect(await findValidSessionByRawToken(db, "raw-token-logout-a")).toBeUndefined();
    expect(await findValidSessionByRawToken(db, "raw-token-logout-b")).toBeDefined();
  });

  it("deleteAllSessionsForUser removes every session for that user (logout-all-devices) and none for another user", async () => {
    const userA = await makeUser("900000307");
    const userB = await makeUser("900000308");
    await createSession(db, "raw-a1", {
      userId: userA,
      deviceLabel: null,
      userAgent: null,
      ipHash: null,
      slidingTtlMs: 60_000,
      absoluteTtlMs: 60_000,
    });
    await createSession(db, "raw-a2", {
      userId: userA,
      deviceLabel: null,
      userAgent: null,
      ipHash: null,
      slidingTtlMs: 60_000,
      absoluteTtlMs: 60_000,
    });
    await createSession(db, "raw-b1", {
      userId: userB,
      deviceLabel: null,
      userAgent: null,
      ipHash: null,
      slidingTtlMs: 60_000,
      absoluteTtlMs: 60_000,
    });

    const revokedCount = await deleteAllSessionsForUser(db, userA);
    expect(revokedCount).toBe(2);

    expect(await listSessionsForUser(db, userA)).toHaveLength(0);
    expect(await listSessionsForUser(db, userB)).toHaveLength(1);
  });

  it("deleteSessionById is scoped to the owning user — cannot revoke another user's session by ID (IDOR discipline)", async () => {
    const userA = await makeUser("900000309");
    const userB = await makeUser("900000310");
    const sessionA = await createSession(db, "raw-idor-a", {
      userId: userA,
      deviceLabel: null,
      userAgent: null,
      ipHash: null,
      slidingTtlMs: 60_000,
      absoluteTtlMs: 60_000,
    });

    const deletedByWrongUser = await deleteSessionById(db, sessionA.id, userB);
    expect(deletedByWrongUser).toBe(0);
    expect(await findValidSessionByRawToken(db, "raw-idor-a")).toBeDefined();

    const deletedByOwner = await deleteSessionById(db, sessionA.id, userA);
    expect(deletedByOwner).toBe(1);
    expect(await findValidSessionByRawToken(db, "raw-idor-a")).toBeUndefined();
  });

  it("listSessionsForUser supports the multi-device 'Manage sessions' screen", async () => {
    const userId = await makeUser("900000311");
    await createSession(db, "raw-device-1", {
      userId,
      deviceLabel: null,
      userAgent: "Chrome",
      ipHash: null,
      slidingTtlMs: 60_000,
      absoluteTtlMs: 60_000,
    });
    await createSession(db, "raw-device-2", {
      userId,
      deviceLabel: null,
      userAgent: "Firefox",
      ipHash: null,
      slidingTtlMs: 60_000,
      absoluteTtlMs: 60_000,
    });
    const sessions = await listSessionsForUser(db, userId);
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.user_agent).sort()).toEqual(["Chrome", "Firefox"]);
  });

  it("sweepExpiredSessions durably deletes only expired rows, leaves valid ones", async () => {
    const userId = await makeUser("900000312");
    await createSession(db, "raw-sweep-expired", {
      userId,
      deviceLabel: null,
      userAgent: null,
      ipHash: null,
      slidingTtlMs: -1000,
      absoluteTtlMs: -1000,
    });
    await createSession(db, "raw-sweep-valid", {
      userId,
      deviceLabel: null,
      userAgent: null,
      ipHash: null,
      slidingTtlMs: 60_000,
      absoluteTtlMs: 60_000,
    });

    const deletedCount = await sweepExpiredSessions(db);
    expect(deletedCount).toBeGreaterThanOrEqual(1);

    const remaining = await db
      .selectFrom("dashboard_sessions")
      .select(["id"])
      .where("user_id", "=", userId)
      .execute();
    expect(remaining).toHaveLength(1);
  });

  it("restart-durability: a session created before this pool is torn down and a NEW pool is opened is still found (proves MySQL persistence, not process memory)", async () => {
    const userId = await makeUser("900000313");
    await createSession(db, "raw-restart-durability", {
      userId,
      deviceLabel: null,
      userAgent: null,
      ipHash: null,
      slidingTtlMs: 60_000,
      absoluteTtlMs: 60_000,
    });

    // Simulate an apps/api process restart: open a BRAND NEW Kysely/pool
    // instance pointed at the SAME database, never reusing the in-memory
    // connection above.
    const restartedDb: Kysely<DB> = createKyselyClient({ ...ROOT_CONFIG, database: TEST_DB_NAME });
    try {
      const found = await findValidSessionByRawToken(restartedDb, "raw-restart-durability");
      expect(found).toBeDefined();
      expect(found?.user_id).toBe(userId);
    } finally {
      await restartedDb.destroy();
    }
  });
});
