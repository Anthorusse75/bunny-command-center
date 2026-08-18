/**
 * Real-browser proof of Step 06's multi-guild model & navigation shell
 * (IMPLEMENTATION/06_multi_guild_navigation.md §TESTS REQUIRED "E2E", this
 * step's PROOF OF WIRING section). Desktop viewport — the sidebar/breadcrumb
 * surface (`multi-guild-chromium` project, playwright.config.ts). Mobile-only
 * behavior (bottom nav, guild picker sheet) lives in
 * `multi-guild-mobile.spec.ts`.
 *
 * Every test drives the REAL chain: real browser -> real
 * `GET /api/users/me/guilds` / `GET /api/guilds/:guildId` -> the real
 * `requireTier`-guarded route (apps/api/src/guilds/routes.ts) -> a real
 * local Discord OAuth test double (apps/api/scripts/e2e-server.ts's Step 06
 * addition) -> real MySQL (`guilds` shared table for bot presence,
 * `dashboard_user_guild_preferences` for favorites). The test-only
 * `/api/__test__/login?discordUserId=&guilds=` route only ever substitutes
 * the Discord OAuth CONSENT SCREEN itself (same scope as the pre-existing
 * Step-04 `auth.setup.ts` shortcut) — everything downstream of "the browser
 * has a session cookie" is the real production code path.
 *
 * This spec does NOT use the shared pre-authenticated `storageState`
 * (playwright.config.ts's `setup` project) — every test logs in itself with
 * its own guild fixture, so guild lists never leak between tests.
 */
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { loadCatalog } from "./helpers.js";
import { guildId, loginAs, seedGuild, freshDiscordUserId } from "./multiGuildHelpers.js";

