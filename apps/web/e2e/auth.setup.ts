// Playwright's standard "authenticate once, reuse everywhere" pattern
// (https://playwright.dev/docs/auth) — Step 04 gates the whole authenticated
// app surface behind `<AuthGate>` (apps/web/src/features/auth/AuthGate.tsx),
// so every EXISTING Step 01/02/03 browser spec (theme-matrix, i18n,
// responsive, accessibility, realtime, mobile-overflow) would otherwise see
// the Login screen instead of the app shell it actually tests.
//
// This "setup" project runs once, hits the E2E-harness-only
// `GET /api/__test__/login` route (apps/api/scripts/e2e-server.ts — never
// present in `src/server.ts`'s real production route set), and saves the
// resulting `bcc_session` cookie into a shared `storageState` file that
// `playwright.config.ts` applies to the `desktop-chromium`/`mobile-chromium`
// projects. This is explicitly NOT proof that real Discord OAuth works
// (see this step's HANDOVER) — it proves the AUTHENTICATED APP SURFACE
// those pre-existing specs test still renders correctly now that a real
// session gate sits in front of it. The actual OAuth/login/error/logout
// flows are exercised for real (no shortcut) in `auth.spec.ts`.
import { test as setup } from "@playwright/test";
import { STORAGE_STATE_PATH } from "./helpers.js";

setup("authenticate via the E2E-only test login route", async ({ page }) => {
  await page.goto("/api/__test__/login");
  await page.context().storageState({ path: STORAGE_STATE_PATH });
});
