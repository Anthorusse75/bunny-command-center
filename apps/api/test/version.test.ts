import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import type { AppConfig } from "../src/config.js";

const CONFIG: AppConfig = {
  port: 0,
  logLevel: "silent",
  appVersion: "0.1.0-scaffold-test",
  db: { host: "unused-in-this-test", port: 3306, user: "x", password: "x", database: "x" },
};

describe("/api/version", () => {
  it("returns the app version and schema-floor metadata without touching the DB", async () => {
    const app = await buildServer(CONFIG);
    const response = await app.inject({ method: "GET", url: "/api/version" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: "bunny-command-center-api",
      version: "0.1.0-scaffold-test",
      selfBotSchemaMaxAtScaffold: "0014",
      dashboardMigrationLedgerFloor: null,
    });
    await app.close();
  });
});
