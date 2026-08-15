// Playwright configuration for the Step-02 browser suite.
//
// 31_TEST_STRATEGY.md assigns E2E/browser/mobile-viewport/accessibility work to Playwright
// (`@axe-core/playwright`), and 02_design_system_i18n.md §PROOF OF WIRING requires the app shell
// to actually be loaded "in a browser at each of the 9 theme x mode combinations and at both
// breakpoints". jsdom cannot substitute: it has no layout engine, so it cannot detect horizontal
// overflow, cannot resolve a CSS variable through a real cascade, and cannot emulate
// `prefers-color-scheme` at the engine level.
//
// It runs against the PRODUCTION build (`vite preview`), not the dev server, so what is tested
// is the artefact that ships - including the generated pre-paint script inlined by the Vite
// plugin.

import { defineConfig, devices } from "@playwright/test";

const PORT = 4317;

// 03_realtime_infrastructure.md's real-browser E2E suite needs a REAL,
// listening apps/api process behind /api/stream (mission §36: "at least one
// E2E chain must be: real browser -> real HTTP EventSource -> real Fastify
// SSE handler -> real realtime source/hub -> browser listener -> real
// QueryClient reaction"). This API_PORT is where apps/api/scripts/e2e-server.ts
// listens; vite.config.ts's preview/dev proxy (E2E_API_PROXY_TARGET, set
// below) forwards `/api/*` there so the built SPA and the API are reachable
// same-origin from the browser, matching production's real topology
// (ADR-017).
const API_PORT = 18734;
const E2E_DB_NAME = "bunny_cc_e2e";
const MYSQL_HOST = process.env["TEST_MYSQL_HOST"] ?? "127.0.0.1";
const MYSQL_PORT = process.env["TEST_MYSQL_PORT"] ?? "33070";
const MYSQL_ROOT_PASSWORD = process.env["TEST_MYSQL_ROOT_PASSWORD"] ?? "devrootpass";
const APP_DB_USER = "bunny_dashboard_app";
const APP_DB_PASSWORD = "app_pass";
const MIGRATOR_DB_USER = "bunny_dashboard_migrator";
const MIGRATOR_DB_PASSWORD = "migrator_pass";

export default defineConfig({
  testDir: "./e2e",
  // Nothing here is timing-sensitive, but a cold `vite preview` start plus first paint on a
  // loaded machine can exceed Playwright's 30s default.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  workers: 1,
  reporter: process.env["CI"] ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      // Desktop: >= 960px, so the sidebar layout.
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
    },
    {
      // Mobile: a real device profile (touch, DPR, UA), so the bottom-nav layout and the
      // tap-only tooltip path are exercised the way 31_TEST_STRATEGY.md's "Mobile" row asks.
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"] },
    },
  ],
  webServer: [
    {
      // Two steps chained: (1) create the disposable E2E database + accounts
      // with root (apps/api/scripts/e2e-db-setup.ts - NOT a Playwright
      // `globalSetup` hook, which runs too late: Playwright starts
      // `webServer`s before running `globalSetup`, which would race this
      // exact setup), then (2) the REAL apps/api server (real Fastify SSE
      // route, real poller, real MySQL) - see
      // apps/api/scripts/e2e-server.ts for exactly what test-only seam it
      // adds (a synthetic source adapter, never a debug HTTP route).
      command: "npm --prefix ../api run e2e-db-setup && npm --prefix ../api run e2e-server",
      url: `http://127.0.0.1:${API_PORT}/healthz`,
      reuseExistingServer: !process.env["CI"],
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PORT: String(API_PORT),
        DB_HOST: MYSQL_HOST,
        DB_PORT: MYSQL_PORT,
        DB_USER: APP_DB_USER,
        DB_PASSWORD: APP_DB_PASSWORD,
        DB_NAME: E2E_DB_NAME,
        MIGRATOR_DB_HOST: MYSQL_HOST,
        MIGRATOR_DB_PORT: MYSQL_PORT,
        MIGRATOR_DB_USER: MIGRATOR_DB_USER,
        MIGRATOR_DB_PASSWORD: MIGRATOR_DB_PASSWORD,
        MIGRATOR_DB_NAME: E2E_DB_NAME,
        LOG_LEVEL: "warn",
        E2E_MYSQL_ROOT_HOST: MYSQL_HOST,
        E2E_MYSQL_ROOT_PORT: MYSQL_PORT,
        E2E_MYSQL_ROOT_PASSWORD: MYSQL_ROOT_PASSWORD,
        E2E_DB_NAME,
        E2E_APP_DB_USER: APP_DB_USER,
        E2E_APP_DB_PASSWORD: APP_DB_PASSWORD,
        E2E_MIGRATOR_DB_USER: MIGRATOR_DB_USER,
        E2E_MIGRATOR_DB_PASSWORD: MIGRATOR_DB_PASSWORD,
      },
    },
    {
      // `--host 127.0.0.1` is not optional: `vite preview` otherwise binds to `localhost`, which on
      // Windows resolves to ::1 first, and Playwright's readiness probe against 127.0.0.1 never
      // connects - the server starts, the run times out, and the log looks like a slow build.
      command: `npm run build && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
      url: `http://127.0.0.1:${PORT}`,
      reuseExistingServer: !process.env["CI"],
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        // Build-time constants (see vite.config.ts / RealtimeTestProbe.tsx) -
        // only ever set here, for this E2E build, never for the real
        // production build command (`npm run build` alone, from the repo
        // root or CI).
        E2E_API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}`,
        VITE_ENABLE_REALTIME_TEST_PROBE: "true",
      },
    },
  ],
});
