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
  webServer: {
    // `--host 127.0.0.1` is not optional: `vite preview` otherwise binds to `localhost`, which on
    // Windows resolves to ::1 first, and Playwright's readiness probe against 127.0.0.1 never
    // connects - the server starts, the run times out, and the log looks like a slow build.
    command: `npm run build && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env["CI"],
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
