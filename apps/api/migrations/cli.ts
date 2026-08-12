#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMigratorDbConfig, loadRunnerEnv, ALLOWED_DOWN_ENVS } from "./config.js";
import { connect, runUp, runDown, runStatus } from "./runner.js";

const MIGRATIONS_DIR = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<number> {
  const [, , command, ...rest] = process.argv;

  if (command === "up") {
    loadRunnerEnv(); // validated for its side effect of failing on garbage values
    const config = loadMigratorDbConfig();
    const forceRetry = rest.includes("--force-retry");
    const conn = await connect(config);
    try {
      const result = await runUp(conn, MIGRATIONS_DIR, config, { forceRetry });
      console.log(result.message);
      if (result.applied.length > 0) console.log(`Applied: ${result.applied.join(", ")}`);
      if (result.skipped.length > 0) console.log(`Already applied (no-op): ${result.skipped.join(", ")}`);
      return result.ok ? 0 : 1;
    } finally {
      await conn.end();
    }
  }

  if (command === "down") {
    const runnerEnv = loadRunnerEnv();
    if (!ALLOWED_DOWN_ENVS.includes(runnerEnv)) {
      console.error(
        `RUNNER_ENV=${runnerEnv} -- down migrations are not a production rollback strategy. ` +
          `Set RUNNER_ENV to one of ${ALLOWED_DOWN_ENVS.join(", ")} to run 'down'.`,
      );
      return 1;
    }
    const config = loadMigratorDbConfig();
    const toIndex = rest.indexOf("--to");
    const toVersion = toIndex >= 0 ? rest[toIndex + 1] : undefined;
    const conn = await connect(config);
    try {
      const result = await runDown(conn, MIGRATIONS_DIR, config, { toVersion });
      console.log(result.message);
      if (result.reverted.length > 0) console.log(`Reverted: ${result.reverted.join(", ")}`);
      return result.ok ? 0 : 1;
    } finally {
      await conn.end();
    }
  }

  if (command === "status") {
    const config = loadMigratorDbConfig();
    const conn = await connect(config);
    try {
      const rows = await runStatus(conn, MIGRATIONS_DIR);
      console.log(`${"VERSION".padEnd(45)} ${"STATE".padEnd(18)} APPLIED_AT`);
      console.log("-".repeat(70));
      for (const row of rows) {
        const appliedAt = row.appliedAt ? row.appliedAt.toISOString() : "";
        console.log(`${row.version.padEnd(45)} ${row.state.padEnd(18)} ${appliedAt}`);
      }
      return 0;
    } finally {
      await conn.end();
    }
  }

  console.error("Usage: tsx migrations/cli.ts <up|down|status> [--force-retry] [--to VERSION]");
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
