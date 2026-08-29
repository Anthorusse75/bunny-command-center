import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import type { AppConfig } from "../src/config.js";
import { testDiscordConfig, testSessionConfig, testSuperadminConfig } from "./helpers/testAuthConfig.js";
import { SUPPORTED_SHARED_SCHEMA_MIN, SUPPORTED_SHARED_SCHEMA_MAX } from "../src/sharedSchemaCompat.js";

const CONFIG: AppConfig = {
  port: 0,
  logLevel: "silent",
  appVersion: "0.1.0-scaffold-test",
  db: { host: "unused-in-this-test", port: 3306, user: "x", password: "x", database: "x" },
  sse: {
    heartbeatSeconds: 15,
    pollIntervalMs: 3000,
    maxQueuedFramesPerConnection: 200,
    maxRowsPerSourcePerTick: 500,
  },
  discord: testDiscordConfig(),
  session: testSessionConfig(),
  superadmin: testSuperadminConfig(),
};

describe("/api/version", () => {
  it("returns the app version and the current supported shared-schema range without touching the DB", async () => {
    const app = await buildServer(CONFIG);
    const response = await app.inject({ method: "GET", url: "/api/version" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: "bunny-command-center-api",
      version: "0.1.0-scaffold-test",
      supportedSharedSchemaMin: SUPPORTED_SHARED_SCHEMA_MIN,
      supportedSharedSchemaMax: SUPPORTED_SHARED_SCHEMA_MAX,
    });
    await app.close();
  });

  // Step 10 post-merge correction: this build genuinely depends on shared
  // migration 0015 (guilds.lifecycle_state et al.) — it must never again
  // silently report a stale schema-0014 compatibility range the way the
  // scaffold-era SELF_BOT_SCHEMA_MAX_AT_SCAFFOLD constant did (it was never
  // bumped when the submodule pin actually moved).
  it("no longer reports the stale scaffold-era schema 0014 as its current supported schema", async () => {
    const app = await buildServer(CONFIG);
    const response = await app.inject({ method: "GET", url: "/api/version" });
    const body = response.json<{ supportedSharedSchemaMin: string; supportedSharedSchemaMax: string }>();
    expect(body.supportedSharedSchemaMin).toBe("0015");
    expect(body.supportedSharedSchemaMax).toBe("0015");
    await app.close();
  });
});
