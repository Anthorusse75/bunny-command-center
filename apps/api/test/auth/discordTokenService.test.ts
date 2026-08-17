/**
 * Mandatory carry-forward #2 (Step 04 -> Step 05 HANDOVER): the full Discord
 * access-token refresh lifecycle. Real MySQL (`dashboard_users` token
 * material, genuinely encrypted/decrypted via `tokenCrypto.ts`) + the local
 * Discord test double (`discordTestDouble.ts`'s Bearer-token-validating
 * guild-list endpoint and refresh-grant branch) — proves the real
 * entrypoint -> Discord 401 -> refresh -> persist -> retry chain, not just
 * each piece in isolation.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Kysely } from "kysely";
import type { DB } from "../../src/db/codegen-types.js";
import type { AppConfig } from "../../src/config.js";
import { createKyselyClient } from "../../src/db/kysely.js";
import { runUp } from "../../migrations/runner.js";
import type { MigratorDbConfig } from "../../migrations/config.js";
import { upsertDashboardUser, findDashboardUserById } from "../../src/auth/userRepo.js";
import { encryptSecret, decryptSecret } from "../../src/auth/tokenCrypto.js";
import { DiscordTokenService, DiscordReauthRequiredError } from "../../src/auth/discordTokenService.js";
import { fetchUserGuilds, isDiscordUnauthorized } from "../../src/auth/discordGuildClient.js";
import { startDiscordTestDouble, type DiscordTestDouble } from "../helpers/discordTestDouble.js";
import { testSessionConfig, testSuperadminConfig } from "../helpers/testAuthConfig.js";

const ROOT_CONFIG = {
  host: process.env.TEST_MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.TEST_MYSQL_PORT ?? 33070),
  user: "root",
  password: process.env.TEST_MYSQL_ROOT_PASSWORD ?? "devrootpass",
};
const TEST_DB_NAME = "bunny_cc_discord_token_service_test";
const REAL_MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

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

describe("DiscordTokenService: full refresh lifecycle (real MySQL + local Discord test double)", () => {
  let db: Kysely<DB>;
  let discord: DiscordTestDouble;
  let config: AppConfig;
  let service: DiscordTokenService;

  beforeAll(async () => {
    const dbConfig = await freshDatabase();
    db = createKyselyClient(dbConfig);
  });

  afterAll(async () => {
    await db.destroy();
    const admin = await mysql.createConnection(ROOT_CONFIG);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB_NAME}\``);
    await admin.end();
  });

  beforeEach(async () => {
    discord = await startDiscordTestDouble();
    config = {
      port: 0,
      logLevel: "silent",
      appVersion: "test",
      db: { host: "", port: 0, user: "", password: "", database: "" },
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
    service = new DiscordTokenService(db, config);
  });

  afterEach(async () => {
    await discord.close();
  });

  async function makeUser(discordUserId: string, accessToken: string, refreshToken: string): Promise<number> {
    const key = config.session.tokenEncryptionKey;
    const user = await upsertDashboardUser(db, {
      discordUserId,
      username: `user-${discordUserId}`,
      avatarHash: null,
      encryptedAccessToken: encryptSecret(accessToken, key),
      encryptedRefreshToken: encryptSecret(refreshToken, key),
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    });
    return user.id;
  }

  async function callGuilds(accessToken: string) {
    return fetchUserGuilds(config.discord, accessToken);
  }

  it("normal request: a valid access token succeeds with no refresh attempted", async () => {
    const userId = await makeUser("500000000000000001", discord.state.currentAccessToken, "refresh-1");
    discord.state.guilds = [{ id: "700000000000000001", owner: true, permissions: "8" }];

    const result = await service.withFreshAccessToken(userId, callGuilds);

    expect(result).toEqual([{ id: "700000000000000001", owner: true, permissions: "8" }]);
    expect(discord.state.receivedRefreshRequests).toHaveLength(0);
  });

  it("401 -> refresh -> persist -> retry succeeds (the full carry-forward #2 chain)", async () => {
    const staleAccessToken = "already-stale-access-token";
    const userId = await makeUser("500000000000000002", staleAccessToken, "refresh-2");
    discord.state.guilds = [{ id: "700000000000000002", owner: false, permissions: "0" }];
    discord.state.nextRefreshAccessToken = "brand-new-access-token";
    discord.state.nextRefreshRefreshToken = "brand-new-refresh-token";

    const result = await service.withFreshAccessToken(userId, callGuilds);

    expect(result).toEqual([{ id: "700000000000000002", owner: false, permissions: "0" }]);
    expect(discord.state.receivedRefreshRequests).toEqual([{ refreshToken: "refresh-2" }]);

    // Durable proof: the NEW (rotated) tokens were actually persisted,
    // encrypted, to dashboard_users — not just held in memory.
    const row = await findDashboardUserById(db, userId);
    expect(row).toBeDefined();
    const key = config.session.tokenEncryptionKey;
    expect(decryptSecret(row!.discord_access_token_enc!, key)).toBe("brand-new-access-token");
    expect(decryptSecret(row!.discord_refresh_token_enc!, key)).toBe("brand-new-refresh-token");
  });

  it("refresh-token rotation: the rotated refresh token is what a SUBSEQUENT refresh actually presents to Discord", async () => {
    const userId = await makeUser("500000000000000003", "stale-token-1", "original-refresh-token");
    discord.state.guilds = [{ id: "700000000000000003", owner: false, permissions: "0" }];
    discord.state.nextRefreshAccessToken = "access-after-first-refresh";
    discord.state.nextRefreshRefreshToken = "rotated-refresh-token-1";

    await service.withFreshAccessToken(userId, callGuilds);
    expect(discord.state.receivedRefreshRequests).toEqual([{ refreshToken: "original-refresh-token" }]);

    // Second round: force ANOTHER 401 by forcing the guilds endpoint to
    // reject the current token unconditionally for exactly one more attempt.
    discord.state.guildsForcedStatus = 401;
    discord.state.nextRefreshAccessToken = "access-after-second-refresh";
    discord.state.nextRefreshRefreshToken = "rotated-refresh-token-2";
    // The second call's retry must also see the 401 lifted; simulate "the
    // fresh token now works" by clearing the forced override once the
    // refresh has happened, via a callGuilds wrapper this test controls
    // directly instead of the generic fixture (the real caller here is
    // guildAuthorization.ts, which is proven end-to-end in its own test
    // file — this file isolates DiscordTokenService's OWN behavior).
    let callCount = 0;
    const trackedCall = async (accessToken: string) => {
      callCount += 1;
      if (callCount === 2) {
        discord.state.guildsForcedStatus = undefined; // the retry, after refresh, should succeed
      }
      return fetchUserGuilds(config.discord, accessToken);
    };

    await service.withFreshAccessToken(userId, trackedCall);

    // The refresh token PRESENTED on this second refresh must be the
    // ROTATED one from the first refresh, proving rotation was genuinely
    // persisted and read back — not the original, now-stale value.
    expect(discord.state.receivedRefreshRequests).toEqual([
      { refreshToken: "original-refresh-token" },
      { refreshToken: "rotated-refresh-token-1" },
    ]);
  });

  it("refresh failure -> DiscordReauthRequiredError, no retry attempted", async () => {
    const userId = await makeUser("500000000000000004", "stale-token", "a-refresh-token-discord-will-reject");
    discord.state.refreshExchangeStatus = 400;
    discord.state.refreshExchangeBody = { error: "invalid_grant" };

    await expect(service.withFreshAccessToken(userId, callGuilds)).rejects.toBeInstanceOf(
      DiscordReauthRequiredError,
    );
  });

  it("repeated 401 after a SUCCESSFUL refresh -> DiscordReauthRequiredError, and no second refresh is ever attempted (no infinite loop)", async () => {
    const userId = await makeUser("500000000000000005", "stale-token", "refresh-token-5");
    // The guild endpoint rejects EVERY token unconditionally, even the
    // freshly-refreshed one — simulates a genuinely revoked Discord grant
    // that a refresh call alone doesn't reveal (Discord's refresh endpoint
    // can succeed while the resulting token is still rejected downstream in
    // rare cases; the contract requires failing here regardless).
    discord.state.guildsForcedStatus = 401;

    await expect(service.withFreshAccessToken(userId, callGuilds)).rejects.toBeInstanceOf(
      DiscordReauthRequiredError,
    );
    // Exactly ONE refresh attempt — never a second, never a loop.
    expect(discord.state.receivedRefreshRequests).toHaveLength(1);
  });

  it("a non-401 error from the call (e.g. a 500) is NEVER treated as refresh-eligible and propagates unchanged", async () => {
    const userId = await makeUser("500000000000000006", discord.state.currentAccessToken, "refresh-6");
    discord.state.guildsForcedStatus = 500;

    await expect(service.withFreshAccessToken(userId, callGuilds)).rejects.toMatchObject({ status: 500 });
    expect(discord.state.receivedRefreshRequests).toHaveLength(0);
  });

  it("concurrent 401-triggering calls for the SAME user are single-flighted: exactly one refresh call reaches Discord", async () => {
    const staleAccessToken = "stale-token-for-concurrency-test";
    const userId = await makeUser("500000000000000007", staleAccessToken, "refresh-7");
    discord.state.guilds = [{ id: "700000000000000007", owner: false, permissions: "0" }];
    discord.state.nextRefreshAccessToken = "fresh-token-for-concurrency-test";
    discord.state.nextRefreshRefreshToken = "rotated-refresh-7";

    const results = await Promise.all(
      Array.from({ length: 8 }, () => service.withFreshAccessToken(userId, callGuilds)),
    );

    for (const result of results) {
      expect(result).toEqual([{ id: "700000000000000007", owner: false, permissions: "0" }]);
    }
    // The single-flight lock must collapse all 8 concurrent refresh-eligible
    // calls into exactly ONE real Discord refresh request — never 8 (a
    // refresh storm) and never a corrupted/lost rotated token from a race.
    expect(discord.state.receivedRefreshRequests).toHaveLength(1);

    const row = await findDashboardUserById(db, userId);
    const key = config.session.tokenEncryptionKey;
    expect(decryptSecret(row!.discord_refresh_token_enc!, key)).toBe("rotated-refresh-7");
  });

  it("no token value ever appears in a thrown error's message", async () => {
    const userId = await makeUser("500000000000000008", "stale-token", "super-secret-refresh-token-value");
    discord.state.refreshExchangeStatus = 400;

    try {
      await service.withFreshAccessToken(userId, callGuilds);
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain("super-secret-refresh-token-value");
      expect(message).not.toContain("stale-token");
    }
  });

  it("isDiscordUnauthorized correctly identifies the error type this module reacts to", async () => {
    try {
      await fetchUserGuilds(config.discord, "totally-wrong-token");
      expect.unreachable();
    } catch (err) {
      expect(isDiscordUnauthorized(err)).toBe(true);
    }
  });
});
