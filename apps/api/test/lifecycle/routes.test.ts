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
  let config: AppConfig;
  let fastify: Awaited<ReturnType<typeof buildServer>>;
  let pool: mysql.Pool;

  beforeAll(async () => {
    const dbConfig = await freshDatabase();
    pool = mysql.createPool(dbConfig);
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

  let userCounter = 800100000000000000n;
  let sessionCounter = 0;
  /**
   * `discordTestDouble.ts`'s `state.guilds` is a SINGLE shared fixture (not
   * keyed per access token/user) — the double always answers "the caller's
   * own guild list" with whatever this field currently holds. `guilds/routes.test.ts`
   * never interleaves two different sessions' requests, so this never
   * mattered there; this test file DOES (an admin action followed by a
   * Superadmin action, back and forth, in the same test). `cookie` is
   * therefore a GETTER, not a plain field: reading it re-syncs
   * `discord.state.guilds` to THIS session's own fixture at the exact moment
   * a request is about to use it, regardless of what any other session did
   * in between — every existing `session.cookie` call site gets this for
   * free, no per-call-site changes needed.
   */
  async function makeSession(
    guilds: { id: string; owner: boolean; permissions: string; name?: string }[],
    discordUserId?: string,
  ): Promise<{ readonly cookie: string; readonly discordUserId: string; readonly userId: number }> {
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
    const rawCookie = `${config.session.cookieName}=${rawToken}`;
    return {
      get cookie(): string {
        discord.state.guilds = guilds;
        return rawCookie;
      },
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
});
