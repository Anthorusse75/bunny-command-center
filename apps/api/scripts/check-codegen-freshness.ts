/**
 * CI freshness gate (ADR-022): regenerates Kysely types against the live
 * schema into a temp file, diffs it against the committed
 * src/db/codegen-types.ts, and fails loudly on any difference - the
 * mechanism this mission's prior audit found repeatedly missing (stale
 * generated artifacts silently trusted).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

const COMMITTED_PATH = path.join(import.meta.dirname, "..", "src", "db", "codegen-types.ts");

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function main(): void {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "kysely-codegen-check-"));
  const tmpFile = path.join(tmpDir, "codegen-types.ts");

  try {
    const host = required("DB_HOST");
    const port = process.env.DB_PORT ?? "3306";
    const user = required("DB_USER");
    const password = required("DB_PASSWORD");
    const database = required("DB_NAME");
    const url = `mysql://${user}:${password}@${host}:${port}/${database}`;

    // See scripts/codegen.ts for why this invokes the resolved JS
    // entrypoint via `node` rather than the npx/npx.cmd launcher.
    const binPath = require.resolve("kysely-codegen/dist/cli/bin.js");
    execFileSync(process.execPath, [binPath, "--dialect", "mysql", "--url", url, "--out-file", tmpFile], {
      stdio: "inherit",
    });

    const committed = readFileSync(COMMITTED_PATH, "utf-8");
    const fresh = readFileSync(tmpFile, "utf-8");

    if (committed !== fresh) {
      console.error(
        `[codegen:check] STALE: ${COMMITTED_PATH} does not match a fresh generation from the live schema.`,
      );
      console.error("[codegen:check] Run 'npm run codegen' in apps/api and commit the result.");
      process.exit(1);
    }

    console.log("[codegen:check] OK - committed codegen-types.ts matches the live schema.");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
