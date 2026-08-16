import { pathToFileURL } from "node:url";
import Fastify, { LogController } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import { loadAppConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { healthRoutes } from "./routes/health.js";
import { versionRoutes } from "./routes/version.js";
import { createKyselyClient } from "./db/kysely.js";
import {
  SseHub,
  buildSseRoutePlugin,
  createSseCursorRepo,
  startSsePoller,
  type SseCursorRepo,
  type SsePollerHandle,
} from "./sse/index.js";
import { buildAuthRoutes, startSessionSweep, type SessionSweepHandle } from "./auth/index.js";

/**
 * In-process-only test seam (never an HTTP-reachable route - mission §35:
 * "Test-only event injection may exist behind test-only dependency wiring,
 * but not a publicly shippable debug API"). Lets integration tests observe
 * `hub.activeConnectionCount` and force a poll tick without reaching into
 * `buildServer`'s closure.
 */
export interface SseTestHooks {
  hub: SseHub;
  cursorRepo: SseCursorRepo;
  poller: SsePollerHandle;
}

/** Same in-process-only test seam convention as SseTestHooks above, for Step 04's session-sweep timer. */
export interface AuthTestHooks {
  sessionSweep: SessionSweepHandle;
}

declare module "fastify" {
  interface FastifyInstance {
    sseTestHooks?: SseTestHooks;
    authTestHooks?: AuthTestHooks;
  }
}

const POLLED_HEALTH_ROUTES = new Set(["/healthz", "/readyz"]);
// /api/stream is a long-lived connection re-established on every reconnect
// (native EventSource retry, foreground/background, grace-timeout fallback
// recovery) - Fastify's automatic "incoming request"/"request completed"
// access-log pair would both spam the log at reconnect frequency AND report
// a meaningless "duration" (the entire connection lifetime). The route
// itself emits its own explicit, low-frequency info-level open/close lines
// (sse/route.ts) instead - mission §28/§50: no heartbeat-driven log spam.
const UNLOGGED_ROUTES = new Set([...POLLED_HEALTH_ROUTES, "/api/stream"]);

export async function buildServer(config = loadAppConfig()) {
  const logger = createLogger(config.logLevel);
  const fastify = Fastify({
    loggerInstance: logger,
    logController: new LogController({
      disableRequestLogging: (request) => UNLOGGED_ROUTES.has(request.url),
    }),
  });

  // Cookie parsing/serialization (Step 04: session + pre-auth OAuth
  // transaction cookies). No `secret` option here - this repo signs the one
  // cookie that needs tamper-detection (the pre-auth transaction cookie)
  // itself, with its own dedicated HMAC key (auth/transactionCookie.ts),
  // rather than relying on this plugin's generic cookie-signing feature for
  // every cookie in the app.
  await fastify.register(fastifyCookie);
  // Rate limiting (27_SECURITY.md: "/api/auth/login, /api/auth/callback:
  // tight rate limit per IP"). Global default is generous; the login/callback
  // routes set their own tighter `config.rateLimit` (auth/routes.ts).
  await fastify.register(fastifyRateLimit, { global: false });

  await fastify.register(healthRoutes(config));
  await fastify.register(versionRoutes(config));

  // Realtime infrastructure (03_realtime_infrastructure.md). The Kysely
  // client here is a SEPARATE pool from readiness.ts's own short-lived
  // connection by design (readiness.ts intentionally never shares the app's
  // pool - see its own comment) and is closed via the onClose hook below,
  // alongside the poller and every open SSE connection, so a graceful
  // shutdown (32_DEPLOYMENT_AND_OPERATIONS.md §Graceful shutdown) never
  // leaves a dangling pool, timer, or socket. Step 04 reuses this SAME pool
  // for dashboard_users/dashboard_sessions access - one runtime connection
  // pool for the whole process, per ADR-022.
  const db = createKyselyClient(config.db);
  const cursorRepo = createSseCursorRepo(db);
  const hub = new SseHub();
  const poller = startSsePoller({
    hub,
    cursorRepo,
    logger,
    pollIntervalMs: config.sse.pollIntervalMs,
    maxRowsPerTick: config.sse.maxRowsPerSourcePerTick,
  });

  await fastify.register(buildAuthRoutes(db, config));
  const sessionSweep = startSessionSweep({ db, logger, intervalMs: config.session.sweepIntervalMs });
  fastify.decorate("authTestHooks", { sessionSweep });

  await fastify.register(buildSseRoutePlugin({ hub, cursorRepo, config, db }));
  fastify.decorate("sseTestHooks", { hub, cursorRepo, poller });

  // `preClose`, not `onClose`: Fastify's OWN internal "stop the HTTP server"
  // logic (`instance.server.close(...)`) is itself registered as an
  // `onClose` hook, and Node's `http.Server.close()` blocks until every live
  // connection ends on its own - an open, hijacked, `Connection: keep-alive`
  // SSE stream never does that by itself. `preClose` hooks run BEFORE that
  // internal close attempt (Fastify's own documented seam for exactly this:
  // "clean up resources before the server stops accepting connections"), so
  // this is where the SSE streams are actually told to close - registering
  // this as `onClose` instead deadlocks `fastify.close()` forever (verified
  // empirically; see the Step-03 HANDOVER's Deviations/lessons section).
  fastify.addHook("preClose", async () => {
    poller.stop();
    sessionSweep.stop();
    hub.closeAll("server_shutting_down");
    await db.destroy();
  });

  return fastify;
}

async function main(): Promise<void> {
  const config = loadAppConfig();
  const fastify = await buildServer(config);

  const shutdown = async (signal: string): Promise<void> => {
    fastify.log.info({ signal }, "shutting down");
    await fastify.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await fastify.listen({ port: config.port, host: "0.0.0.0" });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

// pathToFileURL (not manual string concatenation) so this is correct on
// Windows too, where a naive `file://${argv[1]}` is missing the extra `/`
// before the drive letter (`file:///D:/...`) and silently never matches -
// found by observing the built server exit immediately with no output.
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  void main();
}
