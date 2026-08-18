/**
 * Real-browser proof of Step 06's mobile navigation
 * (03_INFORMATION_ARCHITECTURE.md §Mobile navigation, `multi-guild-mobile-chromium`
 * project — a real device profile so the bottom-nav layout and the guild
 * picker sheet are exercised the way `multi-guild.spec.ts`'s desktop
 * counterpart exercises the sidebar. See that file's own header comment for
 * the full real-chain rationale; the helpers below are re-exported from it.
 */
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { guildId, loginAs, seedGuild, freshDiscordUserId } from "./multiGuildHelpers.js";

const WCAG_AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test.describe("Multi-guild model — real browser (mobile)", () => {
  test("mobile guild picker: reachable from the bottom-nav Guild tab, switches guild and preserves the screen", async ({
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

    // Waiting for the real `GET /api/users/me/guilds` response before
    // opening the picker (rather than relying solely on the sheet items'
    // own auto-retrying locator) makes this test deterministic about WHEN
    // the real guild list has actually arrived, not just eventually
    // consistent within the default timeout.
    const guildsResponsePromise = page.waitForResponse((r) => r.url().includes("/api/users/me/guilds"));
    await page.goto(`/guild/${gA}/leaderboard`);
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await expect(page.getByTestId("bottom-nav-guild")).toBeVisible();
    await guildsResponsePromise;

    await page.getByTestId("bottom-nav-guild").click();
    await expect(page.getByTestId("guild-picker-sheet")).toBeVisible();
    await page.getByTestId(`guild-option-mobile-${gB}`).click();

    await expect(page).toHaveURL(new RegExp(`/guild/${gB}/leaderboard$`));
  });

  test("mobile bottom nav never exceeds the fixed 5-destination cap in a real browser", async ({ page }) => {
    const gA = guildId();
    await seedGuild(page, gA, "Alpha Guild");
    await loginAs(page, freshDiscordUserId(), [
      { id: gA, owner: false, permissions: "0", name: "Alpha Guild" },
    ]);
    await page.goto("/");
    await expect(page.getByTestId("app-shell")).toBeVisible();

    // Scoped to exclude the wrapping `bottom-nav-items` CONTAINER itself
    // (AppShell.tsx), which also matches the `^=` prefix selector — the 5
    // real destination buttons are its children, not itself.
    const items = page.locator("[data-testid^='bottom-nav-']:not([data-testid='bottom-nav-items'])");
    await expect(items).toHaveCount(5);
  });

  test("tapping 'More' reveals the remaining destinations, never desktop-only actions", async ({ page }) => {
    const gA = guildId();
    await seedGuild(page, gA, "Alpha Guild");
    await loginAs(page, freshDiscordUserId(), [
      { id: gA, owner: false, permissions: "0", name: "Alpha Guild" },
    ]);
    await page.goto("/");
    await expect(page.getByTestId("app-shell")).toBeVisible();

    await page.getByTestId("bottom-nav-more").click();
    await expect(page.getByTestId("more-sheet")).toBeVisible();
    await expect(page.getByTestId("more-item-contributions")).toBeVisible();
    await expect(page.getByTestId("more-item-profile")).toBeVisible();
  });

  test("axe-core: the OPEN mobile guild picker sheet has no violations (regression coverage — this exact surface used to nest a real IconButton inside ListItemButton, both rendering interactive roles; caught only by a real-browser accessibility-tree snapshot, never by a test that scanned it closed)", async ({
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
    // See multi-guild.spec.ts's identical desktop axe test for why: the
    // Drawer's entrance transition can otherwise leave a real but transient
    // low-opacity frame for axe-core's `color-contrast` check to catch.
    await page.emulateMedia({ reducedMotion: "reduce" });

    const guildsResponsePromise = page.waitForResponse((r) => r.url().includes("/api/users/me/guilds"));
    await page.goto(`/guild/${gA}/leaderboard`);
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await guildsResponsePromise;

    await page.getByTestId("bottom-nav-guild").click();
    await expect(page.getByTestId(`guild-option-mobile-${gB}`)).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(WCAG_AA_TAGS).analyze();
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
