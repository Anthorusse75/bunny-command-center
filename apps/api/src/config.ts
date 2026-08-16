export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface SseConfig {
  /** 26_REALTIME_SSE_AND_SYNC.md: "`heartbeat` fires every 15s". 32_DEPLOYMENT_AND_OPERATIONS.md env table: `SSE_HEARTBEAT_SECONDS` (default 15). */
  heartbeatSeconds: number;
  /** 03_realtime_infrastructure.md: "An internal poller (2-5s interval)". */
  pollIntervalMs: number;
  /** Backpressure bound (mission §16) - per-connection outbound queue depth before the connection is terminated (correctness-review defect 1 - no longer "before the oldest queued frame is dropped": a dropped cursor-bearing frame could let a later id silently skip it). */
  maxQueuedFramesPerConnection: number;
  /** Max rows fetched from one source adapter per poll tick (29_PERFORMANCE_AND_SCALABILITY.md: no unbounded per-event query) - also used as the page size when paginating a replay up to its snapshotted target (correctness-review defect 2). */
  maxRowsPerSourcePerTick: number;
}

export interface AppConfig {
  port: number;
  logLevel: string;
  db: DbConfig;
  appVersion: string;
  sse: SseConfig;
}

/**
 * Minimal shape both `process.env` and a plain test object satisfy - lets
 * every function in this file be called either with real process env
 * (the default, at real server startup) or an explicit plain object (unit
 * tests, matching the existing convention already used by
 * `apps/api/migrations/config.ts`'s `loadMigratorDbConfig`).
 */
export type EnvSource = Record<string, string | undefined>;

function required(env: EnvSource, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Fail-fast validation for the Step-03 SSE numeric env vars
 * (correctness-review defect 7). Frozen architecture documents a DEFAULT for
 * each of these (26_REALTIME_SSE_AND_SYNC.md's "heartbeat fires every 15s",
 * 03_realtime_infrastructure.md's "internal poller (2-5s interval)" - stated
 * as an illustrative "e.g.", not a hard bound) but never a strict numeric
 * range any of them must fall within, so this only enforces the minimum bar
 * the review itself specifies - finite, integer, strictly positive - rather
 * than inventing an arbitrary tighter limit unrelated to any documented
 * constraint. An invalid value fails server startup/config loading with a
 * precise error (never silently substitutes the default for a *present but
 * invalid* value - only a genuinely ABSENT env var uses the default).
 */
export function positiveIntEnv(env: EnvSource, name: string, defaultValue: number): number {
  const raw = env[name];
  const value = raw === undefined ? defaultValue : Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `Invalid ${name}: must be a finite positive integer, got ${JSON.stringify(raw ?? defaultValue)}`,
    );
  }
  return value;
}

/**
 * Reads the RUNTIME app's DB connection (DB_*) — deliberately distinct from
 * MIGRATOR_DB_* (see migrations/config.ts), which only the migration runner
 * reads. This function is called at server startup so a missing DB_* var
 * fails fast; an unreachable *value* (bad host/port) must NOT throw here —
 * only /readyz, not /healthz or startup, is allowed to observe that.
 *
 * `env` defaults to the real `process.env` (every real call site relies on
 * this default and passes nothing); tests pass an explicit plain object so
 * config validation can be exercised without mutating global process state.
 */
export function loadAppConfig(env: EnvSource = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 8080),
    logLevel: env.LOG_LEVEL ?? "info",
    db: {
      host: required(env, "DB_HOST"),
      port: Number(env.DB_PORT ?? 3306),
      user: required(env, "DB_USER"),
      password: required(env, "DB_PASSWORD"),
      database: required(env, "DB_NAME"),
    },
    appVersion: env.DASHBOARD_APP_VERSION ?? "0.1.0-scaffold",
    sse: {
      heartbeatSeconds: positiveIntEnv(env, "SSE_HEARTBEAT_SECONDS", 15),
      pollIntervalMs: positiveIntEnv(env, "SSE_POLL_INTERVAL_MS", 3000),
      maxQueuedFramesPerConnection: positiveIntEnv(env, "SSE_MAX_QUEUED_FRAMES", 200),
      maxRowsPerSourcePerTick: positiveIntEnv(env, "SSE_MAX_ROWS_PER_SOURCE_PER_TICK", 500),
    },
  };
}
