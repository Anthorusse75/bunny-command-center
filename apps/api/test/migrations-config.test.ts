import { describe, expect, it } from "vitest";
import { loadRunnerEnv, loadMigratorDbConfig, ALLOWED_DOWN_ENVS } from "../migrations/config.js";

describe("migrations/config", () => {
  it("defaults RUNNER_ENV to PRODUCTION (fail-safe) when unset", () => {
    expect(loadRunnerEnv({})).toBe("PRODUCTION");
  });

  it("rejects an invalid RUNNER_ENV value", () => {
    expect(() => loadRunnerEnv({ RUNNER_ENV: "WHATEVER" })).toThrow(/Invalid RUNNER_ENV/);
  });

  it("PRODUCTION is not in the allowed-for-down set (down is never a production rollback strategy)", () => {
    expect(ALLOWED_DOWN_ENVS).not.toContain("PRODUCTION");
    expect(ALLOWED_DOWN_ENVS).toEqual(["TEST", "LOCAL_DISPOSABLE"]);
  });

  it("loadMigratorDbConfig throws a clear error when required vars are missing", () => {
    expect(() => loadMigratorDbConfig({})).toThrow(/MIGRATOR_DB_HOST/);
  });

  it("loadMigratorDbConfig reads all five required vars", () => {
    const config = loadMigratorDbConfig({
      MIGRATOR_DB_HOST: "127.0.0.1",
      MIGRATOR_DB_PORT: "33070",
      MIGRATOR_DB_USER: "u",
      MIGRATOR_DB_PASSWORD: "p",
      MIGRATOR_DB_NAME: "n",
    });
    expect(config).toEqual({ host: "127.0.0.1", port: 33070, user: "u", password: "p", database: "n" });
  });
});
