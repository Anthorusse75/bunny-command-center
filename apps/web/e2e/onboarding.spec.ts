/**
 * Real-browser proof of Step 10's full onboarding -> request-activation ->
 * Superadmin review -> approve -> live SSE -> ACTIVE flow (the external
 * review's explicit acceptance criterion this branch was missing).
 *
 * Every step drives the REAL chain: real browser -> real onboarding API
 * (`apps/api/src/lifecycle/routes.ts`) -> real MySQL (`guilds`,
 * `guild_configuration_versions`/sub-tables, `dashboard_guild_activation_requests`,
 * `dashboard_guild_notification_defaults`) -> a real local Bunny internal-API
 * test double (`apps/api/scripts/e2e-server.ts`'s Phase-3 addition) for the
 * live channel/role pickers -> the real `guild_lifecycle.state_changed` SSE
 * source (`apps/api/src/lifecycle/lifecycleSseAdapter.ts`) -> the real
 * frontend subscription (`apps/web/src/features/onboarding/realtimeWiring.ts`,
 * also added this phase). No mocked API layer.
 *
 * Two actors, two independent browser contexts (mirrors
 * `multi-guild.spec.ts`'s "fixed test-double Superadmin ID" pattern and
 * `realtime.spec.ts`'s `browser.newContext()` multi-tab pattern) — the Guild
 * Admin's page is kept open across the whole test so the final SSE-driven
 * transition to ACTIVE can be observed live, with no `page.reload()`
 * anywhere in that assertion.
 */
import { expect, test } from "@playwright/test";
import mysql from "mysql2/promise";
import { loadCatalog } from "./helpers.js";
import { guildId, loginAs, seedGuild, freshDiscordUserId } from "./multiGuildHelpers.js";

// Matches realtime.spec.ts's own established direct-DB-assertion convention
// exactly (same E2E database, same app-tier credentials).
const DB_CONFIG = {
  host: process.env["TEST_MYSQL_HOST"] ?? "127.0.0.1",
  port: Number(process.env["TEST_MYSQL_PORT"] ?? 33070),
  user: "bunny_dashboard_app",
  password: "app_pass",
  database: "bunny_cc_e2e",
};

const CSRF_HEADERS = { "x-requested-with": "BunnyCommandCenter" };
// Well within the Bunny test double's default synthetic catalog
// ("500000000000000NNN" channels / "600000000000000NNN" roles, all granted
// full permissions) — see apps/api/test/helpers/bunnyInternalApiTestDouble.ts.
const INCOMING_CHANNEL_ID = "500000000000000001";
const HERO_CHANNEL_ID = "500000000000000002";

async function selectMuiOption(page: import("@playwright/test").Page, testId: string, optionName: string) {
  const picker = page.getByTestId(testId);
  await expect(picker).toBeEnabled({ timeout: 10_000 });
  await picker.click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
}

/**
 * `page.request.*` deliberately NOT used for authenticated raw-HTTP proofs
 * in this spec: the real session cookie is `Secure` (unconditionally, in
 * both the real login route and this E2E harness's test-only one — neither
 * ever weakens this for any environment). Chromium treats `127.0.0.1` as a
 * "potentially trustworthy origin" and sends `Secure` cookies over plain
 * HTTP there for requests it makes itself, but Playwright's separate
 * `APIRequestContext` (`page.request`) does not apply that same browser-only
 * exception — a raw `page.request.post/get` call silently arrives
 * unauthenticated. Running the fetch INSIDE the real page via
 * `page.evaluate` uses the actual browser network stack instead, exactly
 * like every other authenticated call in this spec.
 */
async function browserFetch(
  page: import("@playwright/test").Page,
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
): Promise<{ status: number; body: string }> {
  return page.evaluate(
    async ({ url, init }) => {
      const res = await fetch(url, init);
      return { status: res.status, body: await res.text() };
    },
    { url, init },
  );
}

