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
  /** Backpressure bound (mission §16) - per-connection outbound queue depth before the oldest queued frame is dropped. */
  maxQueuedFramesPerConnection: number;
  /** Max rows fetched from one source adapter per poll tick (29_PERFORMANCE_AND_SCALABILITY.md: no unbounded per-event query). */
  maxRowsPerSourcePerTick: number;
}

export interface AppConfig {
  port: number;
  logLevel: string;
  db: DbConfig;
  appVersion: string;
  sse: SseConfig;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Reads the RUNTIME app's DB connection (DB_*) — deliberately distinct from
 * MIGRATOR_DB_* (see migrations/config.ts), which only the migration runner
 * reads. This function is called at server startup so a missing DB_* var
 * fails fast; an unreachable *value* (bad host/port) must NOT throw here —
 * only /readyz, not /healthz or startup, is allowed to observe that.
 */
export function loadAppConfig(): AppConfig {
  return {
    port: Number(process.env.PORT ?? 8080),
    logLevel: process.env.LOG_LEVEL ?? "info",
    db: {
      host: required("DB_HOST"),
      port: Number(process.env.DB_PORT ?? 3306),
      user: required("DB_USER"),
      password: required("DB_PASSWORD"),
      database: required("DB_NAME"),
    },
    appVersion: process.env.DASHBOARD_APP_VERSION ?? "0.1.0-scaffold",
    sse: {
      heartbeatSeconds: Number(process.env.SSE_HEARTBEAT_SECONDS ?? 15),
      pollIntervalMs: Number(process.env.SSE_POLL_INTERVAL_MS ?? 3000),
      maxQueuedFramesPerConnection: Number(process.env.SSE_MAX_QUEUED_FRAMES ?? 200),
      maxRowsPerSourcePerTick: Number(process.env.SSE_MAX_ROWS_PER_SOURCE_PER_TICK ?? 500),
    },
  };
}
