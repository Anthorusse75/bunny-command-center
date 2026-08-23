/**
 * Dedicated bootstrap for the real-browser Playwright E2E suite
 * (apps/web/playwright.config.ts, apps/web/e2e/realtime.spec.ts).
 *
 * This is the ONE place the Step-03 synthetic test source adapter is wired
 * into a REAL, listening `apps/api` process - never into the process
 * `apps/api/src/server.ts` builds for production or for the Vitest
 * integration suite (which registers its own adapters per-test via
 * `apps/api/test/helpers/sseTestSource.ts` against an isolated database).
 * Living under `scripts/` (not `src/`) keeps the one-way dependency rule
 * intact (`src/` never imports from `scripts/` or `test/`) while still being
 * allowed to import test helpers itself.
 *
 * mission §35/§9: this is real production code (`buildServer`, the real
 * poller, the real SSE route) with ONE test-only DB-level seam registered at
 * startup - never an HTTP-reachable debug endpoint. The E2E test drives it
 * exclusively by inserting rows directly into `dashboard_sse_test_source`
 * (the same durable-DB-mutation entrypoint the Step-03 spec's own PROOF OF
 * WIRING section names) and by observing the real SSE stream / real
 * `apps/web` UI - never a debug HTTP call into this process.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import mysql from "mysql2/promise";
import { STEP_03_TEST_SCOPE, notificationEventTypeSchema } from "@bunny-command-center/shared";
import { buildServer } from "../src/server.js";
import { createNotification } from "../src/notifications/index.js";
import { buildRequireAuth } from "../src/auth/requireAuth.js";
import type { AppConfig } from "../src/config.js";
import { runUp } from "../migrations/runner.js";
import type { MigratorDbConfig } from "../migrations/config.js";
import { registerEventType, registerSourceAdapter } from "../src/sse/registry.js";
import { createKyselyClient } from "../src/db/kysely.js";
import { upsertDashboardUser } from "../src/auth/userRepo.js";
import { createSession } from "../src/auth/sessionRepo.js";
import { encryptSecret } from "../src/auth/tokenCrypto.js";
import { generateSessionToken } from "../src/auth/sessionToken.js";

// apps/api/test/helpers is allowed to be imported from scripts/ (only src/ is restricted).
import {
  TEST_EVENT_TYPE,
  createTestSourceAdapter,
  createTestSourceSchema,
  testEventDataSchema,
} from "../test/helpers/sseTestSource.js";
import {
  testDiscordConfig,
  testSessionConfig,
  testSuperadminConfig,
} from "../test/helpers/testAuthConfig.js";
import { startDiscordTestDouble, type DiscordTestDouble } from "../test/helpers/discordTestDouble.js";

const REAL_MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
// Step 06 addition: the SHARED self-bot schema migrations (`guilds` table —
// bot-presence cross-reference). The Step 03 E2E harness never needed this
// (Guild Admin Resolution/realtime never touch `guilds`); Step 06's
// multi-guild E2E suite is the first to need real bot-presence fixture
// rows, applied the SAME way `test/guilds/routes.test.ts` does for the
// Vitest integration suite — this repo's own generic runner against the
// vendored migrations directory, never a second migration mechanism.
const SHARED_MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "vendor",
  "self-bot-schema",
  "database",
  "migrations",
);

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable for the E2E server: ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  // Two DB identities, matching the production/CI separation convention
  // (migrations/README.md): a DDL-privileged account for migrations/fixture
  // setup, and a narrower runtime account for the app pool. Both may point
  // at the same throwaway local/CI-only database.
  const migratorConfig: MigratorDbConfig = {
    host: process.env["MIGRATOR_DB_HOST"] ?? required("DB_HOST"),
    port: Number(process.env["MIGRATOR_DB_PORT"] ?? process.env["DB_PORT"] ?? 3306),
    user: process.env["MIGRATOR_DB_USER"] ?? required("DB_USER"),
    password: process.env["MIGRATOR_DB_PASSWORD"] ?? required("DB_PASSWORD"),
    database: process.env["MIGRATOR_DB_NAME"] ?? required("DB_NAME"),
  };
  const dbConfig: MigratorDbConfig = {
    host: required("DB_HOST"),
    port: Number(process.env["DB_PORT"] ?? 3306),
    user: required("DB_USER"),
    password: required("DB_PASSWORD"),
    database: required("DB_NAME"),
  };

  // Ensures the SHARED self-bot schema (`guilds` — Step 06's bot-presence
  // fixture table), the Dashboard migration ledger (dashboard_sse_cursor,
  // dashboard_user_guild_preferences, etc.), and the synthetic test source
  // fixture table all exist before the server starts accepting connections -
  // real DDL, the same runner CI/integration tests use, never ad hoc SQL
  // against a table the server will actually query.
  const conn = await mysql.createConnection(migratorConfig);
  try {
    const sharedResult = await runUp(conn, SHARED_MIGRATIONS_DIR, migratorConfig);
    if (!sharedResult.ok) {
      throw new Error(`E2E server: shared schema migration failed: ${sharedResult.message}`);
    }
    const migrationResult = await runUp(conn, REAL_MIGRATIONS_DIR, migratorConfig);
    if (!migrationResult.ok) {
      throw new Error(`E2E server: Dashboard migration failed: ${migrationResult.message}`);
    }
    await createTestSourceSchema(conn);
  } finally {
    await conn.end();
  }

  registerEventType({ type: TEST_EVENT_TYPE, schema: testEventDataSchema });
  const pool = mysql.createPool(dbConfig);
  registerSourceAdapter(createTestSourceAdapter(pool));

  // Step 06 addition: a REAL local Discord OAuth test double (the exact
  // same one apps/api/test/auth/*.test.ts and apps/api/test/guilds/routes.test.ts
  // use — 31_TEST_STRATEGY.md's "a controlled local Discord OAuth HTTP test
  // double is acceptable for deterministic protocol testing"), so
  // `GET /api/users/me/guilds`/`GET /api/guilds/:guildId` have something
  // real to call during the Playwright suite. `testDiscordConfig()`'s
  // placeholder URLs (`http://127.0.0.1:0/...`) were sufficient for Steps
  // 01-04's E2E specs (none of them ever make a live Discord call — the
  // test-only login route below bypasses that entirely), but Step 06's
  // multi-guild spec is the first E2E suite that needs one.
  const discordDouble: DiscordTestDouble = await startDiscordTestDouble();

  const config: AppConfig = {
    port: Number(process.env["PORT"] ?? 8090),
    logLevel: process.env["LOG_LEVEL"] ?? "info",
    appVersion: "0.1.0-e2e",
    db: dbConfig,
    sse: {
      // Fast intervals so the E2E suite doesn't need long waits for the
      // real poller/heartbeat to do their thing.
      heartbeatSeconds: Number(process.env["SSE_HEARTBEAT_SECONDS"] ?? 2),
      pollIntervalMs: Number(process.env["SSE_POLL_INTERVAL_MS"] ?? 200),
      maxQueuedFramesPerConnection: 200,
      maxRowsPerSourcePerTick: 500,
    },
    discord: {
      ...testDiscordConfig(),
      authorizeBaseUrl: discordDouble.baseUrl,
      tokenUrl: discordDouble.tokenUrl,
      apiBaseUrl: discordDouble.apiBaseUrl,
    },
    session: testSessionConfig(),
    superadmin: testSuperadminConfig(),
  };

  const fastify = await buildServer(config);

  // TEST-ONLY, this file only (mission §35's "test-only event injection may
  // exist behind test-only dependency wiring, but not a publicly shippable
  // debug API" - never registered by src/server.ts/buildServer(), only by
  // this dedicated E2E-harness script). Step 04's browser suite needs a way
  // to reach the AUTHENTICATED app surface without driving a real Discord
  // consent screen (31_TEST_STRATEGY.md: a controlled test double is
  // acceptable for protocol testing; the Step-01/02/03 regression specs this
  // route exists for don't test OAuth AT ALL, they test the design
  // system/realtime transport, which now sits behind Step 04's auth gate).
  // Reuses the REAL session-creation code path (createSession/
  // upsertDashboardUser/encryptSecret - the exact functions
  // apps/api/src/auth/routes.ts's real callback handler calls), skipping
  // only the Discord round-trip itself, and sets the cookie with the same
  // attributes production login sets. `apps/web/e2e/auth.setup.ts` is the
  // only consumer, once, to seed Playwright's shared `storageState` - it is
  // never called from `apps/web/src/` runtime code.
  //
  // Step 06 addition: optional `?discordUserId=` (defaults to the original
  // Step-04 fixed ID, so every pre-existing spec keeps working unchanged)
  // and `?guilds=<url-encoded JSON array>` query params. The encrypted
  // access token this route stores is now always
  // `discordDouble.state.currentAccessToken` itself (never a second,
  // independent fake string) so a REAL `GET /api/users/me/guilds` call made
  // by the browser afterward authenticates against the double correctly —
  // this is what makes the multi-guild E2E suite's guild list/switcher
  // genuinely real rather than a client-only fixture.
  const testOnlyDb = createKyselyClient(dbConfig);
  fastify.get<{ Querystring: { discordUserId?: string; guilds?: string } }>(
    "/api/__test__/login",
    async (request, reply) => {
      const discordUserId = request.query.discordUserId ?? "900000000001";
      if (request.query.guilds) {
        discordDouble.state.guilds = JSON.parse(request.query.guilds) as typeof discordDouble.state.guilds;
      }
      const user = await upsertDashboardUser(testOnlyDb, {
        discordUserId,
        username: "E2ETestUser",
        avatarHash: null,
        encryptedAccessToken: encryptSecret(
          discordDouble.state.currentAccessToken,
          config.session.tokenEncryptionKey,
        ),
        encryptedRefreshToken: encryptSecret("e2e-fake-refresh-token", config.session.tokenEncryptionKey),
        tokenExpiresAt: new Date(Date.now() + 3600_000),
      });
      const rawToken = generateSessionToken();
      await createSession(testOnlyDb, rawToken, {
        userId: user.id,
        deviceLabel: null,
        userAgent: null,
        ipHash: null,
        slidingTtlMs: config.session.slidingTtlMs,
        absoluteTtlMs: config.session.absoluteTtlMs,
      });
      reply.setCookie(config.session.cookieName, rawToken, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge: Math.floor(config.session.slidingTtlMs / 1000),
      });
      return { data: { success: true } };
    },
  );

  // TEST-ONLY (this file only) — seeds/updates a row in the SHARED `guilds`
  // table (bot-presence fixture: "has Bunny actually been added to this
  // guild"). Mirrors `test/guilds/routes.test.ts`'s direct-pool-insert
  // approach at the integration level, exposed here as a route because the
  // E2E harness has no other in-process seam into the running server's own
  // DB pool. `apps/web/e2e/multi-guild.spec.ts` is the only consumer.
  fastify.get<{ Querystring: { guildId: string; displayName?: string; enabled?: string } }>(
    "/api/__test__/seed-guild",
    async (request, reply) => {
      const { guildId, displayName, enabled } = request.query;
      await pool.query(
        "INSERT INTO guilds (guild_id, display_name_cache, enabled) VALUES (?, ?, ?) " +
          "ON DUPLICATE KEY UPDATE display_name_cache = VALUES(display_name_cache), enabled = VALUES(enabled)",
        [guildId, displayName ?? null, enabled === "false" ? 0 : 1],
      );
      return reply.send({ data: { success: true } });
    },
  );
  // TEST-ONLY (this file only — mission §35: "a way for Playwright to
  // invoke the real createNotification() service through a test-only seam
  // that is NOT present in production builds and NOT a raw DB insert from
  // the test"). Reuses this SAME pattern's established shape (`/api/__test__/
  // login`/`/api/__test__/seed-guild` above): a route registered ONLY on
  // this dedicated E2E-harness script's fastify instance (never
  // `src/server.ts`/`buildServer()` itself, so it is genuinely absent from
  // both the production build and the Vitest integration suite's own
  // server instances), calling the REAL `createNotification()` service
  // function — the exact same one `apps/api/src/notifications/routes.ts`'s
  // production `GET /api/notifications` list reads back from, never a
  // second, test-only insert path. `apps/web/e2e/notifications.spec.ts` is
  // the only consumer. Requires the caller to already be authenticated
  // (via `/api/__test__/login` above) — the notification is created for
  // THAT session's own `dashboard_users` row, never an arbitrary
  // client-supplied userId.
  fastify.get<{ Querystring: { eventType?: string; guildId?: string; deeplinkPath?: string } }>(
    "/api/__test__/trigger-notification",
    { preHandler: [buildRequireAuth(testOnlyDb, config)] },
    async (request, reply) => {
      const parsedEventType = notificationEventTypeSchema.safeParse(
        request.query.eventType ?? "UPLOAD_COMPLETED",
      );
      if (!parsedEventType.success) {
        return reply
          .code(400)
          .send({ error_code: "VALIDATION_ERROR", message_key: "errors.validation", parameters: {} });
      }
      const result = await createNotification(
        testOnlyDb,
        config,
        {
          userId: request.authUser!.id,
          eventType: parsedEventType.data,
          parameters: { count: 3, guildName: "Test Guild" },
          guildId: request.query.guildId ?? null,
          deeplinkPath: request.query.deeplinkPath ?? "/contributions",
        },
        request.log,
      );
      return { data: result };
    },
  );

  await fastify.listen({ port: config.port, host: "127.0.0.1" });
  console.log(`[e2e-server] listening on http://127.0.0.1:${config.port}`);

  startNativeDropSentinelWatcher(pool, fastify);
}

/**
 * TEST-ONLY, this file only (never `src/`): watches for a sentinel row
 * (`payload_json.label === "TRIGGER_NATIVE_DROP"`) inserted directly by
 * apps/web/e2e/realtime.spec.ts's real-native-reconnect test, and - once
 * the poller has had a chance to broadcast that row like any other real
 * event - calls the hub's `simulateNetworkDropForTests` to genuinely sever
 * every currently-open `test`-scope connection. This is what lets that one
 * Playwright test prove a REAL native `EventSource` reconnect (the browser
 * itself decides to reconnect and sends the real `Last-Event-ID` header -
 * nothing in this repo's client code participates) rather than a
 * client-driven `forceDisconnectForTests()`/manual-reconnect path, which
 * proves a different (also real, also tested) mechanism.
 *
 * Polls the DB directly rather than going through the registered adapter/
 * poller pipeline so this stays entirely outside the generic realtime
 * mechanism under test - it observes, it never participates in, the thing
 * being proven.
 */
function startNativeDropSentinelWatcher(
  pool: mysql.Pool,
  fastify: Awaited<ReturnType<typeof buildServer>>,
): void {
  const alreadyTriggered = new Set<number>();
  const timer = setInterval(() => {
    void (async () => {
      const [rows] = await pool.query<(mysql.RowDataPacket & { id: number })[]>(
        "SELECT id FROM dashboard_sse_test_source WHERE JSON_EXTRACT(payload_json, '$.label') = ? ORDER BY id ASC",
        ["TRIGGER_NATIVE_DROP"],
      );
      for (const row of rows) {
        if (alreadyTriggered.has(row.id)) {
          continue;
        }
        alreadyTriggered.add(row.id);
        // Give the poller a moment to have already broadcast this exact
        // row to currently-connected clients before severing them - the
        // test's own proof depends on the anchor event having genuinely
        // arrived first.
        setTimeout(() => {
          fastify.sseTestHooks?.hub.simulateNetworkDropForTests(STEP_03_TEST_SCOPE);
        }, 300);
      }
    })();
  }, 150);
  timer.unref();
}

void main();
