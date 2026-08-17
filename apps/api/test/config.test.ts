/**
 * Correctness-review defect 7: the Step-03 SSE numeric env vars
 * (SSE_HEARTBEAT_SECONDS, SSE_POLL_INTERVAL_MS, SSE_MAX_QUEUED_FRAMES,
 * SSE_MAX_ROWS_PER_SOURCE_PER_TICK) must fail fast on any non-finite,
 * non-integer, or non-positive value rather than silently accepting one
 * (e.g. a negative SSE_MAX_QUEUED_FRAMES combined with the queue-bound
 * check could previously have produced surprising behavior). `loadAppConfig`
 * takes an explicit env object (apps/api/src/config.ts's own doc comment)
 * so these can be exercised without touching real `process.env`.
 */
import { describe, expect, it } from "vitest";
import { loadAppConfig, positiveIntEnv, type EnvSource } from "../src/config.js";

const REQUIRED_DB_ENV: EnvSource = {
  DB_HOST: "127.0.0.1",
  DB_USER: "u",
  DB_PASSWORD: "p",
  DB_NAME: "n",
  // Step 04: OAuth/session config is also required for loadAppConfig() to
  // succeed — deliberately-fake, non-secret placeholder values (see
  // test/helpers/testAuthConfig.ts for the equivalent used by other suites;
  // this file constructs its own inline since it exercises loadAppConfig's
  // ENV-STRING parsing specifically, not a pre-built AppConfig object).
  DISCORD_CLIENT_ID: "test-client-id",
  DISCORD_CLIENT_SECRET: "test-client-secret",
  DISCORD_REDIRECT_URI: "http://127.0.0.1/api/auth/callback",
  DASHBOARD_OAUTH_TRANSACTION_SIGNING_KEY: "11".repeat(32),
  DASHBOARD_TOKEN_ENCRYPTION_KEY: "22".repeat(32),
};

describe("apps/api config: SSE numeric env validation (correctness-review defect 7)", () => {
  it("accepts absent SSE_* vars and falls back to the documented defaults", () => {
    const config = loadAppConfig(REQUIRED_DB_ENV);
    expect(config.sse).toEqual({
      heartbeatSeconds: 15,
      pollIntervalMs: 3000,
      maxQueuedFramesPerConnection: 200,
      maxRowsPerSourcePerTick: 500,
    });
  });

  it("accepts a valid, explicit positive integer override for every SSE_* var", () => {
    const config = loadAppConfig({
      ...REQUIRED_DB_ENV,
      SSE_HEARTBEAT_SECONDS: "30",
      SSE_POLL_INTERVAL_MS: "2000",
      SSE_MAX_QUEUED_FRAMES: "50",
      SSE_MAX_ROWS_PER_SOURCE_PER_TICK: "1000",
    });
    expect(config.sse).toEqual({
      heartbeatSeconds: 30,
      pollIntervalMs: 2000,
      maxQueuedFramesPerConnection: 50,
      maxRowsPerSourcePerTick: 1000,
    });
  });

  const invalidValues: Array<{ label: string; raw: string }> = [
    { label: "non-numeric (NaN)", raw: "not-a-number" },
    { label: "zero", raw: "0" },
    { label: "negative", raw: "-1" },
    { label: "fractional", raw: "3.5" },
    { label: "Infinity", raw: "Infinity" },
    { label: "empty string", raw: "" },
  ];

  for (const varName of [
    "SSE_HEARTBEAT_SECONDS",
    "SSE_POLL_INTERVAL_MS",
    "SSE_MAX_QUEUED_FRAMES",
    "SSE_MAX_ROWS_PER_SOURCE_PER_TICK",
  ] as const) {
    describe(varName, () => {
      for (const { label, raw } of invalidValues) {
        it(`rejects a ${label} value ("${raw}") and fails startup with a precise error, never silently falling back to the default`, () => {
          expect(() => loadAppConfig({ ...REQUIRED_DB_ENV, [varName]: raw })).toThrow(
            new RegExp(`Invalid ${varName}`),
          );
        });
      }
    });
  }

  it("positiveIntEnv itself: an empty string is treated as PRESENT-but-invalid, not absent (never silently substitutes the default for a present value)", () => {
    // "" is falsy but !== undefined - `required()` (a different function)
    // treats empty specially for required string vars, but `positiveIntEnv`
    // must not: an explicitly-set empty SSE_* var is a present, invalid
    // value, and must fail loudly rather than quietly becoming the default.
    expect(() => positiveIntEnv({ X: "" }, "X", 15)).toThrow(/Invalid X/);
  });

  it("positiveIntEnv: a genuinely absent var uses the default and never throws", () => {
    expect(positiveIntEnv({}, "X", 42)).toBe(42);
  });
});
