import { isSyntacticallyValidSnowflake } from "./auth/snowflake.js";

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

export interface DiscordOAuthConfig {
  /** Bunny OCR Discord APPLICATION client ID (07_DISCORD_OAUTH.md) — never the bot token. */
  clientId: string;
  /** Server-only secret, never sent to the browser, never logged. */
  clientSecret: string;
  /** Registered per-environment on the Discord Developer Portal (07_DISCORD_OAUTH.md). Trusted-value only, never client-supplied. */
  redirectUri: string;
  /** ADR-004 (corrected 2026-08-11, second pass): `identify guilds guilds.members.read` — see HANDOVER for the scope-contradiction resolution. */
  scope: string;
  /** Overridable so integration tests can point at a local controlled Discord test double instead of the real discord.com hosts. */
  authorizeBaseUrl: string;
  tokenUrl: string;
  apiBaseUrl: string;
}

export interface SuperadminConfig {
  /**
   * ADR-008: exactly one, non-delegable Superadmin Discord user ID, sourced
   * strictly from `PLATFORM_SUPERADMIN_DISCORD_ID` -- never a DB row, never
   * UI-editable. `loadAppConfig` fails loudly (throws at startup) if this is
   * absent or not a syntactically valid Discord Snowflake, exactly like
   * `DISCORD_CLIENT_ID`/the encryption keys below already do for their own
   * required values -- there is no separate "production-only" code path in
   * this loader (every real call site is server startup; tests either build
   * an `AppConfig` object directly or pass an explicit fake `env` object, see
   * `test/helpers/testAuthConfig.ts`), so this validation is unconditional,
   * matching ADR-008's "production startup fails loudly" contract via the
   * only startup path that exists.
   */
  discordUserId: string;
}

export interface SessionConfig {
  cookieName: string;
  /** Pre-auth OAuth transaction cookie name — distinct purpose from the post-auth session cookie (27_SECURITY.md: session fixation prevention). */
  transactionCookieName: string;
  /** HMAC key (raw bytes) signing the pre-auth transaction cookie so its state/PKCE/redirect payload can't be tampered with. */
  transactionSigningKey: Buffer;
  /** AES-256-GCM key (32 raw bytes) encrypting Discord access/refresh tokens at rest (ADR-020). */
  tokenEncryptionKey: Buffer;
  slidingTtlMs: number;
  absoluteTtlMs: number;
  sweepIntervalMs: number;
}

