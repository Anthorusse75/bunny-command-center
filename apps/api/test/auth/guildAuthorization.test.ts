/**
 * Guild Admin Resolution algorithm — every branch of
 * 08_AUTHORIZATION_AND_RBAC.md's flowchart (owner/superadmin/
 * override-disabled/no-role-configured+admin/no-role-configured+not-admin/
 * role-configured+held/role-configured+not-held-or-deleted, all fail-closed)
 * plus `assertGuildMembership`'s own membership/Superadmin-bypass branches.
 * Real MySQL (`dashboard_guild_policy`/`dashboard_admin_overrides`/
 * `dashboard_users`) + the local Discord test double.
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
import { upsertDashboardUser } from "../../src/auth/userRepo.js";
import { encryptSecret } from "../../src/auth/tokenCrypto.js";
import { setGuildAdminRole } from "../../src/auth/guildPolicyRepo.js";
import { setAdminOverride } from "../../src/auth/adminOverrideRepo.js";
import {
  assertGuildMembership,
  resolveGuildAuthorization,
  createGuildAuthDeps,
} from "../../src/auth/guildAuthorization.js";
import { GuildAuthCache } from "../../src/auth/guildAuthCache.js";
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
const TEST_DB_NAME = "bunny_cc_guild_authorization_test";
const REAL_MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
const GUILD_A = "111111111111111111";
const GUILD_B = "222222222222222222";
const OWNER_ROLE = "333333333333333333"; // "configured admin role" fixture value

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

describe("guildAuthorization: assertGuildMembership + resolveGuildAuthorization (full flowchart)", () => {
  let db: Kysely<DB>;
  let discord: DiscordTestDouble;
  let config: AppConfig;

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
  });

  afterEach(async () => {
    await discord.close();
  });

  async function makeCaller(discordUserId: string): Promise<{ id: number; discordUserId: string }> {
    const key = config.session.tokenEncryptionKey;
    const user = await upsertDashboardUser(db, {
      discordUserId,
      username: `user-${discordUserId}`,
      avatarHash: null,
      encryptedAccessToken: encryptSecret(discord.state.currentAccessToken, key),
      encryptedRefreshToken: encryptSecret("refresh-token-value", key),
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    });
    return { id: user.id, discordUserId };
  }

  function deps() {
    return createGuildAuthDeps(db, config, new GuildAuthCache(60_000));
  }

  // --- assertGuildMembership ---------------------------------------------

  it("assertGuildMembership: member of the guild -> true", async () => {
    const caller = await makeCaller("600000000000000001");
    discord.state.guilds = [{ id: GUILD_A, owner: false, permissions: "0" }];
    await expect(assertGuildMembership(deps(), caller, GUILD_A)).resolves.toBe(true);
  });

  it("assertGuildMembership: not a member of the guild -> false", async () => {
    const caller = await makeCaller("600000000000000002");
    discord.state.guilds = [{ id: GUILD_A, owner: false, permissions: "0" }];
    await expect(assertGuildMembership(deps(), caller, GUILD_B)).resolves.toBe(false);
  });

  it("assertGuildMembership: nonexistent guildId (not in the caller's list at all) -> false, indistinguishable from case above", async () => {
    const caller = await makeCaller("600000000000000003");
    discord.state.guilds = [];
    await expect(assertGuildMembership(deps(), caller, "999999999999999999")).resolves.toBe(false);
  });

  it("assertGuildMembership: Superadmin bypasses explicitly, even for a guild it has NO Discord relationship to at all -- and makes NO Discord call to prove it", async () => {
    const caller = await makeCaller(TEST_SUPERADMIN_DISCORD_ID);
    discord.state.guilds = []; // Superadmin is a member of nothing per Discord
    discord.state.guildsForcedStatus = 500; // if the bypass ever fell through to a real fetch, this would blow up the test
    await expect(assertGuildMembership(deps(), caller, GUILD_A)).resolves.toBe(true);
  });

  // --- resolveGuildAuthorization: full flowchart --------------------------

  it("Owner -> GUILD_ADMIN, unconditionally", async () => {
    const caller = await makeCaller("600000000000000010");
    discord.state.guilds = [{ id: GUILD_A, owner: true, permissions: "0" }];
    await expect(resolveGuildAuthorization(deps(), caller, GUILD_A)).resolves.toBe("GUILD_ADMIN");
  });

  it("Owner cannot be demoted by an ADMIN_DISABLED override targeting them", async () => {
    const caller = await makeCaller("600000000000000011");
    discord.state.guilds = [{ id: GUILD_A, owner: true, permissions: "0" }];
    await setAdminOverride(db, GUILD_A, "600000000000000011", true, "600000000000000099");
    await expect(resolveGuildAuthorization(deps(), caller, GUILD_A)).resolves.toBe("GUILD_ADMIN");
  });

  it("Superadmin -> SUPERADMIN rank, everywhere, even for a guild it has no Discord relationship to", async () => {
    const caller = await makeCaller(TEST_SUPERADMIN_DISCORD_ID);
    discord.state.guilds = [];
    await expect(resolveGuildAuthorization(deps(), caller, GUILD_A)).resolves.toBe("SUPERADMIN");
  });

  it("ADMIN_DISABLED override -> USER (never removes Dashboard access, only demotes admin tier)", async () => {
    const caller = await makeCaller("600000000000000012");
    discord.state.guilds = [{ id: GUILD_A, owner: false, permissions: String(0x8) }]; // has Administrator too
    await setAdminOverride(db, GUILD_A, "600000000000000012", true, "600000000000000099");
    await expect(resolveGuildAuthorization(deps(), caller, GUILD_A)).resolves.toBe("USER");
  });

  it("override restored (admin_disabled=false) -> back to whatever the underlying condition grants", async () => {
    const caller = await makeCaller("600000000000000013");
    discord.state.guilds = [{ id: GUILD_A, owner: false, permissions: String(0x8) }];
    await setAdminOverride(db, GUILD_A, "600000000000000013", true, "600000000000000099");
    await setAdminOverride(db, GUILD_A, "600000000000000013", false, "600000000000000099"); // instant restore
    await expect(resolveGuildAuthorization(deps(), caller, GUILD_A)).resolves.toBe("GUILD_ADMIN");
  });

  it("no configured role + Discord Administrator permission present -> GUILD_ADMIN", async () => {
    const caller = await makeCaller("600000000000000014");
    discord.state.guilds = [{ id: GUILD_A, owner: false, permissions: String(0x8) }];
    await expect(resolveGuildAuthorization(deps(), caller, GUILD_A)).resolves.toBe("GUILD_ADMIN");
  });

  it("no configured role + no Discord Administrator permission -> USER", async () => {
    const caller = await makeCaller("600000000000000015");
    discord.state.guilds = [{ id: GUILD_A, owner: false, permissions: "0" }];
    await expect(resolveGuildAuthorization(deps(), caller, GUILD_A)).resolves.toBe("USER");
  });

  it("configured role held (from GET /users/@me/guilds/{id}/member's roles array) -> GUILD_ADMIN, even without Discord Administrator permission", async () => {
    const caller = await makeCaller("600000000000000016");
    discord.state.guilds = [{ id: GUILD_A, owner: false, permissions: "0" }];
    discord.state.memberRolesByGuild.set(GUILD_A, [OWNER_ROLE, "some-other-role"]);
    await setGuildAdminRole(db, GUILD_A, OWNER_ROLE);
    await expect(resolveGuildAuthorization(deps(), caller, GUILD_A)).resolves.toBe("GUILD_ADMIN");
  });

  it("configured role NOT held -> USER, and never falls back to the Administrator-permission default even if the caller HAS that permission", async () => {
    const caller = await makeCaller("600000000000000017");
    discord.state.guilds = [{ id: GUILD_A, owner: false, permissions: String(0x8) }]; // has Administrator
    discord.state.memberRolesByGuild.set(GUILD_A, ["some-other-role"]); // does NOT hold the configured role
    await setGuildAdminRole(db, GUILD_A, OWNER_ROLE);
    await expect(resolveGuildAuthorization(deps(), caller, GUILD_A)).resolves.toBe("USER");
  });

  it("configured role points at a role ID that doesn't exist in the caller's roles array at all (deleted-role-equivalent case) -> USER, fails closed identically to 'not held', no Bunny call, no promotion", async () => {
    const caller = await makeCaller("600000000000000018");
    discord.state.guilds = [{ id: GUILD_A, owner: false, permissions: String(0x8) }];
    discord.state.memberRolesByGuild.set(GUILD_A, []); // the configured role simply never appears
    await setGuildAdminRole(db, GUILD_A, "999999999999999998"); // configured role no caller could ever hold
    await expect(resolveGuildAuthorization(deps(), caller, GUILD_A)).resolves.toBe("USER");
  });

  it("membership absent (defensive fallback -- the real request path always gates via assertGuildMembership first) -> USER, never a promotion", async () => {
    const caller = await makeCaller("600000000000000019");
    discord.state.guilds = [{ id: GUILD_B, owner: true, permissions: String(0x8) }]; // owner/admin of a DIFFERENT guild
    await expect(resolveGuildAuthorization(deps(), caller, GUILD_A)).resolves.toBe("USER");
  });

  it("Guild-A admin does not gain admin in Guild-B merely by being admin in A (per-guild resolution, never global)", async () => {
    const caller = await makeCaller("600000000000000020");
    discord.state.guilds = [
      { id: GUILD_A, owner: true, permissions: "0" },
      { id: GUILD_B, owner: false, permissions: "0" },
    ];
    await expect(resolveGuildAuthorization(deps(), caller, GUILD_A)).resolves.toBe("GUILD_ADMIN");
    await expect(resolveGuildAuthorization(deps(), caller, GUILD_B)).resolves.toBe("USER");
  });

  // --- Micro-cache real behavior through the algorithm --------------------

  it("a second resolution within the 60s window reuses the cache and makes NO second Discord call", async () => {
    const caller = await makeCaller("600000000000000021");
    discord.state.guilds = [{ id: GUILD_A, owner: true, permissions: "0" }];
    const sharedDeps = deps();

    await resolveGuildAuthorization(sharedDeps, caller, GUILD_A);
    // If a second call re-fetched, this would blow up (still same shared deps/cache instance).
    discord.state.guildsForcedStatus = 500;
    await expect(resolveGuildAuthorization(sharedDeps, caller, GUILD_A)).resolves.toBe("GUILD_ADMIN");
  });

  // --- AuthorizationFreshness: SENSITIVE_MUTATION bypasses the cache
  //     (08_AUTHORIZATION_AND_RBAC.md §Permission freshness, D-070) --------

  describe("AuthorizationFreshness: READ may serve a cached decision, SENSITIVE_MUTATION never does", () => {
    it("A-D: cached GUILD_ADMIN survives an ordinary READ after revocation, but a SENSITIVE_MUTATION immediately afterward bypasses the cache and denies", async () => {
      const caller = await makeCaller("600000000000000030");
      const sharedDeps = deps();
      // Deterministic regardless of prior tests' leftover DB state -- this
      // scenario exercises the Owner/no-configured-role/no-Administrator
      // path specifically, not the configured-role branch.
      await setGuildAdminRole(db, GUILD_A, null);

      // A. Caller is initially the guild Owner (GUILD_ADMIN) -- resolved and
      //    cached under the default "READ" freshness.
      discord.state.guilds = [{ id: GUILD_A, owner: true, permissions: "0" }];
      await expect(resolveGuildAuthorization(sharedDeps, caller, GUILD_A)).resolves.toBe("GUILD_ADMIN");

      // B. The underlying Discord authorization input is revoked (ownership
      //    transferred away, no Administrator permission either) -- but the
      //    cache still holds the pre-revocation decision.
      discord.state.guilds = [{ id: GUILD_A, owner: false, permissions: "0" }];

      // C. An ordinary READ resolution, still within the 60s TTL, is
      //    PERMITTED to observe the stale cached decision -- this is the
      //    documented contract (60s micro-cache), not a bug. Proven here by
      //    forcing the underlying Discord fetch to hard-fail: if READ ever
      //    bypassed the cache, this assertion would throw instead of
      //    resolving.
      discord.state.guildsForcedStatus = 500;
      await expect(resolveGuildAuthorization(sharedDeps, caller, GUILD_A)).resolves.toBe("GUILD_ADMIN");
      discord.state.guildsForcedStatus = undefined;

      // D. A SENSITIVE MUTATION authorization performed immediately
      //    afterward -- same cache instance, same TTL window, same
      //    unrevoked-looking cache entry -- MUST bypass the cache entirely,
      //    perform a fresh authoritative Discord resolution, and correctly
      //    DENY the now-revoked caller.
      await expect(
        resolveGuildAuthorization(sharedDeps, caller, GUILD_A, "SENSITIVE_MUTATION"),
      ).resolves.toBe("USER");

      // Immediately after that, the cache is fresh again (SENSITIVE_MUTATION
      // still WRITES its fresh result back) -- confirmed by a plain READ
      // that would blow up if it had to hit Discord again.
      discord.state.guildsForcedStatus = 500;
      await expect(resolveGuildAuthorization(sharedDeps, caller, GUILD_A)).resolves.toBe("USER");
    });

    it("A-D, assertGuildMembership: a cached membership survives READ after a kick, but SENSITIVE_MUTATION bypasses and correctly denies", async () => {
      const caller = await makeCaller("600000000000000031");
      const sharedDeps = deps();

      discord.state.guilds = [{ id: GUILD_A, owner: false, permissions: "0" }];
      await expect(assertGuildMembership(sharedDeps, caller, GUILD_A)).resolves.toBe(true);

      // Kicked from the guild -- the guild list no longer contains it.
      discord.state.guilds = [];

      // Ordinary READ still observes the (now stale) cached membership.
      discord.state.guildsForcedStatus = 500;
      await expect(assertGuildMembership(sharedDeps, caller, GUILD_A)).resolves.toBe(true);
      discord.state.guildsForcedStatus = undefined;

      // SENSITIVE_MUTATION bypasses the cache and correctly sees the kick.
      await expect(assertGuildMembership(sharedDeps, caller, GUILD_A, "SENSITIVE_MUTATION")).resolves.toBe(
        false,
      );
    });

    it("E (cross-user): a SENSITIVE_MUTATION bypass/re-fetch for user X never touches user Y's independently-cached decision for the SAME guild", async () => {
      const callerX = await makeCaller("600000000000000032");
      const callerY = await makeCaller("600000000000000033");
      const sharedDeps = deps();
      await setGuildAdminRole(db, GUILD_A, null);

      // Both X and Y are (independently) Owner of the same guild A.
      discord.state.guilds = [{ id: GUILD_A, owner: true, permissions: "0" }];
      await expect(resolveGuildAuthorization(sharedDeps, callerX, GUILD_A)).resolves.toBe("GUILD_ADMIN");
      await expect(resolveGuildAuthorization(sharedDeps, callerY, GUILD_A)).resolves.toBe("GUILD_ADMIN");

      // Revoke X's ownership only (the test double's fixture is shared, but
      // each caller's own guild-list cache entry -- keyed by discordUserId --
      // is what's actually under test here, not the fixture itself).
      discord.state.guilds = [{ id: GUILD_A, owner: false, permissions: "0" }];
      await expect(
        resolveGuildAuthorization(sharedDeps, callerX, GUILD_A, "SENSITIVE_MUTATION"),
      ).resolves.toBe("USER");

      // User Y's cached decision for the SAME guild A is completely
      // unaffected by user X's mutation-triggered bypass/re-fetch -- a
      // DIFFERENT user's guild-list cache entry (distinct key), never
      // touched. Proven by forcing a hard Discord failure: if Y's entry had
      // been invalidated/overwritten by X's bypass, this READ would have to
      // hit Discord and throw instead of resolving from its own cache.
      discord.state.guildsForcedStatus = 500;
      await expect(resolveGuildAuthorization(sharedDeps, callerY, GUILD_A)).resolves.toBe("GUILD_ADMIN");
    });

    it("E (cross-guild, member-roles source): a SENSITIVE_MUTATION bypass/re-fetch for guild A's configured-role check never touches the SAME user's still-cached decision for guild B", async () => {
      const caller = await makeCaller("600000000000000034");
      const sharedDeps = deps();
      const roleA = "444444444444444444";
      const roleB = "555555555555555555";

      // Guild A and guild B each have their OWN configured admin role, and
      // the caller currently holds both -- this is the one branch that
      // populates the genuinely per-(user,guild) `guild-member` cache
      // source (guildAuthCache.ts's doc comment), unlike the guild-list
      // source above, which is intentionally one shared per-user entry.
      discord.state.guilds = [
        { id: GUILD_A, owner: false, permissions: "0" },
        { id: GUILD_B, owner: false, permissions: "0" },
      ];
      await setGuildAdminRole(db, GUILD_A, roleA);
      await setGuildAdminRole(db, GUILD_B, roleB);
      discord.state.memberRolesByGuild.set(GUILD_A, [roleA]);
      discord.state.memberRolesByGuild.set(GUILD_B, [roleB]);

      await expect(resolveGuildAuthorization(sharedDeps, caller, GUILD_A)).resolves.toBe("GUILD_ADMIN");
      await expect(resolveGuildAuthorization(sharedDeps, caller, GUILD_B)).resolves.toBe("GUILD_ADMIN");

      // The caller's role in guild A is revoked.
      discord.state.memberRolesByGuild.set(GUILD_A, []);
      await expect(
        resolveGuildAuthorization(sharedDeps, caller, GUILD_A, "SENSITIVE_MUTATION"),
      ).resolves.toBe("USER");

      // Guild B's still-cached member-roles decision for the SAME user is
      // completely unaffected -- proven by forcing a hard Discord failure
      // on the member endpoint specifically: if B's per-guild cache entry
      // had been touched by A's bypass, this READ would have to hit Discord
      // and throw instead of resolving from its own, still-valid entry.
      discord.state.memberForcedStatus = 500;
      await expect(resolveGuildAuthorization(sharedDeps, caller, GUILD_B)).resolves.toBe("GUILD_ADMIN");
    });
  });
});
