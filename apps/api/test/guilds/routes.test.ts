/**
 * `/api/users/me/guilds*` + `/api/guilds/:guildId` — PROOF OF WIRING and the
 * Step-06 test matrix (IMPLEMENTATION/06_multi_guild_navigation.md
 * §TESTS REQUIRED, 24_API_CONTRACTS.md, 09_MULTI_GUILD_MODEL.md,
 * 08_AUTHORIZATION_AND_RBAC.md §Mandatory negative tests applied to this
 * step's own real production route).
 *
 * Mirrors `test/auth/tier.test.ts`'s real-server-instance approach (real
 * `buildServer()`, real DB, real Discord test double, `fastify.inject()`)
 * but ALSO applies the REAL self-bot shared-schema migrations
 * (`vendor/self-bot-schema/database/migrations`) before the Dashboard
 * ledger, since this is the first Step-06 route to actually read the SHARED
 * `guilds` table (bot-presence cross-reference) — `tier.test.ts` never
 * needed this because Guild Admin Resolution never touches `guilds` at all.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer } from "../../src/server.js";
import type { AppConfig } from "../../src/config.js";
import { runUp } from "../../migrations/runner.js";
import type { MigratorDbConfig } from "../../migrations/config.js";
import { upsertDashboardUser, setLastUploadGuild, findDashboardUserById } from "../../src/auth/userRepo.js";
import { createSession } from "../../src/auth/sessionRepo.js";
import { encryptSecret } from "../../src/auth/tokenCrypto.js";
import { startDiscordTestDouble, type DiscordTestDouble } from "../helpers/discordTestDouble.js";
import { testSessionConfig, testSuperadminConfig } from "../helpers/testAuthConfig.js";

/** Derived from the real `buildServer()` instance's own `inject` return type, rather than importing Fastify's underlying `light-my-request` package directly (not a direct dependency of this app). */
type InjectResponse = Awaited<ReturnType<Awaited<ReturnType<typeof buildServer>>["inject"]>>;

interface GuildEntryBody {
  guildId: string;
  name: string | null;
  icon: string | null;
  botPresent: boolean;
  enabled: boolean | null;
  isOwner: boolean;
  canAdminister: boolean;
  isFavorite: boolean;
  favoritedAt: string | null;
  homeVisible: boolean;
  lastUsedAt: string | null;
}
interface GuildsListBody {
  data: {
    guilds: GuildEntryBody[];
    inviteEligibleGuilds: GuildEntryBody[];
    canInviteBunnyAnywhere: boolean;
    inviteUrl: string;
  };
}
interface PreferenceMutationBody {
  data: {
    guildId: string;
    isFavorite: boolean;
    favoritedAt: string | null;
    homeVisible: boolean;
    lastUsedAt: string | null;
  };
}
interface OverviewBody {
  data: {
    guildId: string;
    tier: string;
    botPresent: boolean;
    enabled: boolean | null;
    displayName: string | null;
  };
}

function listBody(response: InjectResponse): GuildsListBody {
  return response.json();
}
function preferenceBody(response: InjectResponse): PreferenceMutationBody {
  return response.json();
}
function overviewBody(response: InjectResponse): OverviewBody {
  return response.json();
}

const ROOT_CONFIG = {
  host: process.env.TEST_MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.TEST_MYSQL_PORT ?? 33070),
  user: "root",
  password: process.env.TEST_MYSQL_ROOT_PASSWORD ?? "devrootpass",
};
const TEST_DB_NAME = "bunny_cc_guilds_test";
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const DASHBOARD_MIGRATIONS_DIR = path.join(REPO_ROOT, "apps", "api", "migrations");
const SHARED_MIGRATIONS_DIR = path.join(REPO_ROOT, "vendor", "self-bot-schema", "database", "migrations");