export interface AppConfig {
  port: number;
  logLevel: string;
  db: DbConfig;
  appVersion: string;
  sse: SseConfig;
  discord: DiscordOAuthConfig;
  session: SessionConfig;
  superadmin: SuperadminConfig;
  /**
   * Step 09 (Notifications): the absolute base URL of THIS deployment of
   * the Dashboard, used to build the Discord-DM footer's
   * "manage your preferences" deep link
   * (18_NOTIFICATIONS_AND_DISCORD_DM.md §First-DM footer). Deliberately the
   * SAME env var name (`DASHBOARD_PUBLIC_URL`) Bunny OCR's own Reminder
   * Bulk-Upload CTA already reads (`02_NEW_BOT_OCR/cogs/y_tasks.py`'s
   * `_dashboard_public_url()`) — one shared convention across both services,
   * per this step's task brief ("using the project's existing configured
   * Dashboard public base URL env var (never hardcode a hostname)").
   * OPTIONAL, deliberately mirroring Bunny's own `_dashboard_public_url()`
   * graceful-degradation contract: unset/malformed -> `undefined`, and the
   * DM footer is omitted entirely rather than shipping a broken link
   * (`apps/api/src/notifications/service.ts`) — never a startup failure,
   * since a Dashboard instance can legitimately run before its own public
   * URL is finalized (mirrors Bunny's own "never a hard failure of the
   * whole reminder send over this one optional addition"). Deliberately an
   * OPTIONAL property (not `string | undefined`, always-present) — under
   * this project's `exactOptionalPropertyTypes: true`, that lets every
   * EXISTING test that builds an `AppConfig` object literal directly
   * (`apps/api/test/**`, none of which know about this new field) keep
   * compiling unchanged by simply omitting the key, rather than requiring a
   * mechanical edit to every one of those files for a property their tests
   * never exercise.
   */
  publicUrl?: string;
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
/**
 * Decodes a required env var expected to hold N raw bytes, encoded as hex or
 * base64 (hex preferred/documented in .env.example; base64 accepted too since
 * it's a common secret-manager convention). Fails fast and loudly on a
 * missing/malformed/wrong-length value — a silently-truncated or
 * silently-zero encryption/signing key is exactly the kind of defect this
 * step's security invariants forbid (27_SECURITY.md: never weaken security
 * to make startup "just work").
 */
function requiredKeyBytes(env: EnvSource, name: string, expectedLength: number): Buffer {
  const raw = required(env, name);
  const buf =
    /^[0-9a-fA-F]+$/.test(raw) && raw.length === expectedLength * 2
      ? Buffer.from(raw, "hex")
      : Buffer.from(raw, "base64");
  if (buf.length !== expectedLength) {
    throw new Error(
      `Invalid ${name}: expected ${expectedLength} raw bytes (hex or base64 encoded), got ${buf.length} bytes.`,
    );
  }
  return buf;
}

/**
 * ADR-008: "production startup fails loudly if `PLATFORM_SUPERADMIN_DISCORD_ID`
 * is unset or not a syntactically valid Discord snowflake." An absent value
 * fails via the same `required()` path as every other mandatory env var; a
 * PRESENT-but-malformed value (e.g. "12345", "not-a-snowflake") fails with a
 * distinct, precise message rather than being silently accepted and only
 * failing later, confusingly, the first time `isSuperadmin` is called.
 */
function requiredSnowflakeEnv(env: EnvSource, name: string): string {
  // Absent (`undefined`) is a distinct failure from PRESENT-but-empty/
  // malformed (mirrors `positiveIntEnv`'s own "an explicitly-set empty var
  // is a present, invalid value, never silently treated as absent" rule) —
  // an operator who set `PLATFORM_SUPERADMIN_DISCORD_ID=` by mistake gets a
  // precise "Invalid" error, not a misleading "Missing" one.
  if (env[name] === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  const value = env[name];
  if (!isSyntacticallyValidSnowflake(value)) {
    throw new Error(
      `Invalid ${name}: must be a syntactically valid Discord snowflake (15-20 digits), got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

/**
 * Mirrors Bunny's own `_dashboard_public_url()` validation exactly
 * (`02_NEW_BOT_OCR/cogs/y_tasks.py:104-142`): a present-but-malformed value
 * degrades to `undefined` (never throws — see `AppConfig.publicUrl`'s own
 * doc comment for why this must never be a startup failure).
 */
function optionalPublicUrlEnv(env: EnvSource, name: string): string | undefined {
  const raw = env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    // No trailing slash, so callers can safely do `${publicUrl}/some/path`.
    return raw.endsWith("/") ? raw.slice(0, -1) : raw;
  } catch {
    return undefined;
  }
}

export function loadAppConfig(env: EnvSource = process.env): AppConfig {
  const publicUrl = optionalPublicUrlEnv(env, "DASHBOARD_PUBLIC_URL");
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
    discord: {
      clientId: required(env, "DISCORD_CLIENT_ID"),
      clientSecret: required(env, "DISCORD_CLIENT_SECRET"),
      redirectUri: required(env, "DISCORD_REDIRECT_URI"),
      // ADR-004 (corrected 2026-08-11, second pass) / 07_DISCORD_OAUTH.md: `identify guilds guilds.members.read`.
      scope: env.DISCORD_OAUTH_SCOPE ?? "identify guilds guilds.members.read",
      authorizeBaseUrl: env.DISCORD_AUTHORIZE_BASE_URL ?? "https://discord.com/oauth2/authorize",
      tokenUrl: env.DISCORD_TOKEN_URL ?? "https://discord.com/api/oauth2/token",
      apiBaseUrl: env.DISCORD_API_BASE_URL ?? "https://discord.com/api",
    },
    session: {
      cookieName: env.DASHBOARD_SESSION_COOKIE_NAME ?? "bcc_session",
      transactionCookieName: env.DASHBOARD_OAUTH_TRANSACTION_COOKIE_NAME ?? "bcc_oauth_txn",
      transactionSigningKey: requiredKeyBytes(env, "DASHBOARD_OAUTH_TRANSACTION_SIGNING_KEY", 32),
      tokenEncryptionKey: requiredKeyBytes(env, "DASHBOARD_TOKEN_ENCRYPTION_KEY", 32),
      slidingTtlMs: positiveIntEnv(env, "DASHBOARD_SESSION_SLIDING_TTL_DAYS", 30) * 24 * 60 * 60 * 1000,
      absoluteTtlMs: positiveIntEnv(env, "DASHBOARD_SESSION_ABSOLUTE_TTL_DAYS", 90) * 24 * 60 * 60 * 1000,
      sweepIntervalMs: positiveIntEnv(env, "DASHBOARD_SESSION_SWEEP_INTERVAL_MINUTES", 60) * 60 * 1000,
    },
    superadmin: {
      // ADR-008: never a DB row, never UI-editable -- this is the ONLY place
      // this value is read from the environment; every Superadmin check
      // downstream (`auth/superadmin.ts`'s `isSuperadmin`) receives it
      // already-validated from `config.superadmin.discordUserId`.
      discordUserId: requiredSnowflakeEnv(env, "PLATFORM_SUPERADMIN_DISCORD_ID"),
    },
    ...(publicUrl !== undefined ? { publicUrl } : {}),
  };
}
