// Language switching in a real browser: the parts jsdom cannot vouch for (persistence across a
// real reload, `navigator.language` detection, the document title the browser actually shows).

import { expect, test } from "@playwright/test";
import { LOCALES, loadCatalog, seedPreferences } from "./helpers.js";

// The catalogs are read from disk rather than imported: Playwright's TypeScript loader is a plain
// Node ESM loader, which requires an explicit `with { type: "json" }` attribute that the app's own
// bundler-resolution tsconfig does not use. Reading the files keeps one spelling that works in both.
const CATALOGS = {
  fr: loadCatalog("fr"),
  en: loadCatalog("en"),
  de: loadCatalog("de"),
} as const;
const de = CATALOGS.de;

test.describe("language switching", () => {
  test("switches copy, <html lang> and the document title with no reload", async ({ page }) => {
    await page.goto("/");
    let navigations = 0;
    page.on("framenavigated", () => {
      navigations += 1;
    });

    for (const locale of LOCALES) {
      await page.getByTestId(`locale-option-${locale}`).click();
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(CATALOGS[locale].showcase.title);
      await expect(page).toHaveTitle(CATALOGS[locale].app.title);
    }
    expect(navigations).toBe(0);
  });

  test("persists the language across a real reload", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("locale-option-de").click();
    await expect(page.locator("html")).toHaveAttribute("lang", "de");

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(de.showcase.title);
  });

  test("detects the browser language on a first visit", async ({ browser }) => {
    // No stored preference: 19_I18N_FR_EN_DE.md §Language detection says navigator.language decides.
    const context = await browser.newContext({ locale: "de-DE" });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    await context.close();
  });

  test("falls back to English for an unsupported browser language", async ({ browser }) => {
    const context = await browser.newContext({ locale: "es-ES" });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await context.close();
  });

  test("a stored preference beats the browser language", async ({ browser }) => {
    const context = await browser.newContext({ locale: "de-DE" });
    const page = await context.newPage();
    await seedPreferences(page, { locale: "fr" });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "fr");
    await context.close();
  });

  test("never leaks a raw {{placeholder}} into the rendered page, in any language", async ({ page }) => {
    await page.goto("/");
    for (const locale of LOCALES) {
      await page.getByTestId(`locale-option-${locale}`).click();
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      const bodyText = (await page.locator("body").innerText()) ?? "";
      expect(bodyText, `raw placeholder visible in ${locale}`).not.toContain("{{");
      // A missing key renders as the key itself; a dotted namespace prefix in visible copy is the
      // signature of that failure.
      expect(bodyText).not.toContain("showcase.");
      expect(bodyText).not.toContain("common.");
      expect(bodyText).not.toContain("a11y.");
    }
  });

  test("formats numbers per locale (the Intl wrapper is really wired)", async ({ page }) => {
    await page.goto("/");
    const heroNumber = page.getByTestId("type-hero-number");

    await page.getByTestId("locale-option-en").click();
    await expect(heroNumber).toHaveText("1,248");

    await page.getByTestId("locale-option-de").click();
    await expect(heroNumber).toHaveText("1.248");

    await page.getByTestId("locale-option-fr").click();
    // fr-FR groups with a narrow no-break space, so this asserts on the digits plus "not a comma".
    const french = await heroNumber.innerText();
    expect(french.replace(/[\s\u00a0\u202f]/g, "")).toBe("1248");
    expect(french).not.toContain(",");
  });
});

test.describe("status badge copy", () => {
  test("renders every tone's label in the active language", async ({ page }) => {
    await page.goto("/");
    for (const locale of LOCALES) {
      await page.getByTestId(`locale-option-${locale}`).click();
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      for (const [tone, label] of Object.entries(CATALOGS[locale].common.status)) {
        await expect(page.locator(`[data-testid="status-badge"][data-status-tone="${tone}"]`)).toContainText(
          label,
        );
      }
    }
  });
});
