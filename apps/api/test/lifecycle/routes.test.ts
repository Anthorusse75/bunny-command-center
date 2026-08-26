/**
 * Guild lifecycle / onboarding / snapshot-based approval — PROOF OF WIRING
 * and the Step-10 test matrix (IMPLEMENTATION/10_onboarding_approval.md
 * §TESTS REQUIRED / §PROOF OF WIRING): real `buildServer()`, real MySQL
 * migrated with BOTH the shared (`vendor/self-bot-schema`) and Dashboard
 * ledgers, `fastify.inject()` — mirrors `test/guilds/routes.test.ts`'s
 * established real-server-instance approach.
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
import { encryptSecret } from "../../src/auth/tokenCrypto.js";
import { startDiscordTestDouble, type DiscordTestDouble } from "../helpers/discordTestDouble.js";
import {
  startBunnyInternalApiTestDouble,
  type BunnyInternalApiTestDouble,
} from "../helpers/bunnyInternalApiTestDouble.js";
import {
  testSessionConfig,
  testSuperadminConfig,
  TEST_SUPERADMIN_DISCORD_ID,
} from "../helpers/testAuthConfig.js";

type InjectResponse = Awaited<ReturnType<Awaited<ReturnType<typeof buildServer>>["inject"]>>;

interface OnboardingBody {
  data: { lifecycleState: string; minimumChecklistPassed: boolean };
}
interface ActivationCreatedBody {
  data: { requestId: string; lifecycleState: string };
}
interface LifecycleBody {
  data: { guildId: string; previousState: string; lifecycleState: string };
}
interface ActivationDetailBody {
  data: { requestId: string; guildId: string; state: string };
}
interface ErrorBody {
  error_code: string;
}
function onboardingBody(response: InjectResponse): OnboardingBody {
  return response.json();
}
function activationCreatedBody(response: InjectResponse): ActivationCreatedBody {
  return response.json();
}
function lifecycleBody(response: InjectResponse): LifecycleBody {
  return response.json();
}
function activationDetailBody(response: InjectResponse): ActivationDetailBody {
  return response.json();
}
function errorBody(response: InjectResponse): ErrorBody {
  return response.json();
}

const ROOT_CONFIG = {
  host: process.env.TEST_MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.TEST_MYSQL_PORT ?? 33070),
  user: "root",
  password: process.env.TEST_MYSQL_ROOT_PASSWORD ?? "devrootpass",
};
const TEST_DB_NAME = "bunny_cc_lifecycle_test";
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

describe("Step 10 — guild lifecycle, onboarding, snapshot-based approval workflow", () => {
  let discord: DiscordTestDouble;
  let bunny: BunnyInternalApiTestDouble;
  let config: AppConfig;
  let fastify: Awaited<ReturnType<typeof buildServer>>;
  let pool: mysql.Pool;

  beforeAll(async () => {
    const dbConfig = await freshDatabase();
    pool = mysql.createPool(dbConfig);
    discord = await startDiscordTestDouble();
    bunny = await startBunnyInternalApiTestDouble();
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
      // Step 10 correction round, Gap 2: real local HTTP test double
      // (`bunnyInternalApiTestDouble.ts`), never a mocked `fetch` — its
      // default channel catalog already covers every channel-id literal this
      // whole file uses, so every EXISTING test keeps working unchanged; the
      // dedicated Gap 2 tests below override `bunny.state` per-case to prove
      // the not-found/unreachable/malformed paths.
      bunnyInternalApi: { baseUrl: bunny.baseUrl, token: bunny.state.token },
    };
    fastify = await buildServer(config);
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
    await discord.close();
    await bunny.close();
    await pool.end();
    const admin = await mysql.createConnection(ROOT_CONFIG);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB_NAME}\``);
    await admin.end();
  });

  let userCounter = 800100000000000000n;
  let sessionCounter = 0;
  /**
   * Step 10 correction round, Gap 5 (real bug found in real-MySQL/real-server
   * testing): `discordTestDouble.ts`'s `state.guilds` is a SINGLE shared
   * fixture (not keyed per access token/user) — the double used to always
   * answer "the caller's own guild list" with whatever that single field
   * currently held, re-synced by this function's own `cookie` GETTER
   * side-effect immediately before each request. That worked for every
   * PRIOR test in this file (an admin action followed by a Superadmin
   * action, SEQUENTIALLY, never in the same tick) but broke the FIRST
   * genuinely concurrent multi-session test added in this correction round
   * (`Promise.all([...])` firing an Owner's pause and a Superadmin's suspend
   * at the same moment): both requests' header objects are constructed
   * synchronously before either `fastify.inject()` call's async work
   * actually runs, so the LAST cookie-getter evaluated during argument
   * construction wins for BOTH concurrent requests, regardless of which
   * session it belongs to — the Owner's pause request observed the
   * Superadmin's fixture (no `owner: true`) and spuriously 403'd. Fixed at
   * the root (`discordTestDouble.ts`'s new `state.guildsByToken` map) rather
   * than papering over it in this file: each session now gets its OWN
   * distinct access token, registered against its OWN guild-list fixture, so
   * two concurrent requests from two different sessions are correctly
   * distinguished by the token each one actually presents — no shared
   * mutable field, no ordering dependency.
   */
  async function makeSession(
    guilds: { id: string; owner: boolean; permissions: string; name?: string }[],
    discordUserId?: string,
  ): Promise<{ readonly cookie: string; readonly discordUserId: string; readonly userId: number }> {
    const id = discordUserId ?? String((userCounter += 1n));
    const key = config.session.tokenEncryptionKey;
    const db = fastify.authTestHooks!.db;
    const accessToken = `test-access-token-${id}`;
    discord.state.guildsByToken.set(accessToken, guilds);
    const user = await upsertDashboardUser(db, {
      discordUserId: id,
      username: `user-${id}`,
      avatarHash: null,
      encryptedAccessToken: encryptSecret(accessToken, key),
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
    fastify.authTestHooks!.guildAuthDeps.cache.invalidateUserGuild(id, "*");
    const rawCookie = `${config.session.cookieName}=${rawToken}`;
    return {
      cookie: rawCookie,
      discordUserId: id,
      userId: user.id,
    };
  }

  async function seedGuild(guildId: string): Promise<void> {
    await pool.query("INSERT INTO guilds (guild_id, display_name_cache, enabled) VALUES (?, ?, 0)", [
      guildId,
      `Guild ${guildId}`,
    ]);
  }

  function csrf(cookie: string): Record<string, string> {
    return { cookie, "x-requested-with": "BunnyCommandCenter" };
  }

  async function patchOnboarding(
    cookie: string,
    guildId: string,
    body: Record<string, unknown>,
  ): Promise<InjectResponse> {
    return await fastify.inject({
      method: "PATCH",
      url: `/api/guilds/${guildId}/onboarding`,
      headers: csrf(cookie),
      payload: body,
    });
  }

  async function saveMinimumChecklist(cookie: string, guildId: string, heroChannelId: string): Promise<void> {
    expect(
      (
        await patchOnboarding(cookie, guildId, {
          section: "incomingChannel",
          data: { channelId: "500000000000000001" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await patchOnboarding(cookie, guildId, { section: "heroChannel", data: { channelId: heroChannelId } }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await patchOnboarding(cookie, guildId, {
          section: "seasonQuotas",
          data: { categories: [], acceptPlatformDefaults: true },
        })
      ).statusCode,
    ).toBe(200);
  }

  // -----------------------------------------------------------------------
  // Full E2E flow (PROOF OF WIRING entrypoint)
  // -----------------------------------------------------------------------
  it("full onboarding -> request activation -> Superadmin approve -> guild becomes ACTIVE, with real notifications + audit log", async () => {
    const guildId = "600000000000000001";
    await seedGuild(guildId);

    // Superadmin logs in FIRST so a dashboard_users row exists to receive
    // the NEW_GUILD_PENDING notification.
    const superadmin = await makeSession(
      [{ id: guildId, owner: false, permissions: "0" }],
      TEST_SUPERADMIN_DISCORD_ID,
    );
    const admin = await makeSession([{ id: guildId, owner: true, permissions: "0" }]);

    // Onboarding starts DISCOVERED.
    const initial = await fastify.inject({
      method: "GET",
      url: `/api/guilds/${guildId}/onboarding`,
      headers: { cookie: admin.cookie },
    });
    expect(initial.statusCode).toBe(200);
    expect(onboardingBody(initial).data.lifecycleState).toBe("DISCOVERED");

    // First edit -> DISCOVERED -> CONFIGURING (implicit).
    await saveMinimumChecklist(admin.cookie, guildId, "500000000000000002");

    const afterSave = await fastify.inject({
      method: "GET",
      url: `/api/guilds/${guildId}/onboarding`,
      headers: { cookie: admin.cookie },
    });
    expect(onboardingBody(afterSave).data.lifecycleState).toBe("CONFIGURING");
    expect(onboardingBody(afterSave).data.minimumChecklistPassed).toBe(true);

    const [configuringRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT enabled FROM guilds WHERE guild_id = ?",
      [guildId],
    );
    expect((configuringRows[0] as { enabled: number }).enabled).toBe(0);

    // Request activation.
    const requestRes = await fastify.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/request-activation`,
      headers: csrf(admin.cookie),
    });
    expect(requestRes.statusCode).toBe(200);
    const { requestId, lifecycleState } = activationCreatedBody(requestRes).data;
    expect(lifecycleState).toBe("PENDING_APPROVAL");
    expect(typeof requestId).toBe("string");

    const [activationRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT guild_id, state, submitted_config_version_id FROM dashboard_guild_activation_requests WHERE request_id = ?",
      [requestId],
    );
    expect(activationRows).toHaveLength(1);
    expect((activationRows[0] as { state: string }).state).toBe("PENDING");

    // Superadmin was notified (Step 09's real createNotification mechanism).
    const [superadminNotifRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT event_type, guild_id FROM dashboard_notifications WHERE user_id = ? AND event_type = 'NEW_GUILD_PENDING'",
      [superadmin.userId],
    );
    expect(superadminNotifRows).toHaveLength(1);
    expect((superadminNotifRows[0] as { guild_id: string }).guild_id).toBe(guildId);

    // Review detail — frozen snapshot, callable even without Step 11's full console.
    const detailRes = await fastify.inject({
      method: "GET",
      url: `/api/admin/activation-requests/${requestId}`,
      headers: { cookie: superadmin.cookie },
    });
    expect(detailRes.statusCode).toBe(200);
    expect(activationDetailBody(detailRes).data.state).toBe("PENDING");
    expect(activationDetailBody(detailRes).data.guildId).toBe(guildId);

    // A mere guild member (not Superadmin) cannot approve.
    const outsider = await makeSession([{ id: guildId, owner: false, permissions: "0" }]);
    const forbidden = await fastify.inject({
      method: "POST",
      url: `/api/admin/activation-requests/${requestId}/approve`,
      headers: csrf(outsider.cookie),
    });
    expect(forbidden.statusCode).toBe(403);

    // Superadmin approves.
    const approveRes = await fastify.inject({
      method: "POST",
      url: `/api/admin/activation-requests/${requestId}/approve`,
      headers: csrf(superadmin.cookie),
    });
    expect(approveRes.statusCode).toBe(200);
    expect(lifecycleBody(approveRes).data.lifecycleState).toBe("ACTIVE");

    const [guildRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT lifecycle_state, enabled, active_config_version_id FROM guilds WHERE guild_id = ?",
      [guildId],
    );
    const guildRow = guildRows[0] as {
      lifecycle_state: string;
      enabled: number;
      active_config_version_id: number;
    };
    expect(guildRow.lifecycle_state).toBe("ACTIVE");
    expect(guildRow.enabled).toBe(1);
    expect(guildRow.active_config_version_id).toBe(
      (activationRows[0] as { submitted_config_version_id: number }).submitted_config_version_id,
    );

    // Guild Admin was notified of the approval.
    const [adminNotifRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT event_type FROM dashboard_notifications WHERE user_id = ? AND event_type = 'GUILD_APPROVAL_STATE_CHANGE'",
      [admin.userId],
    );
    expect(adminNotifRows).toHaveLength(1);

    // Audit log entries exist for the lifecycle transitions.
    const [auditRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT action, result FROM dashboard_audit_log WHERE guild_id = ? ORDER BY id ASC",
      [guildId],
    );
    const actions = (auditRows as { action: string; result: string }[]).map((r) => r.action);
    expect(actions).toContain("LIFECYCLE_START_CONFIGURING");
    expect(actions).toContain("ACTIVATION_REQUEST_CREATED");
    expect(actions).toContain("ACTIVATION_REQUEST_APPROVED");
    expect((auditRows as { result: string }[]).every((r) => r.result === "SUCCESS")).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Server-side re-validation (rejection criteria: never client-only)
  // -----------------------------------------------------------------------
  it("request-activation is rejected server-side when the minimum checklist has not actually passed, even if called directly", async () => {
    const guildId = "600000000000000002";
    await seedGuild(guildId);
    const admin = await makeSession([{ id: guildId, owner: true, permissions: "0" }]);

    // Only incomingChannel saved — heroChannel/quota missing.
    await patchOnboarding(admin.cookie, guildId, {
      section: "incomingChannel",
      data: { channelId: "500000000000000003" },
    });

    const res = await fastify.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/request-activation`,
      headers: csrf(admin.cookie),
    });
    expect(res.statusCode).toBe(400);
    expect(errorBody(res).error_code).toBe("CHECKLIST_NOT_PASSED");

    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT lifecycle_state FROM guilds WHERE guild_id = ?",
      [guildId],
    );
    // Still CONFIGURING (the first edit's implicit transition happened, but
    // request-activation itself was rejected before touching lifecycle_state further).
    expect((rows[0] as { lifecycle_state: string }).lifecycle_state).toBe("CONFIGURING");
  });

  // -----------------------------------------------------------------------
  // TOCTOU test (the design's core guarantee)
  // -----------------------------------------------------------------------
  it("TOCTOU: editing config while PENDING_APPROVAL never changes what a Superadmin reviews or approves", async () => {
    const guildId = "600000000000000003";
    await seedGuild(guildId);
    const admin = await makeSession([{ id: guildId, owner: true, permissions: "0" }]);
    const superadmin = await makeSession(
      [{ id: guildId, owner: false, permissions: "0" }],
      TEST_SUPERADMIN_DISCORD_ID,
    );

    const ORIGINAL_HERO_CHANNEL = "500000000000000010";
    const EDITED_HERO_CHANNEL = "500000000000000099";

    await saveMinimumChecklist(admin.cookie, guildId, ORIGINAL_HERO_CHANNEL);
    const requestRes = await fastify.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/request-activation`,
      headers: csrf(admin.cookie),
    });
    const { requestId } = activationCreatedBody(requestRes).data;
    const [beforeEditRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT submitted_config_version_id FROM dashboard_guild_activation_requests WHERE request_id = ?",
      [requestId],
    );
    const submittedVersionId = (beforeEditRows[0] as { submitted_config_version_id: number })
      .submitted_config_version_id;

    // Guild Admin edits config WHILE the request is PENDING_APPROVAL —
    // permission matrix: "PENDING_APPROVAL: edits allowed, don't reset the request".
    const editRes = await patchOnboarding(admin.cookie, guildId, {
      section: "heroChannel",
      data: { channelId: EDITED_HERO_CHANNEL },
    });
    expect(editRes.statusCode).toBe(200);

    // The activation request's own referenced version is UNCHANGED.
    const [afterEditRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT submitted_config_version_id, state FROM dashboard_guild_activation_requests WHERE request_id = ?",
      [requestId],
    );
    expect((afterEditRows[0] as { submitted_config_version_id: number }).submitted_config_version_id).toBe(
      submittedVersionId,
    );
    expect((afterEditRows[0] as { state: string }).state).toBe("PENDING");

    // The review screen still shows the ORIGINAL snapshot, not the edit.
    const [snapshotRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT CAST(herowarbot_channel_id AS CHAR) as heroChannelId FROM guild_config_selfbot WHERE configuration_version_id = ?",
      [submittedVersionId],
    );
    expect((snapshotRows[0] as { heroChannelId: string }).heroChannelId).toBe(ORIGINAL_HERO_CHANNEL);

    // Approval activates the ORIGINAL version, never the edited one.
    const approveRes = await fastify.inject({
      method: "POST",
      url: `/api/admin/activation-requests/${requestId}/approve`,
      headers: csrf(superadmin.cookie),
    });
    expect(approveRes.statusCode).toBe(200);

    const [guildRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT active_config_version_id FROM guilds WHERE guild_id = ?",
      [guildId],
    );
    const activeVersionId = (guildRows[0] as { active_config_version_id: number }).active_config_version_id;
    expect(activeVersionId).toBe(submittedVersionId);
    const [activeSnapshotRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT CAST(herowarbot_channel_id AS CHAR) as heroChannelId FROM guild_config_selfbot WHERE configuration_version_id = ?",
      [activeVersionId],
    );
    expect((activeSnapshotRows[0] as { heroChannelId: string }).heroChannelId).toBe(ORIGINAL_HERO_CHANNEL);

    // The edited value only becomes reviewable via an EXPLICIT new request:
    // requesting activation again materializes a NEW version (never mutates
    // the already-ACTIVE one), carrying the edited value forward.
    const secondRequestRes = await fastify.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/request-activation`,
      headers: csrf(admin.cookie),
    });
    // Guild is ACTIVE, not CONFIGURING/CHANGES_REQUESTED — request-activation
    // is illegal from ACTIVE (must PAUSE or otherwise leave ACTIVE first);
    // this itself proves the edit did NOT silently re-open a review.
    expect(secondRequestRes.statusCode).toBe(409);
    expect(errorBody(secondRequestRes).error_code).toBe("ILLEGAL_TRANSITION");

    // The already-ACTIVE version's own row is still untouched (defensive re-check).
    const [stillOriginalRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT CAST(herowarbot_channel_id AS CHAR) as heroChannelId FROM guild_config_selfbot WHERE configuration_version_id = ?",
      [activeVersionId],
    );
    expect((stillOriginalRows[0] as { heroChannelId: string }).heroChannelId).toBe(ORIGINAL_HERO_CHANNEL);
  });

  // -----------------------------------------------------------------------
  // Suspension-restore test (both origin states)
  // -----------------------------------------------------------------------
  it("suspension-restore: lifting a platform suspension restores USER_PAUSED, not ACTIVE, when that's what it was", async () => {
    const guildId = "600000000000000004";
    await seedGuild(guildId);
    const admin = await makeSession([{ id: guildId, owner: true, permissions: "0" }]);
    const superadmin = await makeSession(
      [{ id: guildId, owner: false, permissions: "0" }],
      TEST_SUPERADMIN_DISCORD_ID,
    );

    await saveMinimumChecklist(admin.cookie, guildId, "500000000000000020");
    const { requestId } = activationCreatedBody(
      await fastify.inject({
        method: "POST",
        url: `/api/guilds/${guildId}/request-activation`,
        headers: csrf(admin.cookie),
      }),
    ).data;
    await fastify.inject({
      method: "POST",
      url: `/api/admin/activation-requests/${requestId}/approve`,
      headers: csrf(superadmin.cookie),
    });

    // Owner (Guild Admin tier) pauses.
    const pauseRes = await fastify.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/pause`,
      headers: csrf(admin.cookie),
    });
    expect(pauseRes.statusCode).toBe(200);
    expect(lifecycleBody(pauseRes).data.lifecycleState).toBe("USER_PAUSED");

    // Superadmin platform-suspends the already-paused guild.
    const suspendRes = await fastify.inject({
      method: "POST",
      url: `/api/admin/guilds/${guildId}/suspend`,
      headers: csrf(superadmin.cookie),
    });
    expect(suspendRes.statusCode).toBe(200);
    expect(lifecycleBody(suspendRes).data.lifecycleState).toBe("PLATFORM_SUSPENDED");

    const [suspendedRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT suspended_from_state, enabled FROM guilds WHERE guild_id = ?",
      [guildId],
    );
    expect((suspendedRows[0] as { suspended_from_state: string }).suspended_from_state).toBe("USER_PAUSED");
    expect((suspendedRows[0] as { enabled: number }).enabled).toBe(0);

    // Lifting the suspension restores USER_PAUSED, NOT ACTIVE.
    const liftRes = await fastify.inject({
      method: "POST",
      url: `/api/admin/guilds/${guildId}/lift-suspension`,
      headers: csrf(superadmin.cookie),
    });
    expect(liftRes.statusCode).toBe(200);
    expect(lifecycleBody(liftRes).data.lifecycleState).toBe("USER_PAUSED");

    const [liftedRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT lifecycle_state, suspended_from_state, enabled FROM guilds WHERE guild_id = ?",
      [guildId],
    );
    expect((liftedRows[0] as { lifecycle_state: string }).lifecycle_state).toBe("USER_PAUSED");
    expect((liftedRows[0] as { suspended_from_state: string | null }).suspended_from_state).toBeNull();
    expect((liftedRows[0] as { enabled: number }).enabled).toBe(0);
  });

  it("suspension-restore: lifting a platform suspension restores ACTIVE when that's what it was", async () => {
    const guildId = "600000000000000005";
    await seedGuild(guildId);
    const admin = await makeSession([{ id: guildId, owner: true, permissions: "0" }]);
    const superadmin = await makeSession(
      [{ id: guildId, owner: false, permissions: "0" }],
      TEST_SUPERADMIN_DISCORD_ID,
    );

    await saveMinimumChecklist(admin.cookie, guildId, "500000000000000030");
    const { requestId } = activationCreatedBody(
      await fastify.inject({
        method: "POST",
        url: `/api/guilds/${guildId}/request-activation`,
        headers: csrf(admin.cookie),
      }),
    ).data;
    await fastify.inject({
      method: "POST",
      url: `/api/admin/activation-requests/${requestId}/approve`,
      headers: csrf(superadmin.cookie),
    });

    // Superadmin suspends directly from ACTIVE (no pause first).
    await fastify.inject({
      method: "POST",
      url: `/api/admin/guilds/${guildId}/suspend`,
      headers: csrf(superadmin.cookie),
    });
    const liftRes = await fastify.inject({
      method: "POST",
      url: `/api/admin/guilds/${guildId}/lift-suspension`,
      headers: csrf(superadmin.cookie),
    });
    expect(liftRes.statusCode).toBe(200);
    expect(lifecycleBody(liftRes).data.lifecycleState).toBe("ACTIVE");
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT enabled FROM guilds WHERE guild_id = ?", [
      guildId,
    ]);
    expect((rows[0] as { enabled: number }).enabled).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Reject / request-changes -> re-submission flow
  // -----------------------------------------------------------------------
  it("reject and request-changes flip lifecycle_state correctly and notify the Guild Admin; a rejected guild can reopen and re-submit as a NEW request", async () => {
    const guildId = "600000000000000006";
    await seedGuild(guildId);
    const admin = await makeSession([{ id: guildId, owner: true, permissions: "0" }]);
    const superadmin = await makeSession(
      [{ id: guildId, owner: false, permissions: "0" }],
      TEST_SUPERADMIN_DISCORD_ID,
    );

    await saveMinimumChecklist(admin.cookie, guildId, "500000000000000040");
    const { requestId: requestId1 } = activationCreatedBody(
      await fastify.inject({
        method: "POST",
        url: `/api/guilds/${guildId}/request-activation`,
        headers: csrf(admin.cookie),
      }),
    ).data;

    const rejectRes = await fastify.inject({
      method: "POST",
      url: `/api/admin/activation-requests/${requestId1}/reject`,
      headers: csrf(superadmin.cookie),
      payload: { reason: "Missing required permissions." },
    });
    expect(rejectRes.statusCode).toBe(200);
    expect(lifecycleBody(rejectRes).data.lifecycleState).toBe("REJECTED");

    const [rejectedRequestRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT state, decision_reason FROM dashboard_guild_activation_requests WHERE request_id = ?",
      [requestId1],
    );
    expect((rejectedRequestRows[0] as { state: string }).state).toBe("REJECTED");

    // Cannot approve an already-decided request.
    const doubleDecide = await fastify.inject({
      method: "POST",
      url: `/api/admin/activation-requests/${requestId1}/approve`,
      headers: csrf(superadmin.cookie),
    });
    expect(doubleDecide.statusCode).toBe(409);
    expect(errorBody(doubleDecide).error_code).toBe("REQUEST_ALREADY_DECIDED");

    // Guild Admin re-opens (REJECTED -> CONFIGURING), then re-submits as a NEW request.
    const reopenRes = await fastify.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/reopen`,
      headers: csrf(admin.cookie),
    });
    expect(reopenRes.statusCode).toBe(200);
    expect(lifecycleBody(reopenRes).data.lifecycleState).toBe("CONFIGURING");

    const secondRequestRes = await fastify.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/request-activation`,
      headers: csrf(admin.cookie),
    });
    expect(secondRequestRes.statusCode).toBe(200);
    const requestId2 = activationCreatedBody(secondRequestRes).data.requestId;
    expect(requestId2).not.toBe(requestId1);

    // The OLD request row is left in its terminal state, never mutated.
    const [oldRequestRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT state FROM dashboard_guild_activation_requests WHERE request_id = ?",
      [requestId1],
    );
    expect((oldRequestRows[0] as { state: string }).state).toBe("REJECTED");

    // request-changes on the second request.
    const changesRes = await fastify.inject({
      method: "POST",
      url: `/api/admin/activation-requests/${requestId2}/request-changes`,
      headers: csrf(superadmin.cookie),
      payload: { reason: "Please fix the Hero channel." },
    });
    expect(changesRes.statusCode).toBe(200);
    expect(lifecycleBody(changesRes).data.lifecycleState).toBe("CHANGES_REQUESTED");

    // Re-submit from CHANGES_REQUESTED.
    const resubmitRes = await fastify.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/request-activation`,
      headers: csrf(admin.cookie),
    });
    expect(resubmitRes.statusCode).toBe(200);
    expect(lifecycleBody(resubmitRes).data.lifecycleState).toBe("PENDING_APPROVAL");
  });

  // -----------------------------------------------------------------------
  // Step 10 correction round, Gap 1: pause/resume are Owner-scoped, NOT
  // merely GUILD_ADMIN-scoped (DASHBOARD/10_GUILD_ONBOARDING_AND_APPROVAL.md's
  // permission matrix: "ACTIVE | Owner: pause", "USER_PAUSED | Owner:
  // resume"). A caller who resolves to GUILD_ADMIN tier via the Discord
  // ADMINISTRATOR permission bit but is NOT `owner: true` in their own live
  // guild list must be rejected with 403 — the prior implementation used
  // `requireGuildAdmin` here, which incorrectly let any GUILD_ADMIN-tier
  // caller pause/resume.
  // -----------------------------------------------------------------------
  it("pause/resume are Owner-scoped: a non-Owner Guild Admin (ADMINISTRATOR bit) is rejected, the real Owner and Superadmin can act", async () => {
    const guildId = "600000000000000007";
    await seedGuild(guildId);
    const owner = await makeSession([{ id: guildId, owner: true, permissions: "0" }]);
    const superadmin = await makeSession(
      [{ id: guildId, owner: false, permissions: "0" }],
      TEST_SUPERADMIN_DISCORD_ID,
    );

    await saveMinimumChecklist(owner.cookie, guildId, "500000000000000050");
    const { requestId } = activationCreatedBody(
      await fastify.inject({
        method: "POST",
        url: `/api/guilds/${guildId}/request-activation`,
        headers: csrf(owner.cookie),
      }),
    ).data;
    await fastify.inject({
      method: "POST",
      url: `/api/admin/activation-requests/${requestId}/approve`,
      headers: csrf(superadmin.cookie),
    });

    // A non-Owner Guild Admin (resolves to GUILD_ADMIN tier via the Discord
    // ADMINISTRATOR bit, `owner: false`) must be rejected with a clear 403,
    // and the guild must remain ACTIVE (no partial/silent state change).
    const nonOwnerAdmin = await makeSession([{ id: guildId, owner: false, permissions: "8" }]);
    const rejectedPause = await fastify.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/pause`,
      headers: csrf(nonOwnerAdmin.cookie),
    });
    expect(rejectedPause.statusCode).toBe(403);
    expect(errorBody(rejectedPause).error_code).toBe("FORBIDDEN");

    const [stillActiveRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT lifecycle_state FROM guilds WHERE guild_id = ?",
      [guildId],
    );
    expect((stillActiveRows[0] as { lifecycle_state: string }).lifecycle_state).toBe("ACTIVE");

    // The real Owner CAN pause.
    const ownerPause = await fastify.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/pause`,
      headers: csrf(owner.cookie),
    });
    expect(ownerPause.statusCode).toBe(200);
    expect(lifecycleBody(ownerPause).data.lifecycleState).toBe("USER_PAUSED");

    // The same non-Owner Guild Admin is also rejected for resume.
    const rejectedResume = await fastify.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/resume`,
      headers: csrf(nonOwnerAdmin.cookie),
    });
    expect(rejectedResume.statusCode).toBe(403);
    expect(errorBody(rejectedResume).error_code).toBe("FORBIDDEN");

    // Superadmin CAN resume (bypasses the Owner check, matches the
    // Superadmin-supersedes-everything pattern used everywhere else).
    const superadminResume = await fastify.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/resume`,
      headers: csrf(superadmin.cookie),
    });
    expect(superadminResume.statusCode).toBe(200);
    expect(lifecycleBody(superadminResume).data.lifecycleState).toBe("ACTIVE");
  });

  it("reopen stays GUILD_ADMIN-scoped (not Owner-only): a non-Owner Guild Admin can reopen a REJECTED guild", async () => {
    const guildId = "600000000000000008";
    await seedGuild(guildId);
    const owner = await makeSession([{ id: guildId, owner: true, permissions: "0" }]);
    const superadmin = await makeSession(
      [{ id: guildId, owner: false, permissions: "0" }],
      TEST_SUPERADMIN_DISCORD_ID,
    );

    await saveMinimumChecklist(owner.cookie, guildId, "500000000000000060");
    const { requestId } = activationCreatedBody(
      await fastify.inject({
        method: "POST",
        url: `/api/guilds/${guildId}/request-activation`,
        headers: csrf(owner.cookie),
      }),
    ).data;
    const rejectRes = await fastify.inject({
      method: "POST",
      url: `/api/admin/activation-requests/${requestId}/reject`,
      headers: csrf(superadmin.cookie),
      payload: { reason: "Not ready." },
    });
    expect(rejectRes.statusCode).toBe(200);

    // A non-Owner Guild Admin (ADMINISTRATOR bit, owner: false) CAN reopen —
    // `reopen` is documented as plain Guild-Admin-scoped, not Owner-only.
    const nonOwnerAdmin = await makeSession([{ id: guildId, owner: false, permissions: "8" }]);
    const reopenRes = await fastify.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/reopen`,
      headers: csrf(nonOwnerAdmin.cookie),
    });
    expect(reopenRes.statusCode).toBe(200);
    expect(lifecycleBody(reopenRes).data.lifecycleState).toBe("CONFIGURING");
  });

  // -----------------------------------------------------------------------
  // Step 10 correction round, Gap 4: checksum-mismatch defense-in-depth.
  // `activationRequestsService.ts`'s `approveActivationRequest` re-verifies
  // `Buffer.compare(snapshot.checksum, request.submittedConfigChecksum)`
  // before ever flipping lifecycle_state — this proves it actually fires on
  // a genuine mismatch, simulating an "impossible" out-of-band mutation of
  // the referenced `guild_configuration_versions` row directly via SQL
  // (the application layer itself never does this).
  // -----------------------------------------------------------------------
  it("approve is rejected with CHECKSUM_MISMATCH when the referenced config version's checksum was mutated out-of-band, and the failure is audited", async () => {
    const guildId = "600000000000000009";
    await seedGuild(guildId);
    const admin = await makeSession([{ id: guildId, owner: true, permissions: "0" }]);
    const superadmin = await makeSession(
      [{ id: guildId, owner: false, permissions: "0" }],
      TEST_SUPERADMIN_DISCORD_ID,
    );

    await saveMinimumChecklist(admin.cookie, guildId, "500000000000000070");
    const { requestId } = activationCreatedBody(
      await fastify.inject({
        method: "POST",
        url: `/api/guilds/${guildId}/request-activation`,
        headers: csrf(admin.cookie),
      }),
    ).data;

    // Out-of-band mutation: directly corrupt the referenced
    // guild_configuration_versions row's checksum — something the
    // application layer itself would never do, simulating an "impossible"
    // integrity violation the defense-in-depth check exists to catch.
    const [requestRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT submitted_config_version_id FROM dashboard_guild_activation_requests WHERE request_id = ?",
      [requestId],
    );
    const submittedConfigVersionId = (requestRows[0] as { submitted_config_version_id: number })
      .submitted_config_version_id;
    await pool.query("UPDATE guild_configuration_versions SET checksum = UNHEX(SHA2('tampered', 256)) WHERE id = ?", [
      submittedConfigVersionId,
    ]);

    const approveRes = await fastify.inject({
      method: "POST",
      url: `/api/admin/activation-requests/${requestId}/approve`,
      headers: csrf(superadmin.cookie),
    });
    expect(approveRes.statusCode).toBe(409);
    expect(errorBody(approveRes).error_code).toBe("CHECKSUM_MISMATCH");

    // The guild must NOT have become ACTIVE, and `enabled` must stay 0.
    const [guildRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT lifecycle_state, enabled FROM guilds WHERE guild_id = ?",
      [guildId],
    );
    expect((guildRows[0] as { lifecycle_state: string }).lifecycle_state).toBe("PENDING_APPROVAL");
    expect((guildRows[0] as { enabled: number }).enabled).toBe(0);

    // The activation request must still be PENDING (never silently decided).
    const [requestStateRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT state FROM dashboard_guild_activation_requests WHERE request_id = ?",
      [requestId],
    );
    expect((requestStateRows[0] as { state: string }).state).toBe("PENDING");

    // An audit-log row records the integrity failure.
    const [auditRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT action, result, guild_id FROM dashboard_audit_log WHERE action = 'ACTIVATION_REQUEST_APPROVAL_INTEGRITY_FAILURE' AND guild_id = ?",
      [guildId],
    );
    expect(auditRows).toHaveLength(1);
    expect((auditRows[0] as { result: string }).result).toBe("FAILURE");

    // No false-success GUILD_APPROVAL_STATE_CHANGE notification was created
    // for this request (only a real state-change notification would use
    // this event type; approval never got far enough to send one).
    const [notificationRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT id FROM dashboard_notifications WHERE event_type = 'GUILD_APPROVAL_STATE_CHANGE' AND guild_id = ?",
      [guildId],
    );
    expect(notificationRows).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // -----------------------------------------------------------------------
  // Step 10 correction round, Gap 2: live channel-catalog integration.
  // -----------------------------------------------------------------------
  describe("onboarding channel catalog integration (Gap 2)", () => {
    it("saving a channel section is rejected (fails closed) when Bunny is unreachable/erroring, never silently accepted", async () => {
      const guildId = "600000000000000015";
      await seedGuild(guildId);
      const admin = await makeSession([{ id: guildId, owner: true, permissions: "0" }]);

      bunny.state.forcedStatus = 503;
      try {
        const res = await patchOnboarding(admin.cookie, guildId, {
          section: "incomingChannel",
          data: { channelId: "500000000000000001" },
        });
        expect(res.statusCode).toBe(503);
        expect(errorBody(res).error_code).toBe("CHANNEL_VERIFICATION_FAILED");
      } finally {
        bunny.state.forcedStatus = undefined;
      }

      // The save must NOT have been persisted — never a silent accept of an
      // unverified channel id.
      const stateRes = await fastify.inject({
        method: "GET",
        url: `/api/guilds/${guildId}/onboarding`,
        headers: { cookie: admin.cookie },
      });
      const state = stateRes.json() as { data: { values: { incomingChannelId: string | null } } };
      expect(state.data.values.incomingChannelId).toBeNull();
    });

    it("saving a channel section is rejected when the channel genuinely doesn't exist in Bunny's live catalog", async () => {
      const guildId = "600000000000000016";
      await seedGuild(guildId);
      const admin = await makeSession([{ id: guildId, owner: true, permissions: "0" }]);
      // Explicit, empty catalog for this guild — overrides the shared
      // default's broad synthetic list.
      bunny.state.channelsByGuild.set(guildId, []);

      const res = await patchOnboarding(admin.cookie, guildId, {
        section: "heroChannel",
        data: { channelId: "500000000000000099" },
      });
      expect(res.statusCode).toBe(400);
      expect(errorBody(res).error_code).toBe("CHANNEL_NOT_FOUND");
    });

    it("saving a channel section succeeds when the channel genuinely exists in Bunny's live catalog", async () => {
      const guildId = "600000000000000017";
      await seedGuild(guildId);
      const admin = await makeSession([{ id: guildId, owner: true, permissions: "0" }]);
      bunny.state.channelsByGuild.set(guildId, [
        { id: "500000000000000098", name: "real-incoming", position: 0, type: "text", can_read_history: true },
      ]);

      const res = await patchOnboarding(admin.cookie, guildId, {
        section: "incomingChannel",
        data: { channelId: "500000000000000098" },
      });
      expect(res.statusCode).toBe(200);
      expect(onboardingBody(res).data.lifecycleState).toBe("CONFIGURING");
    });

    it("clearing the optional community channel (channelId: null) never triggers a catalog check", async () => {
      const guildId = "600000000000000018";
      await seedGuild(guildId);
      const admin = await makeSession([{ id: guildId, owner: true, permissions: "0" }]);
      bunny.state.forcedStatus = 503; // if this section wrongly checked the catalog, it would fail
      try {
        const res = await patchOnboarding(admin.cookie, guildId, {
          section: "communityChannel",
          data: { channelId: null },
        });
        expect(res.statusCode).toBe(200);
      } finally {
        bunny.state.forcedStatus = undefined;
      }
    });

    it("GET .../onboarding/channels returns the real catalog when Bunny is reachable, and a graceful available:false when it is not — never a 500", async () => {
      const guildId = "600000000000000019";
      await seedGuild(guildId);
      const admin = await makeSession([{ id: guildId, owner: true, permissions: "0" }]);
      bunny.state.channelsByGuild.set(guildId, [
        { id: "500000000000000097", name: "catalog-channel", position: 3, type: "text", can_read_history: true },
      ]);

      const okRes = await fastify.inject({
        method: "GET",
        url: `/api/guilds/${guildId}/onboarding/channels`,
        headers: { cookie: admin.cookie },
      });
      expect(okRes.statusCode).toBe(200);
      const okBody = okRes.json() as {
        data: { available: boolean; channels: { id: string; name: string }[] };
      };
      expect(okBody.data.available).toBe(true);
      expect(okBody.data.channels).toEqual([
        { id: "500000000000000097", name: "catalog-channel", position: 3, type: "text", canReadHistory: true },
      ]);

      bunny.state.forcedStatus = 503;
      try {
        const degradedRes = await fastify.inject({
          method: "GET",
          url: `/api/guilds/${guildId}/onboarding/channels`,
          headers: { cookie: admin.cookie },
        });
        expect(degradedRes.statusCode).toBe(200);
        const degradedBody = degradedRes.json() as { data: { available: boolean; channels: unknown[] } };
        expect(degradedBody.data.available).toBe(false);
        expect(degradedBody.data.channels).toEqual([]);
      } finally {
        bunny.state.forcedStatus = undefined;
      }
    });
  });

  // Step 10 correction round, Gap 5: concurrency/race tests. Every one of
  // these fires two real HTTP requests concurrently (`Promise.all`) against
  // the real running test server, then asserts on the REAL final DB state —
  // matching this suite's own established real-server, real-MySQL approach.
  // The guard mechanism under test is `lifecycleRepo.ts`'s `writeLifecycleTransition`
  // (guilds.row_version + expected-state, guarded UPDATE) and
  // `activationRequestsRepo.ts`'s `writeActivationRequestDecision`
  // (dashboard_guild_activation_requests.state, guarded UPDATE) — both
  // "clear rejection rather than silent no-op" per
  // IMPLEMENTATION/10_onboarding_approval.md §Concurrency.
  // -----------------------------------------------------------------------
  describe("concurrency/race guarantees", () => {
    function statusCodes(results: InjectResponse[]): number[] {
      return results.map((r) => r.statusCode).sort();
    }

    it("two concurrent request-activation calls for the same guild: exactly one succeeds, never two live activation requests", async () => {
      const guildId = "600000000000000010";
      await seedGuild(guildId);
      const admin = await makeSession([{ id: guildId, owner: true, permissions: "0" }]);
      await saveMinimumChecklist(admin.cookie, guildId, "500000000000000080");

      const [resA, resB] = await Promise.all([
        fastify.inject({
          method: "POST",
          url: `/api/guilds/${guildId}/request-activation`,
          headers: csrf(admin.cookie),
        }),
        fastify.inject({
          method: "POST",
          url: `/api/guilds/${guildId}/request-activation`,
          headers: csrf(admin.cookie),
        }),
      ]);

      expect(statusCodes([resA, resB])).toEqual([200, 409]);
      const loser = resA.statusCode === 409 ? resA : resB;
      expect(["ILLEGAL_TRANSITION", "CONCURRENT_MODIFICATION"]).toContain(errorBody(loser).error_code);

      const [guildRows] = await pool.query<mysql.RowDataPacket[]>(
        "SELECT lifecycle_state FROM guilds WHERE guild_id = ?",
        [guildId],
      );
      expect((guildRows[0] as { lifecycle_state: string }).lifecycle_state).toBe("PENDING_APPROVAL");

      const [liveRequestRows] = await pool.query<mysql.RowDataPacket[]>(
        "SELECT request_id FROM dashboard_guild_activation_requests WHERE guild_id = ? AND state IN ('PENDING', 'CHANGES_REQUESTED')",
        [guildId],
      );
      expect(liveRequestRows).toHaveLength(1);
    });

    it("approve racing reject on the same requestId: exactly one wins", async () => {
      const guildId = "600000000000000011";
      await seedGuild(guildId);
      const admin = await makeSession([{ id: guildId, owner: true, permissions: "0" }]);
      const superadmin = await makeSession(
        [{ id: guildId, owner: false, permissions: "0" }],
        TEST_SUPERADMIN_DISCORD_ID,
      );
      await saveMinimumChecklist(admin.cookie, guildId, "500000000000000081");
      const { requestId } = activationCreatedBody(
        await fastify.inject({
          method: "POST",
          url: `/api/guilds/${guildId}/request-activation`,
          headers: csrf(admin.cookie),
        }),
      ).data;

      const [approveRes, rejectRes] = await Promise.all([
        fastify.inject({
          method: "POST",
          url: `/api/admin/activation-requests/${requestId}/approve`,
          headers: csrf(superadmin.cookie),
        }),
        fastify.inject({
          method: "POST",
          url: `/api/admin/activation-requests/${requestId}/reject`,
          headers: csrf(superadmin.cookie),
          payload: { reason: "racing rejection" },
        }),
      ]);

      expect(statusCodes([approveRes, rejectRes])).toEqual([200, 409]);
      if (approveRes.statusCode === 409) {
        expect(errorBody(approveRes).error_code).toBe("REQUEST_ALREADY_DECIDED");
      } else {
        expect(errorBody(rejectRes).error_code).toBe("REQUEST_ALREADY_DECIDED");
      }

      const [requestRows] = await pool.query<mysql.RowDataPacket[]>(
        "SELECT state FROM dashboard_guild_activation_requests WHERE request_id = ?",
        [requestId],
      );
      const finalState = (requestRows[0] as { state: string }).state;
      expect(["APPROVED", "REJECTED"]).toContain(finalState);

      const [guildRows] = await pool.query<mysql.RowDataPacket[]>(
        "SELECT lifecycle_state FROM guilds WHERE guild_id = ?",
        [guildId],
      );
      const guildState = (guildRows[0] as { lifecycle_state: string }).lifecycle_state;
      // The guild's lifecycle_state must be consistent with WHICHEVER
      // decision actually won — never a hybrid/corrupted state.
      expect(guildState).toBe(finalState === "APPROVED" ? "ACTIVE" : "REJECTED");
    });

    it("approve racing request-changes on the same requestId: exactly one wins", async () => {
      const guildId = "600000000000000012";
      await seedGuild(guildId);
      const admin = await makeSession([{ id: guildId, owner: true, permissions: "0" }]);
      const superadmin = await makeSession(
        [{ id: guildId, owner: false, permissions: "0" }],
        TEST_SUPERADMIN_DISCORD_ID,
      );
      await saveMinimumChecklist(admin.cookie, guildId, "500000000000000082");
      const { requestId } = activationCreatedBody(
        await fastify.inject({
          method: "POST",
          url: `/api/guilds/${guildId}/request-activation`,
          headers: csrf(admin.cookie),
        }),
      ).data;

      const [approveRes, changesRes] = await Promise.all([
        fastify.inject({
          method: "POST",
          url: `/api/admin/activation-requests/${requestId}/approve`,
          headers: csrf(superadmin.cookie),
        }),
        fastify.inject({
          method: "POST",
          url: `/api/admin/activation-requests/${requestId}/request-changes`,
          headers: csrf(superadmin.cookie),
          payload: { reason: "racing request-changes" },
        }),
      ]);

      expect(statusCodes([approveRes, changesRes])).toEqual([200, 409]);
      const [requestRows] = await pool.query<mysql.RowDataPacket[]>(
        "SELECT state FROM dashboard_guild_activation_requests WHERE request_id = ?",
        [requestId],
      );
      const finalState = (requestRows[0] as { state: string }).state;
      expect(["APPROVED", "CHANGES_REQUESTED"]).toContain(finalState);

      const [guildRows] = await pool.query<mysql.RowDataPacket[]>(
        "SELECT lifecycle_state FROM guilds WHERE guild_id = ?",
        [guildId],
      );
      const guildState = (guildRows[0] as { lifecycle_state: string }).lifecycle_state;
      expect(guildState).toBe(finalState === "APPROVED" ? "ACTIVE" : "CHANGES_REQUESTED");
    });

    it("pause racing platform-suspend on the same guild: exactly one lifecycle transition wins", async () => {
      const guildId = "600000000000000013";
      await seedGuild(guildId);
      const admin = await makeSession([{ id: guildId, owner: true, permissions: "0" }]);
      const superadmin = await makeSession(
        [{ id: guildId, owner: false, permissions: "0" }],
        TEST_SUPERADMIN_DISCORD_ID,
      );
      await saveMinimumChecklist(admin.cookie, guildId, "500000000000000083");
      const { requestId } = activationCreatedBody(
        await fastify.inject({
          method: "POST",
          url: `/api/guilds/${guildId}/request-activation`,
          headers: csrf(admin.cookie),
        }),
      ).data;
      await fastify.inject({
        method: "POST",
        url: `/api/admin/activation-requests/${requestId}/approve`,
        headers: csrf(superadmin.cookie),
      });

      const [pauseRes, suspendRes] = await Promise.all([
        fastify.inject({ method: "POST", url: `/api/guilds/${guildId}/pause`, headers: csrf(admin.cookie) }),
        fastify.inject({
          method: "POST",
          url: `/api/admin/guilds/${guildId}/suspend`,
          headers: csrf(superadmin.cookie),
        }),
      ]);

      expect(statusCodes([pauseRes, suspendRes])).toEqual([200, 409]);
      const loser = pauseRes.statusCode === 409 ? pauseRes : suspendRes;
      expect(["ILLEGAL_TRANSITION", "CONCURRENT_MODIFICATION"]).toContain(errorBody(loser).error_code);

      const [guildRows] = await pool.query<mysql.RowDataPacket[]>(
        "SELECT lifecycle_state, suspended_from_state, row_version FROM guilds WHERE guild_id = ?",
        [guildId],
      );
      const finalState = (guildRows[0] as { lifecycle_state: string }).lifecycle_state;
      // Never a silent last-write-wins hybrid: exactly one of the two
      // legitimate outcomes, each internally consistent with
      // suspended_from_state.
      if (pauseRes.statusCode === 200) {
        expect(finalState).toBe("USER_PAUSED");
      } else {
        expect(finalState).toBe("PLATFORM_SUSPENDED");
        expect((guildRows[0] as { suspended_from_state: string | null }).suspended_from_state).toBe("ACTIVE");
      }
    });

    it("resume racing platform-suspend on the same guild: exactly one lifecycle transition wins", async () => {
      const guildId = "600000000000000014";
      await seedGuild(guildId);
      const admin = await makeSession([{ id: guildId, owner: true, permissions: "0" }]);
      const superadmin = await makeSession(
        [{ id: guildId, owner: false, permissions: "0" }],
        TEST_SUPERADMIN_DISCORD_ID,
      );
      await saveMinimumChecklist(admin.cookie, guildId, "500000000000000084");
      const { requestId } = activationCreatedBody(
        await fastify.inject({
          method: "POST",
          url: `/api/guilds/${guildId}/request-activation`,
          headers: csrf(admin.cookie),
        }),
      ).data;
      await fastify.inject({
        method: "POST",
        url: `/api/admin/activation-requests/${requestId}/approve`,
        headers: csrf(superadmin.cookie),
      });
      await fastify.inject({ method: "POST", url: `/api/guilds/${guildId}/pause`, headers: csrf(admin.cookie) });

      const [resumeRes, suspendRes] = await Promise.all([
        fastify.inject({ method: "POST", url: `/api/guilds/${guildId}/resume`, headers: csrf(admin.cookie) }),
        fastify.inject({
          method: "POST",
          url: `/api/admin/guilds/${guildId}/suspend`,
          headers: csrf(superadmin.cookie),
        }),
      ]);

      expect(statusCodes([resumeRes, suspendRes])).toEqual([200, 409]);
      const loser = resumeRes.statusCode === 409 ? resumeRes : suspendRes;
      expect(["ILLEGAL_TRANSITION", "CONCURRENT_MODIFICATION"]).toContain(errorBody(loser).error_code);

      const [guildRows] = await pool.query<mysql.RowDataPacket[]>(
        "SELECT lifecycle_state, suspended_from_state FROM guilds WHERE guild_id = ?",
        [guildId],
      );
      const finalState = (guildRows[0] as { lifecycle_state: string }).lifecycle_state;
      if (resumeRes.statusCode === 200) {
        expect(finalState).toBe("ACTIVE");
      } else {
        expect(finalState).toBe("PLATFORM_SUSPENDED");
        expect((guildRows[0] as { suspended_from_state: string | null }).suspended_from_state).toBe(
          "USER_PAUSED",
        );
      }
    });
  });
});
