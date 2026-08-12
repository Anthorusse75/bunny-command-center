import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Migration-runner and health-endpoint tests hit a real MySQL instance
    // (00_GLOBAL_IMPLEMENTATION_RULES.md: mocked-DB "integration" tests are
    // a rejection-criteria failure) - DDL/connection round-trips are slower
    // than the 5s default.
    testTimeout: 20000,
    hookTimeout: 20000,
    // Defense-in-depth: the build script (tsc -p tsconfig.build.json)
    // only ever emits src/ under dist/, but make it explicit that compiled
    // output must never be picked up as test files, regardless.
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