const WCAG_AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test.describe("Multi-guild model — real browser (desktop)", () => {
  test("direct deep-link load of /guild/:guildId re-authorizes for real (not trusting prior client state)", async ({
    page,
  }) => {
    const gA = guildId();
    await seedGuild(page, gA, "Alpha Guild");
    await loginAs(page, freshDiscordUserId(), [
      { id: gA, owner: true, permissions: "0", name: "Alpha Guild" },
    ]);

    await page.goto(`/guild/${gA}`);
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Alpha Guild");
  });

  test("unauthorized guild URL never leaks another guild's data — renders the 'no longer accessible' state, not the overview", async ({
    page,
  }) => {
    const gA = guildId();
    const gB = guildId();
    await seedGuild(page, gA, "Member Guild");
    await seedGuild(page, gB, "Forbidden Guild");
    await loginAs(page, freshDiscordUserId(), [
      { id: gA, owner: false, permissions: "0", name: "Member Guild" },
    ]);

    await page.goto(`/guild/${gB}`);
    const en = loadCatalog("en");
    await expect(
      page.getByRole("heading", { level: 1, name: en.errors.guildNotAccessible.title }),
    ).toBeVisible();
    await expect(page.getByText("Forbidden Guild")).not.toBeVisible();
  });

  test("navigation between screens happens with no full page reload", async ({ page }) => {
    const gA = guildId();
    await seedGuild(page, gA, "Alpha Guild");
    await loginAs(page, freshDiscordUserId(), [
      { id: gA, owner: false, permissions: "0", name: "Alpha Guild" },
    ]);
    await page.goto("/");
    await expect(page.getByTestId("app-shell")).toBeVisible();

    // A marker on `window` is the robust way to prove "no full reload": a
    // real page reload always creates a brand-new JS realm, wiping any
    // property set on `window` — a client-side (React Router / History API)
    // navigation never does. `page.on('framenavigated')` was tried first
    // and rejected here — Chromium's CDP `Page.frameNavigated` event ALSO
    // fires for same-document History API navigations, so counting it
    // cannot actually distinguish a real reload from a client-side route
    // change (confirmed empirically against this exact app).
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>)["__e2eNoReloadMarker__"] = true;
    });
    await page.getByTestId("sidebar-item-upload").click();
    await expect(page).toHaveURL(/\/upload$/);
    const markerSurvived = await page.evaluate(
      () => (window as unknown as Record<string, unknown>)["__e2eNoReloadMarker__"] === true,
    );
    expect(markerSurvived).toBe(true);
  });

  test("desktop guild switcher: guild A -> guild B preserves the current screen (leaderboard), never bounces to Home", async ({
    page,
  }) => {
    const gA = guildId();
    const gB = guildId();
    await seedGuild(page, gA, "Alpha Guild");
    await seedGuild(page, gB, "Bravo Guild");
    await loginAs(page, freshDiscordUserId(), [
      { id: gA, owner: false, permissions: "0", name: "Alpha Guild" },
      { id: gB, owner: false, permissions: "0", name: "Bravo Guild" },
    ]);

    await page.goto(`/guild/${gA}/leaderboard`);
    await expect(page.getByTestId("app-shell")).toBeVisible();

    await page.getByTestId("guild-switcher-trigger").click();
    await page.getByTestId(`guild-option-${gB}`).click();

    await expect(page).toHaveURL(new RegExp(`/guild/${gB}/leaderboard$`));
  });

  test("route-change focus management: navigating to a new screen moves focus to its heading", async ({
    page,
  }) => {
    const gA = guildId();
    await seedGuild(page, gA, "Alpha Guild");
    await loginAs(page, freshDiscordUserId(), [
      { id: gA, owner: false, permissions: "0", name: "Alpha Guild" },
    ]);
    await page.goto("/");
    await expect(page.getByTestId("app-shell")).toBeVisible();

    await page.getByTestId("sidebar-item-upload").click();
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toBeFocused();
  });

  test("zero-guild state (SCREENS/HOME.md) renders for a real freshly-logged-in user with no guilds", async ({
    page,
  }) => {
    await loginAs(page, freshDiscordUserId(), []);
    await page.goto("/");
    await expect(page.getByTestId("zero-guild-state")).toBeVisible();
  });

  test("axe-core: guild overview screen has no violations", async ({ page }) => {
    const gA = guildId();
    await seedGuild(page, gA, "Alpha Guild");
    await loginAs(page, freshDiscordUserId(), [
      { id: gA, owner: false, permissions: "0", name: "Alpha Guild" },
    ]);
    await page.goto(`/guild/${gA}`);
    await expect(page.getByTestId("app-shell")).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(WCAG_AA_TAGS).analyze();
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });

  test('axe-core: the OPEN desktop guild switcher has no violations (regression coverage — this exact surface previously nested a real IconButton inside a role="menuitem" row, an axe "nested-interactive" defect no prior test caught because nothing scanned it OPEN)', async ({
    page,
  }) => {
    const gA = guildId();
    const gB = guildId();
    await seedGuild(page, gA, "Alpha Guild");
    await seedGuild(page, gB, "Bravo Guild");
    await loginAs(page, freshDiscordUserId(), [
      { id: gA, owner: false, permissions: "0", name: "Alpha Guild" },
      { id: gB, owner: false, permissions: "0", name: "Bravo Guild" },
    ]);
    // 28_ACCESSIBILITY.md §Reduced motion clamps every transition to 0.01ms
    // (createBccTheme.ts) — emulating it here (same pattern as
    // accessibility.spec.ts's "reduced motion" suite) makes the Popover's
    // entrance transition resolve before the next paint instead of leaving a
    // real but transient low-opacity frame for axe-core to catch. Without
    // this, `color-contrast` was flaky (~intermittent): a real render state
    // that exists for a few animation frames, not a permanent app defect,
    // but still worth eliminating rather than tolerating as test flakiness.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/guild/${gA}`);
    await expect(page.getByTestId("app-shell")).toBeVisible();

    await page.getByTestId("guild-switcher-trigger").click();
    await expect(page.getByTestId(`guild-option-${gB}`)).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(WCAG_AA_TAGS).analyze();
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });

  // -------------------------------------------------------------------
  // EXTERNAL REVIEW FINDING 1 (BLOCKING) — Guild-Admin-only placeholder
  // routes (onboarding/admin/technical) were reachable by any USER-tier
  // member via direct URL, contradicting their documented
  // 03_INFORMATION_ARCHITECTURE.md semantics. `RequireGuildAdmin.tsx` is
  // the fix; these are its mandatory real-browser proof cases.
  // -------------------------------------------------------------------

  for (const [routeSuffix, label] of [
    ["/admin", "admin"],
    ["/onboarding", "onboarding"],
    ["/technical", "technical"],
  ] as const) {
    test(`EXTERNAL REVIEW FINDING 1: ordinary USER direct-navigating to /guild/:id${routeSuffix} (${label}) sees Forbidden, never the placeholder content`, async ({
      page,
    }) => {
      const gA = guildId();
      await seedGuild(page, gA, "Alpha Guild");
      await loginAs(page, freshDiscordUserId(), [
        { id: gA, owner: false, permissions: "0", name: "Alpha Guild" },
      ]);
      const en = loadCatalog("en");
      await page.goto(`/guild/${gA}${routeSuffix}`);
      await expect(
        page.getByRole("heading", { level: 1, name: en.errors.forbiddenGuild.title }),
      ).toBeVisible();
    });

    test(`EXTERNAL REVIEW FINDING 1: GUILD_ADMIN direct-navigating to /guild/:id${routeSuffix} (${label}) reaches the real placeholder content`, async ({
      page,
    }) => {
      const gA = guildId();
      await seedGuild(page, gA, "Alpha Guild");
      // Owner => GUILD_ADMIN tier (Guild Admin Resolution, Step 05).
      await loginAs(page, freshDiscordUserId(), [
        { id: gA, owner: true, permissions: "0", name: "Alpha Guild" },
      ]);
      await page.goto(`/guild/${gA}${routeSuffix}`);
      await expect(page.getByTestId("app-shell")).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const en = loadCatalog("en");
      await expect(
        page.getByRole("heading", { level: 1, name: en.errors.forbiddenGuild.title }),
      ).not.toBeVisible();
    });
  }

  test("EXTERNAL REVIEW FINDING 1: SUPERADMIN reaches every Guild-Admin-only placeholder route, for a guild it has no Discord relationship to at all", async ({
    page,
  }) => {
    const gA = guildId();
    await seedGuild(page, gA, "Alpha Guild");
    // Fixed test-double Superadmin ID (apps/api/test/helpers/testAuthConfig.ts's
    // TEST_SUPERADMIN_DISCORD_ID, the same value apps/api/scripts/e2e-server.ts
    // configures this E2E server's PLATFORM_SUPERADMIN_DISCORD_ID to) — zero
    // guilds in its own login fixture, proving the real platform bypass
    // (08_AUTHORIZATION_AND_RBAC.md), not a coincidental membership.
    await loginAs(page, "900000000000000001", []);
    for (const routeSuffix of ["/admin", "/onboarding", "/technical"] as const) {
      await page.goto(`/guild/${gA}${routeSuffix}`);
      await expect(page.getByTestId("app-shell")).toBeVisible();
      const en = loadCatalog("en");
      await expect(
        page.getByRole("heading", { level: 1, name: en.errors.forbiddenGuild.title }),
      ).not.toBeVisible();
    }
  });

  test("EXTERNAL REVIEW FINDING 1: an admin of guild A does not carry admin access into guild B — switching guild while on /admin shows B's real, independent tier", async ({
    page,
  }) => {
    const gA = guildId();
    const gB = guildId();
    await seedGuild(page, gA, "Alpha Guild");
    await seedGuild(page, gB, "Bravo Guild");
    await loginAs(page, freshDiscordUserId(), [
      { id: gA, owner: true, permissions: "0", name: "Alpha Guild" }, // GUILD_ADMIN in A
      { id: gB, owner: false, permissions: "0", name: "Bravo Guild" }, // USER only in B
    ]);
    await page.goto(`/guild/${gA}/admin`);
    await expect(page.getByTestId("app-shell")).toBeVisible();
    const en = loadCatalog("en");
    await expect(
      page.getByRole("heading", { level: 1, name: en.errors.forbiddenGuild.title }),
    ).not.toBeVisible();

    await page.getByTestId("guild-switcher-trigger").click();
    await page.getByTestId(`guild-option-${gB}`).click();

    // The "preserve current domain" rule (03_INFORMATION_ARCHITECTURE.md)
    // keeps the user on the /admin path for guild B — but B's real,
    // independently-resolved USER tier must show Forbidden there, never A's
    // GUILD_ADMIN tier carried over client-side.
    await expect(page).toHaveURL(new RegExp(`/guild/${gB}/admin$`));
    await expect(page.getByRole("heading", { level: 1, name: en.errors.forbiddenGuild.title })).toBeVisible();
  });

  for (const locale of ["fr", "en", "de"] as const) {
    test(`nav labels render in ${locale}`, async ({ page }) => {
      const gA = guildId();
      await seedGuild(page, gA, "Alpha Guild");
      await loginAs(page, freshDiscordUserId(), [
        { id: gA, owner: false, permissions: "0", name: "Alpha Guild" },
      ]);
      await page.addInitScript((l: string) => window.localStorage.setItem("bcc.locale", l), locale);
      await page.goto("/");
      await expect(page.getByTestId("app-shell")).toBeVisible();
      const catalog = loadCatalog(locale);
      await expect(page.getByTestId("sidebar-item-home")).toHaveAccessibleName(catalog.common.nav["home"]!);
      await expect(page.getByTestId("sidebar-item-upload")).toHaveAccessibleName(
        catalog.common.nav["upload"]!,
      );
    });
  }
});
