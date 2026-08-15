// All 9 theme x mode combinations, in a real browser engine.
//
// 02_design_system_i18n.md §PROOF OF WIRING: "load the app shell in a browser at each of the 9
// theme x mode combinations and at both breakpoints -> effect: correct tokens applied, correct
// nav chrome shown -> readback: screenshot/snapshot comparison + contrast-check tool output".
//
// Readback here is the *resolved* value, not the declared one: `getComputedStyle(document.body)`
// after a real cascade. A jsdom test can assert the variable exists; only an engine can tell you
// the page actually painted that colour.

import { expect, test } from "@playwright/test";
import { getThemeTokens } from "../src/theme/tokens/index.js";
import {
  COLOR_SCHEME_ATTRIBUTE,
  MODE_PREFERENCES,
  THEMES,
  THEME_ATTRIBUTE,
  hexToRgbString,
  readBodyBackground,
  readCssVar,
  seedPreferences,
} from "./helpers.js";

test.describe("theme x mode matrix", () => {
  for (const theme of THEMES) {
    for (const preference of MODE_PREFERENCES) {
      const osSchemes = preference === "system" ? (["light", "dark"] as const) : ([null] as const);
      for (const osScheme of osSchemes) {
        const label = osScheme ? `${theme}/${preference} (OS=${osScheme})` : `${theme}/${preference}`;

        test(`${label} paints that combination's tokens`, async ({ page }) => {
          const consoleErrors: string[] = [];
          page.on("console", (message) => {
            if (message.type() === "error") {
              consoleErrors.push(message.text());
            }
          });
          page.on("pageerror", (error) => consoleErrors.push(error.message));

          if (osScheme) {
            await page.emulateMedia({ colorScheme: osScheme });
          } else {
            await page.emulateMedia({ colorScheme: "light" });
          }
          await seedPreferences(page, { theme, mode: preference });
          await page.goto("/");
          await expect(page.getByTestId("app-shell")).toBeVisible();

          const expectedMode = preference === "system" ? osScheme! : preference;
          const tokens = getThemeTokens(theme, expectedMode);

          await expect(page.locator("html")).toHaveAttribute(THEME_ATTRIBUTE, theme);
          await expect(page.locator("html")).toHaveAttribute(COLOR_SCHEME_ATTRIBUTE, expectedMode);

          expect(await readCssVar(page, "--bcc-palette-background-default")).toBe(
            tokens.palette.background.default,
          );
          expect(await readCssVar(page, "--bcc-palette-text-primary")).toBe(tokens.palette.text.primary);
          expect(await readCssVar(page, "--bcc-palette-bcc-status-error-surface")).toBe(
            tokens.status.error.surface,
          );

          // The engine's resolved paint colour, not the declaration.
          expect(await readBodyBackground(page)).toBe(hexToRgbString(tokens.palette.background.default));

          // Every status tone renders as a badge, so the tone colours are genuinely applied.
          await expect(page.getByTestId("status-badge")).toHaveCount(7);

          // 02_design_system_i18n.md §ACCEPTANCE CRITERIA: "All 9 theme x mode combinations render
          // without console errors".
          expect(consoleErrors, `console errors in ${label}`).toEqual([]);
        });
      }
    }
  }
});

test.describe("switching at runtime", () => {
  test("changes theme and mode with no navigation and no flash", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await seedPreferences(page, { theme: "fusion", mode: "light" });
    await page.goto("/");

    let navigations = 0;
    page.on("framenavigated", () => {
      navigations += 1;
    });

    await page.getByTestId("theme-option-heroic").click();
    await expect(page.locator("html")).toHaveAttribute(THEME_ATTRIBUTE, "heroic");
    expect(await readCssVar(page, "--bcc-palette-background-default")).toBe(
      getThemeTokens("heroic", "light").palette.background.default,
    );

    await page.getByTestId("mode-option-dark").click();
    await expect(page.locator("html")).toHaveAttribute(COLOR_SCHEME_ATTRIBUTE, "dark");
    expect(await readBodyBackground(page)).toBe(
      hexToRgbString(getThemeTokens("heroic", "dark").palette.background.default),
    );
    // Theme identity survived the mode change.
    await expect(page.locator("html")).toHaveAttribute(THEME_ATTRIBUTE, "heroic");

    // 02_design_system_i18n.md §ACCEPTANCE CRITERIA: "switching theme/mode causes no full-page
    // reload".
    expect(navigations).toBe(0);
  });

  test("persists both choices across a real reload", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    await page.getByTestId("theme-option-premium").click();
    await page.getByTestId("mode-option-dark").click();
    await expect(page.locator("html")).toHaveAttribute(COLOR_SCHEME_ATTRIBUTE, "dark");

    await page.reload();

    await expect(page.locator("html")).toHaveAttribute(THEME_ATTRIBUTE, "premium");
    await expect(page.locator("html")).toHaveAttribute(COLOR_SCHEME_ATTRIBUTE, "dark");
    expect(await readBodyBackground(page)).toBe(
      hexToRgbString(getThemeTokens("premium", "dark").palette.background.default),
    );
  });
});

test.describe("SYSTEM mode follows the OS live", () => {
  test("re-resolves on a prefers-color-scheme change with no reload, keeping the preference", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await seedPreferences(page, { theme: "fusion", mode: "system" });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute(COLOR_SCHEME_ATTRIBUTE, "light");

    // The OS setting changes underneath a running page.
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute(COLOR_SCHEME_ATTRIBUTE, "dark");
    expect(await readBodyBackground(page)).toBe(
      hexToRgbString(getThemeTokens("fusion", "dark").palette.background.default),
    );

    // ...and back.
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute(COLOR_SCHEME_ATTRIBUTE, "light");

    // The stored preference is still SYSTEM, not the value it happened to resolve to.
    expect(await page.evaluate(() => window.localStorage.getItem("bcc.mode"))).toBe("system");
    // And the SYSTEM option is the one shown as selected.
    await expect(page.getByTestId("mode-option-system")).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("no flash of wrong theme", () => {
  test("the very first paint already uses the stored dark theme", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await seedPreferences(page, { theme: "heroic", mode: "dark" });

    // Block the app bundle so the page is frozen in its pre-React state: whatever colour is
    // showing here is exactly what a user sees during the first paint. If the anti-FOUC pair were
    // missing or wired after the module script, this would be white.
    await page.route("**/assets/*.js", (route) => route.abort());
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const expected = hexToRgbString(getThemeTokens("heroic", "dark").palette.background.default);
    expect(await readBodyBackground(page)).toBe(expected);
    await expect(page.locator("html")).toHaveAttribute(COLOR_SCHEME_ATTRIBUTE, "dark");
    await expect(page.locator("html")).toHaveAttribute(THEME_ATTRIBUTE, "heroic");
  });

  test("a first-time visitor with a dark OS gets a dark first paint, before any JS state exists", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.route("**/assets/*.js", (route) => route.abort());
    await page.goto("/", { waitUntil: "domcontentloaded" });

    expect(await readBodyBackground(page)).toBe(
      hexToRgbString(getThemeTokens("fusion", "dark").palette.background.default),
    );
  });
});