const GUILD_A = "111111111111111111"; // bot present, favorited by user
const GUILD_B = "222222222222222222"; // bot present, not favorited
const GUILD_C = "333333333333333333"; // bot NOT present, user is owner (invite-eligible)
const GUILD_D = "444444444444444444"; // bot NOT present, user has no admin rights (excluded entirely)
// Deliberately past Number.MAX_SAFE_INTEGER (2^53-1 = 9007199254740991, 16
// digits) — a real-shaped Discord Snowflake that would silently lose
// precision under ANY numeric coercion (exact-string preservation test).
const GUILD_HUGE = "9223372036854775807";

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

describe("Multi-guild model: GET /api/users/me/guilds, favorite/home-visibility, GET /api/guilds/:guildId", () => {
  let discord: DiscordTestDouble;
  let config: AppConfig;
  let fastify: Awaited<ReturnType<typeof buildServer>>;
  let pool: mysql.Pool;

  beforeAll(async () => {
    const dbConfig = await freshDatabase();
    pool = mysql.createPool(dbConfig);
    // Seed the SHARED `guilds` table directly (bot-presence fixture) — this
    // table's migration authority is the Self-bot repo; this test only
    // inserts fixture rows into an already-migrated schema, never creates
    // or alters the table itself.
    await pool.query(
      "INSERT INTO guilds (guild_id, display_name_cache, enabled) VALUES (?, ?, ?), (?, ?, ?)",
      [GUILD_A, "Alpha Guild", 1, GUILD_B, "Bravo Guild", 1],
    );

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
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
    await discord.close();
    await pool.end();
    const admin = await mysql.createConnection(ROOT_CONFIG);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB_NAME}\``);
    await admin.end();
  });

  afterEach(() => {
    discord.state.guildsForcedStatus = undefined;
    discord.state.guildsForcedBody = undefined;
  });

  let userCounter = 700100000000000000n;
  let sessionCounter = 0;
  async function makeSession(
    guilds: { id: string; owner: boolean; permissions: string; name?: string; icon?: string | null }[],
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

  // ---------------------------------------------------------------------
  // GET /api/users/me/guilds — live cross-reference, ordering, snowflakes
  // ---------------------------------------------------------------------

  it("unauthenticated -> 401", async () => {
    const response = await fastify.inject({ method: "GET", url: "/api/users/me/guilds" });
    expect(response.statusCode).toBe(401);
  });

  it("returns bot-present guilds as `guilds`, bot-absent-but-adminable as `inviteEligibleGuilds`, excludes bot-absent+non-adminable entirely", async () => {
    const { cookie } = await makeSession([
      { id: GUILD_A, owner: false, permissions: "0", name: "Alpha Guild" },
      { id: GUILD_B, owner: false, permissions: "0", name: "Bravo Guild" },
      { id: GUILD_C, owner: true, permissions: "0", name: "Charlie Guild" },
      { id: GUILD_D, owner: false, permissions: "0", name: "Delta Guild" },
    ]);
    const response = await fastify.inject({
      method: "GET",
      url: "/api/users/me/guilds",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = listBody(response);
    const guildIds = body.data.guilds.map((g) => g.guildId);
    expect(guildIds.sort()).toEqual([GUILD_A, GUILD_B].sort());
    expect(body.data.guilds.every((g) => g.botPresent)).toBe(true);
    expect(body.data.inviteEligibleGuilds.map((g) => g.guildId)).toEqual([GUILD_C]);
    expect(body.data.canInviteBunnyAnywhere).toBe(true);
    // GUILD_D (bot absent, not owner/admin) must appear in NEITHER list.
    const allReturnedIds = [
      ...body.data.guilds.map((g) => g.guildId),
      ...body.data.inviteEligibleGuilds.map((g) => g.guildId),
    ];
    expect(allReturnedIds).not.toContain(GUILD_D);
    expect(body.data.inviteUrl).toContain("scope=bot");
  });

  it("canInviteBunnyAnywhere is false with an empty inviteEligibleGuilds list when the caller cannot administer any bot-absent guild", async () => {
    const { cookie } = await makeSession([{ id: GUILD_A, owner: false, permissions: "0", name: "Alpha" }]);
    const response = await fastify.inject({
      method: "GET",
      url: "/api/users/me/guilds",
      headers: { cookie },
    });
    const body = listBody(response);
    expect(body.data.canInviteBunnyAnywhere).toBe(false);
    expect(body.data.inviteEligibleGuilds).toEqual([]);
  });

  it("zero-guild state: bot present nowhere -> empty `guilds` list", async () => {
    const { cookie } = await makeSession([]);
    const response = await fastify.inject({
      method: "GET",
      url: "/api/users/me/guilds",
      headers: { cookie },
    });
    const body = listBody(response);
    expect(body.data.guilds).toEqual([]);
  });

  it("exact Snowflake preservation: a guild ID beyond Number.MAX_SAFE_INTEGER round-trips as an EXACT string end to end", async () => {
    await pool.query("INSERT INTO guilds (guild_id, display_name_cache, enabled) VALUES (?, ?, ?)", [
      GUILD_HUGE,
      "Huge Guild",
      1,
    ]);
    const { cookie } = await makeSession([{ id: GUILD_HUGE, owner: false, permissions: "0", name: "Huge" }]);
    const response = await fastify.inject({
      method: "GET",
      url: "/api/users/me/guilds",
      headers: { cookie },
    });
    const body = listBody(response);
    expect(body.data.guilds).toHaveLength(1);
    // Must be the literal string, not a JSON number (which JSON.parse would
    // have already silently rounded if this endpoint had ever coerced it).
    expect(typeof body.data.guilds[0]!.guildId).toBe("string");
    expect(body.data.guilds[0]!.guildId).toBe(GUILD_HUGE);
    expect(response.rawPayload.toString()).toContain(`"guildId":"${GUILD_HUGE}"`);
  });

  it("favorites ordering: favorited guilds first (most-recently-favorited on top), remaining alphabetical", async () => {
    await pool.query(
      "INSERT INTO guilds (guild_id, display_name_cache, enabled) VALUES (?, ?, ?), (?, ?, ?)",
      ["555555555555555555", "Zeta", 1, "666666666666666666", "Yankee", 1],
    );
    const GUILD_Z = "555555555555555555"; // alphabetically last, not favorited
    const GUILD_Y = "666666666666666666"; // alphabetically second (Yankee), not favorited
    const { cookie, userId } = await makeSession([
      { id: GUILD_A, owner: false, permissions: "0", name: "Alpha Guild" }, // Alphabetically first among non-favorites
      { id: GUILD_B, owner: false, permissions: "0", name: "Bravo Guild" },
      { id: GUILD_Z, owner: false, permissions: "0", name: "Zeta" },
      { id: GUILD_Y, owner: false, permissions: "0", name: "Yankee" },
    ]);
    // Favorite B first, then A — A (favorited SECOND / more recently) must
    // rank ABOVE B ("re-favoriting bumping to top" / most-recent-first).
    const favB = await fastify.inject({
      method: "POST",
      url: `/api/users/me/guilds/${GUILD_B}/favorite`,
      headers: { cookie, "x-requested-with": "BunnyCommandCenter" },
      payload: { isFavorite: true },
    });
    expect(favB.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 5)); // ensure a distinct favorited_at tick
    const favA = await fastify.inject({
      method: "POST",
      url: `/api/users/me/guilds/${GUILD_A}/favorite`,
      headers: { cookie, "x-requested-with": "BunnyCommandCenter" },
      payload: { isFavorite: true },
    });
    expect(favA.statusCode).toBe(200);

    const response = await fastify.inject({
      method: "GET",
      url: "/api/users/me/guilds",
      headers: { cookie },
    });
    const ids = listBody(response).data.guilds.map((g) => g.guildId);
    // Favorites first (A then B, most-recent favorite on top), then
    // remaining alphabetically by name: Yankee, Zeta.
    expect(ids).toEqual([GUILD_A, GUILD_B, GUILD_Y, GUILD_Z]);
    void userId;
  });

  // ---------------------------------------------------------------------
  // POST .../favorite, PATCH .../home-visibility
  // ---------------------------------------------------------------------

  it("favorite is persisted and independent of home-visibility (both default OFF for an untouched guild, toggling one never changes the other)", async () => {
    const { cookie } = await makeSession([{ id: GUILD_A, owner: false, permissions: "0" }]);
    const fav = await fastify.inject({
      method: "POST",
      url: `/api/users/me/guilds/${GUILD_A}/favorite`,
      headers: { cookie, "x-requested-with": "BunnyCommandCenter" },
      payload: { isFavorite: true },
    });
    expect(fav.statusCode).toBe(200);
    // External review correction: this used to assert `homeVisible: true`,
    // encoding the very defect the correction fixed — favoriting a guild
    // that was never otherwise touched must NOT silently flip its
    // home-visibility on too (09_MULTI_GUILD_MODEL.md: favorite/home-visible
    // are independent, and neither is "on" for mere technical membership).
    expect(preferenceBody(fav).data).toMatchObject({ isFavorite: true, homeVisible: false });

    const show = await fastify.inject({
      method: "PATCH",
      url: `/api/users/me/guilds/${GUILD_A}/home-visibility`,
      headers: { cookie, "x-requested-with": "BunnyCommandCenter" },
      payload: { homeVisible: true },
    });
    expect(show.statusCode).toBe(200);
    // Favorite must be UNCHANGED by the home-visibility toggle.
    expect(preferenceBody(show).data).toMatchObject({ isFavorite: true, homeVisible: true });

    const unfav = await fastify.inject({
      method: "POST",
      url: `/api/users/me/guilds/${GUILD_A}/favorite`,
      headers: { cookie, "x-requested-with": "BunnyCommandCenter" },
      payload: { isFavorite: false },
    });
    expect(unfav.statusCode).toBe(200);
    // Home-visibility must remain UNCHANGED by unfavoriting.
    expect(preferenceBody(unfav).data).toMatchObject({
      isFavorite: false,
      favoritedAt: null,
      homeVisible: true,
    });
  });

  it("EXTERNAL REVIEW FINDING 3: an untouched guild (no preference row at all) reports both isFavorite and homeVisible as false in the guild list — mere technical membership is never Home-visible by default", async () => {
    const { cookie } = await makeSession([{ id: GUILD_A, owner: false, permissions: "0" }]);
    const response = await fastify.inject({
      method: "GET",
      url: "/api/users/me/guilds",
      headers: { cookie },
    });
    const entry = listBody(response).data.guilds.find((g) => g.guildId === GUILD_A);
    expect(entry).toMatchObject({ isFavorite: false, homeVisible: false });
  });

  it("EXTERNAL REVIEW FINDING 3: merely viewing the guild overview (touchLastUsed's lazy row-create path) does NOT flip favorite or home-visibility on, only last_used_at", async () => {
    const { cookie, userId } = await makeSession([{ id: GUILD_A, owner: false, permissions: "0" }]);
    // GET /api/guilds/:guildId is the real production caller of
    // touchLastUsed, which lazily creates the preference row via the same
    // ensureRow() this correction fixed.
    const overview = await fastify.inject({
      method: "GET",
      url: `/api/guilds/${GUILD_A}`,
      headers: { cookie },
    });
    expect(overview.statusCode).toBe(200);
    const rows = await pool.query<mysql.RowDataPacket[]>(
      "SELECT is_favorite, home_visible, last_used_at FROM dashboard_user_guild_preferences WHERE user_id = ? AND guild_id = ?",
      [userId, GUILD_A],
    );
    expect(rows[0]).toHaveLength(1);
    expect(rows[0][0]!.is_favorite).toBe(0);
    expect(rows[0][0]!.home_visible).toBe(0);
    expect(rows[0][0]!.last_used_at).not.toBeNull();
  });

  it("unauthorized preference mutation is rejected: missing CSRF header -> 403, never reaches the DB write", async () => {
    const { cookie } = await makeSession([{ id: GUILD_A, owner: false, permissions: "0" }]);
    const response = await fastify.inject({
      method: "POST",
      url: `/api/users/me/guilds/${GUILD_A}/favorite`,
      headers: { cookie },
      payload: { isFavorite: true },
    });
    expect(response.statusCode).toBe(403);
    const readback = await fastify.inject({
      method: "GET",
      url: "/api/users/me/guilds",
      headers: { cookie },
    });
    const entry = listBody(readback).data.guilds.find((g) => g.guildId === GUILD_A);
    expect(entry?.isFavorite).toBe(false); // the rejected mutation never took effect
  });

  it("unauthenticated preference mutation -> 401", async () => {
    const response = await fastify.inject({
      method: "POST",
      url: `/api/users/me/guilds/${GUILD_A}/favorite`,
      headers: { "x-requested-with": "BunnyCommandCenter" },
      payload: { isFavorite: true },
    });
    expect(response.statusCode).toBe(401);
  });

  it("cross-user isolation: user A's favorite is invisible to user B", async () => {
    const userA = await makeSession([{ id: GUILD_A, owner: false, permissions: "0" }]);
    const userB = await makeSession([{ id: GUILD_A, owner: false, permissions: "0" }]);
    await fastify.inject({
      method: "POST",
      url: `/api/users/me/guilds/${GUILD_A}/favorite`,
      headers: { cookie: userA.cookie, "x-requested-with": "BunnyCommandCenter" },
      payload: { isFavorite: true },
    });
    const listB = await fastify.inject({
      method: "GET",
      url: "/api/users/me/guilds",
      headers: { cookie: userB.cookie },
    });
    const entryB = listBody(listB).data.guilds.find((g) => g.guildId === GUILD_A);
    expect(entryB?.isFavorite).toBe(false);
  });

  it("malformed body (non-boolean isFavorite) -> 400 validation error, not a 500 or a silent no-op", async () => {
    const { cookie } = await makeSession([{ id: GUILD_A, owner: false, permissions: "0" }]);
    const response = await fastify.inject({
      method: "POST",
      url: `/api/users/me/guilds/${GUILD_A}/favorite`,
      headers: { cookie, "x-requested-with": "BunnyCommandCenter" },
      payload: { isFavorite: "yes" },
    });
    expect(response.statusCode).toBe(400);
  });

  // ---------------------------------------------------------------------
  // EXTERNAL REVIEW FINDING 4 — favorite/home-visibility must reject an
  // arbitrary NON-MEMBER guildId, reusing the real Step-05
  // assertGuildMembership chain (requireTier), not a second implementation.
  // ---------------------------------------------------------------------

  it("EXTERNAL REVIEW FINDING 4: caller who IS a member of guild A can mutate A's favorite (positive control for the tests below)", async () => {
    const { cookie } = await makeSession([{ id: GUILD_A, owner: false, permissions: "0" }]);
    const response = await fastify.inject({
      method: "POST",
      url: `/api/users/me/guilds/${GUILD_A}/favorite`,
      headers: { cookie, "x-requested-with": "BunnyCommandCenter" },
      payload: { isFavorite: true },
    });
    expect(response.statusCode).toBe(200);
  });

  it("EXTERNAL REVIEW FINDING 4: an authenticated caller who is NOT a member of guild B cannot mutate B's favorite — 404, and the write never happens", async () => {
    // Caller's live Discord membership is GUILD_A only — GUILD_B is a real,
    // syntactically-valid, bot-present guild the caller has zero
    // relationship to.
    const { cookie, userId } = await makeSession([{ id: GUILD_A, owner: false, permissions: "0" }]);
    const response = await fastify.inject({
      method: "POST",
      url: `/api/users/me/guilds/${GUILD_B}/favorite`,
      headers: { cookie, "x-requested-with": "BunnyCommandCenter" },
      payload: { isFavorite: true },
    });
    expect(response.statusCode).toBe(404);
    // THIS caller's row for B must never have been created at all — not
    // just "not favorited", genuinely absent (proves the write was rejected
    // BEFORE ensureRow(), not silently accepted and then somehow not
    // counted). Scoped to this test's own userId — other, unrelated tests
    // in this same shared-database describe block legitimately create
    // their OWN rows for GUILD_B under different users.
    const rows = await pool.query<mysql.RowDataPacket[]>(
      "SELECT 1 FROM dashboard_user_guild_preferences WHERE guild_id = ? AND user_id = ?",
      [GUILD_B, userId],
    );
    expect(rows[0]).toHaveLength(0);
  });

  it("EXTERNAL REVIEW FINDING 4: same non-member rejection applies to PATCH home-visibility", async () => {
    const { cookie } = await makeSession([{ id: GUILD_A, owner: false, permissions: "0" }]);
    const response = await fastify.inject({
      method: "PATCH",
      url: `/api/users/me/guilds/${GUILD_B}/home-visibility`,
      headers: { cookie, "x-requested-with": "BunnyCommandCenter" },
      payload: { homeVisible: true },
    });
    expect(response.statusCode).toBe(404);
  });

  it("EXTERNAL REVIEW FINDING 4: an arbitrary guildId that is syntactically NOT a Discord snowflake -> 400 validation error, distinct from the 404 a well-shaped-but-non-member guildId produces", async () => {
    const { cookie } = await makeSession([{ id: GUILD_A, owner: false, permissions: "0" }]);
    const notAGuildId = await fastify.inject({
      method: "POST",
      url: `/api/users/me/guilds/${encodeURIComponent("'; DROP TABLE guilds; --")}/favorite`,
      headers: { cookie, "x-requested-with": "BunnyCommandCenter" },
      payload: { isFavorite: true },
    });
    expect(notAGuildId.statusCode).toBe(400);

    const tooShort = await fastify.inject({
      method: "PATCH",
      url: "/api/users/me/guilds/123/home-visibility",
      headers: { cookie, "x-requested-with": "BunnyCommandCenter" },
      payload: { homeVisible: true },
    });
    expect(tooShort.statusCode).toBe(400);
  });

  it("EXTERNAL REVIEW FINDING 2/4: exact 19-digit Snowflake round-trips through a mutation route (never coerced to a JS number)", async () => {
    // `ON DUPLICATE KEY UPDATE` — an earlier test in this shared-database
    // describe block ("exact Snowflake preservation") may already have
    // inserted this same GUILD_HUGE row; this must stay correct regardless
    // of test execution order.
    await pool.query(
      "INSERT INTO guilds (guild_id, display_name_cache, enabled) VALUES (?, ?, ?) " +
        "ON DUPLICATE KEY UPDATE display_name_cache = VALUES(display_name_cache)",
      [GUILD_HUGE, "Huge Guild", 1],
    );
    const { cookie } = await makeSession([{ id: GUILD_HUGE, owner: false, permissions: "0" }]);
    const response = await fastify.inject({
      method: "POST",
      url: `/api/users/me/guilds/${GUILD_HUGE}/favorite`,
      headers: { cookie, "x-requested-with": "BunnyCommandCenter" },
      payload: { isFavorite: true },
    });
    expect(response.statusCode).toBe(200);
    expect(typeof preferenceBody(response).data.guildId).toBe("string");
    expect(preferenceBody(response).data.guildId).toBe(GUILD_HUGE);
    expect(response.rawPayload.toString()).toContain(`"guildId":"${GUILD_HUGE}"`);
  });

  // ---------------------------------------------------------------------
  // GET /api/guilds/:guildId — real production requireTier wiring closure
  // ---------------------------------------------------------------------

  it("PROOF OF WIRING: unauthenticated -> 401, never reaches guild-authorization logic", async () => {
    const response = await fastify.inject({ method: "GET", url: `/api/guilds/${GUILD_A}` });
    expect(response.statusCode).toBe(401);
  });

  it("EXTERNAL REVIEW FINDING 2: a syntactically-invalid guildId on the overview route -> 400, not a 404 fall-through", async () => {
    const { cookie } = await makeSession([{ id: GUILD_A, owner: false, permissions: "0" }]);
    const response = await fastify.inject({
      method: "GET",
      url: "/api/guilds/not-a-snowflake",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
  });

  it("PROOF OF WIRING: authenticated but not a member -> 404 GUILD_NOT_FOUND (assertGuildMembership, real chain)", async () => {
    const { cookie } = await makeSession([{ id: GUILD_B, owner: false, permissions: "0" }]);
    const response = await fastify.inject({
      method: "GET",
      url: `/api/guilds/${GUILD_A}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error_code: "GUILD_NOT_FOUND" });
  });

  it("PROOF OF WIRING: member USER tier -> 200, exact route guild in the response, bot-present overview data", async () => {
    const { cookie } = await makeSession([{ id: GUILD_A, owner: false, permissions: "0" }]);
    const response = await fastify.inject({
      method: "GET",
      url: `/api/guilds/${GUILD_A}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(overviewBody(response).data).toMatchObject({
      guildId: GUILD_A,
      tier: "USER",
      botPresent: true,
      enabled: true,
      displayName: "Alpha Guild",
    });
  });

  it("bot-absent guild the caller IS a Discord member of -> 200 with botPresent:false, never a fabricated overview", async () => {
    const { cookie } = await makeSession([{ id: GUILD_C, owner: true, permissions: "0" }]);
    const response = await fastify.inject({
      method: "GET",
      url: `/api/guilds/${GUILD_C}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(overviewBody(response).data).toMatchObject({
      guildId: GUILD_C,
      botPresent: false,
      enabled: null,
      displayName: null,
    });
  });

  it("cross-guild IDOR: caller has access to guild A but not guild B -> GET B fails with 404, even though A succeeds", async () => {
    const { cookie } = await makeSession([{ id: GUILD_A, owner: true, permissions: "0" }]);
    const okA = await fastify.inject({ method: "GET", url: `/api/guilds/${GUILD_A}`, headers: { cookie } });
    expect(okA.statusCode).toBe(200);
    const failB = await fastify.inject({ method: "GET", url: `/api/guilds/${GUILD_B}`, headers: { cookie } });
    expect(failB.statusCode).toBe(404);
  });

  it("Guild Admin status in one guild grants NOTHING in another: Owner in A (GUILD_ADMIN tier), plain member in B (USER tier) — tiers are exact per-route-guild, never inherited", async () => {
    const { cookie } = await makeSession([
      { id: GUILD_A, owner: true, permissions: "0" },
      { id: GUILD_B, owner: false, permissions: "0" },
    ]);
    const a = await fastify.inject({ method: "GET", url: `/api/guilds/${GUILD_A}`, headers: { cookie } });
    const b = await fastify.inject({ method: "GET", url: `/api/guilds/${GUILD_B}`, headers: { cookie } });
    expect(overviewBody(a).data.tier).toBe("GUILD_ADMIN");
    expect(overviewBody(b).data.tier).toBe("USER");
  });

  it("Superadmin bypasses assertGuildMembership for a guildId it has zero Discord relationship to at all, and still gets an exact-route-guild-scoped response", async () => {
    const superadminId = testSuperadminConfig().discordUserId;
    const { cookie } = await makeSession([], superadminId);
    const response = await fastify.inject({
      method: "GET",
      url: `/api/guilds/${GUILD_A}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(overviewBody(response).data).toMatchObject({ guildId: GUILD_A, tier: "SUPERADMIN" });
  });

  it("last_used_at is updated on a real guild-overview view (readback via the DB directly)", async () => {
    const { cookie, userId } = await makeSession([{ id: GUILD_A, owner: false, permissions: "0" }]);
    const before = await pool.query(
      "SELECT last_used_at FROM dashboard_user_guild_preferences WHERE user_id = ? AND guild_id = ?",
      [userId, GUILD_A],
    );
    expect((before[0] as unknown[]).length).toBe(0);
    const response = await fastify.inject({
      method: "GET",
      url: `/api/guilds/${GUILD_A}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const after = await pool.query<mysql.RowDataPacket[]>(
      "SELECT last_used_at FROM dashboard_user_guild_preferences WHERE user_id = ? AND guild_id = ?",
      [userId, GUILD_A],
    );
    expect(after[0]).toHaveLength(1);
    expect(after[0][0]!.last_used_at).not.toBeNull();
  });

  it("Discord OAuth refresh lifecycle is not regressed on this NEW call site: a persistent 401 triggers a real refresh attempt, then the documented DISCORD_REAUTH_REQUIRED response (never a crash/500)", async () => {
    const { cookie, discordUserId } = await makeSession([{ id: GUILD_A, owner: true, permissions: "0" }]);
    // Unconditional override (ignores the Bearer token entirely, like
    // discordGuildClient.test.ts's own equivalent) -- the real refresh
    // succeeds (default double behavior) but the RETRY still 401s, exactly
    // like tier.test.ts's "repeated 401 after refresh" scenario for the
    // sample route -- proving this NEW real production call site inherits
    // the exact same Step-05 contract, not a bespoke one.
    discord.state.guildsForcedStatus = 401;
    fastify.authTestHooks!.guildAuthDeps.cache.invalidateUserGuild(discordUserId, "*");
    const response = await fastify.inject({
      method: "GET",
      url: `/api/guilds/${GUILD_A}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error_code: "DISCORD_REAUTH_REQUIRED" });
  });

  // ---------------------------------------------------------------------
  // userRepo.ts's setLastUploadGuild — the migration-0007 column's data-layer
  // function. IMPLEMENTED here with real DB coverage; HONEST WIRING STATUS
  // (this step's HANDOVER): no real HTTP call site yet — Upload itself
  // (Step 15) is the only real future caller. This test proves the function
  // itself is correct against the real dashboard_users table, not that it is
  // reachable from a route yet.
  // ---------------------------------------------------------------------
  it("setLastUploadGuild (userRepo.ts): persists last_upload_guild_id on dashboard_users, independent of dashboard_user_guild_preferences", async () => {
    const { userId } = await makeSession([{ id: GUILD_A, owner: false, permissions: "0" }]);
    const before = await findDashboardUserById(fastify.authTestHooks!.db, userId);
    expect(before?.last_upload_guild_id).toBeNull();

    await setLastUploadGuild(fastify.authTestHooks!.db, userId, GUILD_A);

    const after = await findDashboardUserById(fastify.authTestHooks!.db, userId);
    expect(after?.last_upload_guild_id).toBe(GUILD_A);

    // Exact-string Snowflake round-trip, same invariant as every other
    // guild_id-shaped column in this codebase.
    await setLastUploadGuild(fastify.authTestHooks!.db, userId, GUILD_HUGE);
    const afterHuge = await findDashboardUserById(fastify.authTestHooks!.db, userId);
    expect(afterHuge?.last_upload_guild_id).toBe(GUILD_HUGE);
    expect(typeof afterHuge?.last_upload_guild_id).toBe("string");
  });
});
