#!/usr/bin/env node
/**
 * Permanent CI/runtime smoke gate (Step 04 correction 2): proves the
 * COMPILED production artifact (`dist/server.js`, built by `npm run build`)
 * actually boots under plain Node — not `tsx`, not `.inject()`, not a
 * typecheck. `apps/api/package.json`'s own "start" script
 * (`node --conditions=bcc-compiled-runtime dist/server.js`) is exactly what
 * this spawns, so a regression in either the build output or the
 * `@bunny-command-center/shared` package-resolution scheme
 * (packages/shared/package.json's "exports" map,
 * packages/shared/src/index.ts's own doc comment) fails THIS gate, not just
 * a passing-tests-only claim.
 *
 * Deliberately plain JavaScript (`.mjs`), not TypeScript run through `tsx` —
 * the whole point is to prove the artifact works without any dev-time
 * transpilation tool in the loop, on either side of this script.
 *
 * Proves, in order: build -> launch the compiled server -> real /healthz
 * 200 -> real /readyz 200 (requires the real MySQL connection + BOTH
 * migration ledgers this script's caller is responsible for having ready —
 * the Dashboard's own AND, since Step 10, the SHARED `schema_migrations`
 * ledger within sharedSchemaCompat.ts's supported range — matching the
 * existing CI convention: DB_* env vars, ci.yml's already-migrated
 * `bunny_command_center` database) -> a real /api/version response proving
 * the current supported shared-schema range -> SIGTERM -> clean exit (code
 * 0, within a bounded timeout).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.SMOKE_TEST_PORT ?? 8199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const READY_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `smoke-test-compiled-server: missing required environment variable ${name}. ` +
        "This script needs the SAME DB_*/DISCORD_*/DASHBOARD_* config the real 'npm start' " +
        "needs — see apps/api/.env.example.",
    );
  }
  return value;
}

