// Build sanity gate (correctness-review round 3, "test-only bundle
// hygiene"): fails loudly if any known test-only realtime symbol survives
// into an ORDINARY production `dist/` build. Never runs the strict check
// against the E2E build (`playwright.config.ts`'s `webServer` reuses this
// SAME `npm run build` command with `VITE_ENABLE_REALTIME_TEST_PROBE=true`
// set, where these symbols are INTENTIONALLY present) - detected via the
// same env var `SseProvider.tsx`/`RealtimeTestProbe.tsx` gate on, so this
// script's own pass/skip decision uses the identical signal those files'
// build-time elimination relies on.
//
// A grep-based check, not a purely structural one, deliberately: mission
// §35/§39 requires a positive, falsifiable proof the strings are ABSENT, not
// just a design argument that they should be - this is the "prove it" half
// of the requirement, run automatically on every ordinary build rather than
// something a human has to remember to check manually.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DIST_DIR = path.join(import.meta.dirname, "..", "dist");

/**
 * Every name that must never appear in an ordinary production bundle.
 * Covers the ORIGINAL leaked symbol, its round-3 replacements, and the
 * window-global test seam - not just one string, so a future rename of any
 * of these still gets caught rather than silently passing.
 */
const FORBIDDEN_SYMBOLS = [
  "forceDisconnectForTests",
  "forceDisconnectWithSeededCursor",
  "registerTestOnlyControls",
  "simulateNetworkDropForTests",
  "simulateBackpressureOverflowForTests",
  "__bccE2E",
  "realtime-test-probe",
  "sseTestHooks",
] as const;

function listFilesRecursive(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listFilesRecursive(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

export function runCli(): number {
  if (process.env["VITE_ENABLE_REALTIME_TEST_PROBE"] === "true") {
    console.log(
      "[test-only-symbols] SKIPPED - VITE_ENABLE_REALTIME_TEST_PROBE=true means this is the intentional E2E build, not the normal production one.",
    );
    return 0;
  }

  let dirEntries: string[];
  try {
    dirEntries = listFilesRecursive(DIST_DIR);
  } catch (err) {
    console.error(`[test-only-symbols] FAILED - could not read ${DIST_DIR}: ${String(err)}`);
    return 1;
  }

  const findings: { file: string; symbol: string }[] = [];
  for (const file of dirEntries) {
    const content = readFileSync(file, "utf-8");
    for (const symbol of FORBIDDEN_SYMBOLS) {
      if (content.includes(symbol)) {
        findings.push({ file: path.relative(DIST_DIR, file), symbol });
      }
    }
  }

  if (findings.length > 0) {
    for (const { file, symbol } of findings) {
      console.error(`[test-only-symbols] FAIL: "${symbol}" found in dist/${file}`);
    }
    console.error(
      `[test-only-symbols] FAILED - ${findings.length} test-only symbol occurrence(s) leaked into the normal production bundle. This must be fixed at the source (dead-code-eliminable gating), never suppressed here.`,
    );
    return 1;
  }

  console.log(
    `[test-only-symbols] OK - none of ${FORBIDDEN_SYMBOLS.length} forbidden test-only symbol(s) found in the normal production bundle (${dirEntries.length} file(s) scanned).`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runCli());
}