test.describe("Step 10 — full onboarding, request-activation, Superadmin review, live approval (E2E)", () => {
  test("Guild Admin completes onboarding non-sequentially, requests activation, Superadmin reviews the exact submitted snapshot and approves, Guild Admin's open page reaches ACTIVE via live SSE with no reload", async ({
    page,
    browser,
  }) => {
    const en = loadCatalog("en");
    const gA = guildId();
    // Seeded and included in this SAME Guild Admin's own guild membership
    // list up front (never onboarded) — used later for the server-side
    // checklist-bypass proof. Deliberately a guild the caller genuinely
    // belongs to, so that proof exercises the CHECKLIST rejection
    // specifically, never a membership/IDOR 403 that would prove nothing
    // about the checklist gate itself.
    const gBypass = guildId();
    await seedGuild(page, gA, "Onboarding E2E Guild");
    await seedGuild(page, gBypass, "Bypass Attempt Guild");
    await loginAs(page, freshDiscordUserId(), [
      { id: gA, owner: true, permissions: "0", name: "Onboarding E2E Guild" },
      { id: gBypass, owner: true, permissions: "0", name: "Bypass Attempt Guild" },
    ]);

    await page.goto(`/guild/${gA}/onboarding`);
    await expect(page.getByTestId("app-shell")).toBeVisible();
    // The global realtime test probe (App.tsx, gated the same way as
    // realtime.spec.ts's own) — confirms the real SSE transport is LIVE on
    // this page before proceeding, matching that spec's own established
    // wait pattern, rather than assuming connection is instant.
    await expect(page.getByTestId("realtime-test-probe")).toHaveAttribute("data-transport-state", "LIVE", {
      timeout: 20_000,
    });

    // 7-section non-wizard layout — every section label reachable.
    for (const key of [
      "bunnyPermissions",
      "incomingChannel",
      "heroChannel",
      "communityChannel",
      "seasonQuotas",
      "notifications",
      "adminRolePolicy",
    ] as const) {
      await expect(page.getByRole("heading", { name: en.onboarding.sections[key]!.title })).toBeVisible();
    }

    // Jump directly to a NON-FIRST section (Season & Quotas) before touching
    // Incoming/Hero — proves there is no forced sequential wizard gate. The
    // checklist nav item is a real MUI ListItemButton (role="button"),
    // labelled with the section title — no dedicated jump testid exists.
    await page
      .getByRole("navigation", { name: en.onboarding.checklist.heading })
      .getByRole("button", { name: en.onboarding.sections.seasonQuotas.title })
      .click();
    await expect(page.getByLabel(en.onboarding.sections.seasonQuotas.acceptDefaults)).toBeVisible({
      timeout: 5000,
    });

    // Season & Quotas: uncheck "accept platform defaults", set one explicit
    // override — exercises the real 5-value numeric quota model (Phase 1),
    // not the old fake category-string model.
    await page.getByLabel(en.onboarding.sections.seasonQuotas.acceptDefaults).uncheck();
    const gcHeroField = page.getByLabel("gcHero");
    await gcHeroField.fill("1000");
    await gcHeroField.blur();

    // Notifications: real dashboard_guild_notification_defaults write.
    await page.getByLabel(en.onboarding.sections.notifications.inApp).click();

    // Incoming / Hero channel: real live pickers backed by the Bunny test
    // double (Phase 2) — no plain text input, exact snowflake ids.
    await selectMuiOption(page, "incomingChannel-picker", "#test-channel-1");
    await selectMuiOption(page, "heroChannel-picker", "#test-channel-2");

    // Admin role policy: real role dropdown (Phase 2), Owner-only to change
    // — this session IS the Owner (seeded above), so this must succeed.
    await selectMuiOption(page, "adminRolePolicy-picker", "@test-role-1");

    // Bunny & permissions is now a LIVE, derived checklist (Phase 2) — no
    // attestation checkbox exists any more. With the incoming channel above
    // granted full permissions by the test double's default fixture, it
    // must show complete without any user action.
    await expect(page.getByTestId("bunnyPermissions-check-incoming-viewChannel")).toHaveAttribute(
      "data-pass",
      "true",
    );

    // Server-side minimum checklist (incoming + hero + a saved quota
    // section) is now genuinely satisfied — Request Activation must become
    // enabled without a page reload.
    const requestActivationButton = page.getByRole("button", {
      name: en.onboarding.actions.requestActivation,
    });
    await expect(requestActivationButton).toBeEnabled({ timeout: 10_000 });

    const [activationResponse] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes("/request-activation") && res.request().method() === "POST",
      ),
      requestActivationButton.click(),
    ]);
    expect(activationResponse.ok()).toBe(true);
    const activationBody = (await activationResponse.json()) as {
      data: { requestId: string; lifecycleState: string };
    };
    const { requestId } = activationBody.data;
    expect(requestId).toBeTruthy();
    expect(activationBody.data.lifecycleState).toBe("PENDING_APPROVAL");

    // Marketing-quality Pending screen — never a 403-lookalike.
    await expect(page.getByRole("heading", { name: en.onboarding.pending.title })).toBeVisible();
    await expect(page.getByText(en.onboarding.pending.unlocks.bulkUpload!, { exact: false })).toBeVisible();

    // --- Server-side checklist-bypass proof (separate guild the same admin
    // genuinely belongs to but never onboarded, raw HTTP) ---
    const bypassRes = await browserFetch(page, `/api/guilds/${gBypass}/request-activation`, {
      method: "POST",
      headers: CSRF_HEADERS,
    });
    expect(bypassRes.status).toBeGreaterThanOrEqual(400);
    expect(bypassRes.status).toBeLessThan(500);
    const bypassBody = JSON.parse(bypassRes.body) as { error_code: string };
    expect(bypassBody.error_code).toBe("CHECKLIST_NOT_PASSED");

    // --- Superadmin reviews the EXACT real requestId, in a SEPARATE browser
    // context (a genuinely different session/identity, not just a second
    // tab sharing cookies) ---
    const superadminContext = await browser.newContext();
    try {
      const superadminPage = await superadminContext.newPage();
      await loginAs(superadminPage, "900000000000000001", []);
      await superadminPage.goto(`/admin/platform/guilds/${gA}/review/${requestId}`);

      await expect(superadminPage.getByRole("heading", { name: en.superadmin.review.title })).toBeVisible();
      // guildId-mismatch guard must NOT fire on the happy path.
      await expect(superadminPage.getByTestId("guild-mismatch-error")).not.toBeVisible();
      // Never the full Step-11 console — no pending-list affordance exists.
      await expect(superadminPage.getByTestId("already-decided")).not.toBeVisible();

      // The displayed snapshot matches exactly what was submitted.
      await expect(superadminPage.getByText(INCOMING_CHANNEL_ID)).toBeVisible();
      await expect(superadminPage.getByText(HERO_CHANNEL_ID)).toBeVisible();
      await expect(superadminPage.getByText(/1000/)).toBeVisible();

      const [approveResponse] = await Promise.all([
        superadminPage.waitForResponse(
          (res) =>
            res.url().includes(`/activation-requests/${requestId}/approve`) &&
            res.request().method() === "POST",
        ),
        superadminPage.getByRole("button", { name: en.superadmin.review.actions.approve }).click(),
      ]);
      expect(approveResponse.ok()).toBe(true);
    } finally {
      await superadminContext.close();
    }

    // --- Back on the Guild Admin's ORIGINAL, still-open page: the real SSE
    // push (no reload anywhere in this block) drives the UI to ACTIVE. ---
    await expect(page.getByRole("button", { name: en.onboarding.actions.pause })).toBeVisible({
      timeout: 10_000,
    });

    // --- DB readback: enabled/lifecycle_state/active_config_version_id all
    // reflect exactly what was reviewed and approved. ---
    const stateRes = await browserFetch(page, `/api/guilds/${gA}/onboarding`);
    const stateBody = JSON.parse(stateRes.body) as { data: { lifecycleState: string } };
    expect(stateBody.data.lifecycleState).toBe("ACTIVE");

    const pool = mysql.createPool(DB_CONFIG);
    try {
      const [guildRows] = await pool.query<mysql.RowDataPacket[]>(
        "SELECT lifecycle_state, enabled, active_config_version_id FROM guilds WHERE guild_id = ?",
        [gA],
      );
      const guildRow = guildRows[0] as
        { lifecycle_state: string; enabled: number; active_config_version_id: number } | undefined;
      expect(guildRow?.lifecycle_state).toBe("ACTIVE");
      expect(guildRow?.enabled).toBe(1);

      const [requestRows] = await pool.query<mysql.RowDataPacket[]>(
        "SELECT submitted_config_version_id, state FROM dashboard_guild_activation_requests WHERE request_id = ?",
        [requestId],
      );
      const requestRow = requestRows[0] as { submitted_config_version_id: number; state: string } | undefined;
      expect(requestRow?.state).toBe("APPROVED");
      // The exact reviewed/approved snapshot version — never merely "some"
      // active version — is what the guild's real pointer now references.
      expect(guildRow?.active_config_version_id).toBe(requestRow?.submitted_config_version_id);
    } finally {
      await pool.end();
    }
  });
});