async function waitForHealthy(deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/healthz`);
      if (response.status === 200) {
        return;
      }
      lastError = new Error(`/healthz returned ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server never became healthy within ${deadlineMs}ms: ${lastError}`);
}

async function main() {
  // Fails fast and loudly if the caller forgot required config, rather than
  // spawning a server that will silently fail its own startup.
  for (const name of [
    "DB_HOST",
    "DB_USER",
    "DB_PASSWORD",
    "DB_NAME",
    "DISCORD_CLIENT_ID",
    "DISCORD_CLIENT_SECRET",
    "DISCORD_REDIRECT_URI",
    "DASHBOARD_OAUTH_TRANSACTION_SIGNING_KEY",
    "DASHBOARD_TOKEN_ENCRYPTION_KEY",
    // Step 05 (ADR-008): loadAppConfig() now also requires this
    // unconditionally -- without it, the spawned server below would crash
    // at startup and this script would only ever report a vague 20s
    // /healthz timeout, not the real cause. Pre-checked here for the same
    // fail-fast-and-loudly reason as every other entry in this list.
    "PLATFORM_SUPERADMIN_DISCORD_ID",
  ]) {
    requiredEnv(name);
  }

  // Spawns the exact command `apps/api/package.json`'s "start" script runs
  // (`node --conditions=bcc-compiled-runtime dist/server.js`) directly via
  // `process.execPath`, rather than shelling out through `npm run start` —
  // `npm`/`npm.cmd` spawned without `shell: true` fails with EINVAL on
  // Windows (the same class of pitfall this repo's own `codegen.ts`
  // documents for `npx`/`npx.cmd`), and this is both more precise ("plain
  // Node", not "plain Node via npm's own child process") and portable.
  console.log("[smoke-test] spawning the COMPILED server via plain node (no tsx, no npm wrapper)...");
  const child = spawn(
    process.execPath,
    ["--conditions=bcc-compiled-runtime", path.join(API_ROOT, "dist", "server.js")],
    {
      cwd: API_ROOT,
      env: { ...process.env, PORT: String(PORT), LOG_LEVEL: "info" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

  let childExited = false;
  let childExitCode = null;
  child.on("exit", (code) => {
    childExited = true;
    childExitCode = code;
  });

  try {
    await waitForHealthy(READY_TIMEOUT_MS);
    console.log("[smoke-test] /healthz OK — the compiled server booted under plain Node.");

    const readyResponse = await fetch(`${BASE_URL}/readyz`);
    if (readyResponse.status !== 200) {
      throw new Error(
        `/readyz returned ${readyResponse.status} (expected 200 — real MySQL + Dashboard ` +
          `migration ledger must already be reachable/applied): ${JSON.stringify(await readyResponse.json())}`,
      );
    }
    console.log(
      "[smoke-test] /readyz OK — real MySQL reachable, Dashboard migration ledger clean, " +
        "SHARED schema_migrations within the supported range.",
    );

    const versionResponse = await fetch(`${BASE_URL}/api/version`);
    if (versionResponse.status !== 200) {
      throw new Error(`/api/version returned ${versionResponse.status}`);
    }
    const versionBody = await versionResponse.json();
    if (!versionBody.service || !versionBody.version) {
      throw new Error(`/api/version returned an unexpected body: ${JSON.stringify(versionBody)}`);
    }
    // Step 10 post-merge correction: this compiled build must report the
    // CURRENT supported shared-schema range (apps/api/src/sharedSchemaCompat.ts),
    // never the stale scaffold-era "0014" the endpoint used to hardcode
    // regardless of what the submodule pin actually was.
    if (versionBody.supportedSharedSchemaMin !== "0015" || versionBody.supportedSharedSchemaMax !== "0015") {
      throw new Error(
        `/api/version reported an unexpected shared-schema compatibility range (expected 0015..0015): ` +
          `${JSON.stringify(versionBody)}`,
      );
    }
    console.log(`[smoke-test] /api/version OK — ${JSON.stringify(versionBody)}`);

    // A real Discord-OAuth-shaped route, proving the auth module itself
    // (Step 04's own subject) is wired in the compiled artifact too, not
    // just health/version.
    const loginResponse = await fetch(`${BASE_URL}/api/auth/login`, { redirect: "manual" });
    if (loginResponse.status !== 302 || !loginResponse.headers.get("location")?.includes("discord.com")) {
      throw new Error(
        `/api/auth/login did not behave like a real login redirect: status=${loginResponse.status} ` +
          `location=${loginResponse.headers.get("location")}`,
      );
    }
    console.log("[smoke-test] /api/auth/login OK — real 302 to Discord's authorize endpoint.");
  } finally {
    if (!childExited) {
      console.log("[smoke-test] sending SIGTERM, expecting a clean graceful shutdown...");
      child.kill("SIGTERM");
      const shutdownDeadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
      while (!childExited && Date.now() < shutdownDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  if (!childExited) {
    child.kill("SIGKILL");
    throw new Error(`Server did not exit within ${SHUTDOWN_TIMEOUT_MS}ms of SIGTERM — not a clean shutdown.`);
  }

  if (childExitCode !== 0) {
    // KNOWN, DOCUMENTED Windows platform limitation, not a bug in
    // apps/api/src/server.ts's shutdown handler: Node's own docs state that
    // on Windows, `ChildProcess.kill('SIGTERM')` (and 'SIGINT') do NOT
    // deliver a catchable signal at all — they unconditionally force-
    // terminate the process (exit code `null`, no `SIGTERM` handler ever
    // runs), unlike real POSIX SIGTERM delivery. This gate's actual CI
    // enforcement runs on `ubuntu-latest` (a real POSIX runner, see
    // .github/workflows/ci.yml), where this exact assertion IS strict and
    // WILL catch a real graceful-shutdown regression. Locally on Windows,
    // the functional checks above (healthz/readyz/version/the real
    // /api/auth/login redirect) already proved the compiled artifact boots
    // and serves correctly under plain Node — the one thing this narrow
    // platform gap cannot locally re-verify is the clean-exit-code half of
    // the shutdown path specifically, which is why this is a clearly
    // logged, disclosed accommodation, never a silent skip.
    if (process.platform === "win32") {
      console.warn(
        "[smoke-test] WARNING: skipping the strict clean-shutdown exit-code assertion on Windows " +
          `(Node cannot deliver a real SIGTERM here — child exited via forced termination, code=${childExitCode}). ` +
          "This assertion IS strict and enforced on the real CI runner (ubuntu-latest).",
      );
    } else {
      console.error("--- server stdout ---\n" + stdout);
      console.error("--- server stderr ---\n" + stderr);
      throw new Error(`Server exited with code ${childExitCode} (expected 0 — a clean shutdown).`);
    }
  } else {
    console.log("[smoke-test] Server exited cleanly (code 0) after SIGTERM.");
  }

  console.log("[smoke-test] ALL CHECKS PASSED.");
}

main().catch((err) => {
  console.error("[smoke-test] FAILED:", err);
  process.exit(1);
});
