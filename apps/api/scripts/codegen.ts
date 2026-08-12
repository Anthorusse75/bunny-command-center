/**
 * Thin cross-platform wrapper around kysely-codegen's CLI. Building the
 * connection URL from DB_* env vars in the package.json script string
 * itself doesn't work portably ($VAR is bash-only; Windows npm scripts run
 * through cmd.exe by default), so this does it in Node instead.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function main(): void {
  const host = required("DB_HOST");
  const port = process.env.DB_PORT ?? "3306";
  const user = required("DB_USER");
  const password = required("DB_PASSWORD");
  const database = required("DB_NAME");
  const url = `mysql://${user}:${password}@${host}:${port}/${database}`;

  // Resolve kysely-codegen's own JS entrypoint and invoke it via `node`
  // directly, rather than going through the `npx`/`npx.cmd` launcher -
  // spawning .cmd files without shell:true fails with EINVAL on Windows,
  // and shell:true would require manually escaping a URL that embeds a
  // password. This sidesteps both.
  const require = createRequire(import.meta.url);
  const binPath = require.resolve("kysely-codegen/dist/cli/bin.js");
  execFileSync(
    process.execPath,
    [binPath, "--dialect", "mysql", "--url", url, "--out-file", "src/db/codegen-types.ts"],
    { stdio: "inherit" },
  );
}

main();
