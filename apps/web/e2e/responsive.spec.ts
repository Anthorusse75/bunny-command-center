// Responsive behaviour in a real layout engine.
//
// 21_MOBILE_UX.md fixes the breakpoints; 02_design_system_i18n.md §ACCEPTANCE CRITERIA requires the
// shell to "correctly swap bottom-nav/sidebar at the 960px breakpoint". Overflow is checked with
// German selected, because DE is the longest of the three languages and is where a fixed-width
// control or an unwrapped label first breaks the layout - EN-only overflow testing would pass while
// the product is broken for a third of its users.

import { expect, test } from "@playwright/test";
import { LOCALES, checkHorizontalOverflow, seedPreferences } from "./helpers.js";

/** The narrowest mainstream viewport; see MIN_SUPPORTED_VIEWPORT_PX in src/theme/tokens/types.ts. */
const MIN_WIDTH = 320;

// Every test in this file drives its own size via `page.setViewportSize(...)` rather than
// relying on either Playwright project's default viewport - that is what this file is FOR
// (sweeping many exact widths). Combining that with the `mobile-chromium` project's
// `devices["Pixel 7"]` emulation (`isMobile: true`) leaves Chromium's own viewport accounting
// inconsistent: real CI evidence (a temporary diagnostic dump, since this never reproduced on
// a local Windows Chromium) showed `window.innerWidth` reading 329 while
// `document.documentElement.clientWidth` correctly read 320 after `setViewportSize({width:
// 320, ...})` on an `isMobile: true` context - and `position: fixed; inset-inline: 0` resolves
// against the former, not the latter, so the bottom nav rendered 9px wider than the page
// actually was. No real device goes through "apply a device profile, then override the
// viewport" - that sequence only exists here, in this test file - so this is a test-harness
// mismatch, not a product bug: opting these tests out of mobile emulation makes
// `setViewportSize` behave consistently on both projects. Real touch/DPR realism is exercised
// elsewhere (accessibility.spec.ts's tooltip tap-fallback tests), which never overrides the
// project's viewport.
test.use({ isMobile: false, hasTouch: false });

test.describe("breakpoint swap", () => {
  for (const { width, expected } of [
    { width: MIN_WIDTH, expected: "mobile" },
    { width: 375, expected: "mobile" },
    { width: 599, expected: "mobile" },
    { width: 600, expected: "mobile" },
    { width: 959, expected: "mobile" },
    { width: 960, expected: "desktop" },
    { width: 1024, expected: "desktop" },
    { width: 1440, expected: "desktop" },
  ]) {
    test(`at ${width}px the shell is ${expected}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/__showcase__");
      await expect(page.getByTestId("app-shell")).toHaveAttribute("data-layout", expected);
      if (expected === "desktop") {
        await expect(page.getByTestId("sidebar")).toBeVisible();
        await expect(page.getByTestId("bottom-nav")).toHaveCount(0);
      } else {
        await expect(page.getByTestId("bottom-nav")).toBeVisible();
        await expect(page.getByTestId("sidebar")).toHaveCount(0);
      }
    });
  }

  test("swaps live across 960px without a reload", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__showcase__");
    await expect(page.getByTestId("sidebar")).toBeVisible();

    await page.setViewportSize({ width: 600, height: 900 });
    await expect(page.getByTestId("bottom-nav")).toBeVisible();
    await expect(page.getByTestId("sidebar")).toHaveCount(0);

    await page.setViewportSize({ width: 1024, height: 900 });
    await expect(page.getByTestId("sidebar")).toBeVisible();
  });
});

test.describe("no horizontal overflow", () => {
  for (const locale of LOCALES) {
    test(`at ${MIN_WIDTH}px in ${locale}`, async ({ page }) => {
      await seedPreferences(page, { locale });
      await page.setViewportSize({ width: MIN_WIDTH, height: 720 });
      await page.goto("/__showcase__");
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      // Raise every toast so the widest transient surface is on screen too.
      await page.getByTestId("toast-error-button").click();
      await expect(page.getByTestId("toast")).toHaveCount(1);

      const result = await checkHorizontalOverflow(page);
      expect(result.overflow, `overflow at ${MIN_WIDTH}px/${locale}: ${result.detail}`).toBe(false);
    });
  }

  test("in German at every breakpoint boundary (DE is the longest language)", async ({ page }) => {
    await seedPreferences(page, { locale: "de" });
    for (const width of [MIN_WIDTH, 360, 599, 600, 768, 959, 960, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/__showcase__");
      await expect(page.locator("html")).toHaveAttribute("lang", "de");
      const result = await checkHorizontalOverflow(page);
      expect(result.overflow, `overflow at ${width}px in German: ${result.detail}`).toBe(false);
    }
  });
});

test.describe("overflow detector regression proof", () => {
  test("the detector actually fails for a deliberately introduced real 5-9px horizontal overflow", async ({
    page,
  }) => {
    // Proves checkHorizontalOverflow catches genuine overflow rather than silently tolerating
    // exactly the class of bug this whole investigation was chasing (see its doc comment). The
    // probe element is a real, unclipped, absolutely-positioned block wider than the viewport -
    // the browser WILL let a user scroll to it, unlike the metrics-only discrepancy that
    // motivated moving off a blind scrollWidth/clientWidth tolerance in the first place.
    await page.setViewportSize({ width: MIN_WIDTH, height: 900 });
    await page.goto("/__showcase__");
    await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.setAttribute("data-testid", "deliberate-overflow-probe");
      probe.style.position = "absolute";
      probe.style.top = "0";
      probe.style.left = "0";
      probe.style.height = "1px";
      // Inside the 5-9px range this investigation kept measuring, so this fixture is
      // representative of the exact bug class the detector must not miss.
      probe.style.width = `${document.documentElement.clientWidth + 7}px`;
      document.body.appendChild(probe);
    });

    const result = await checkHorizontalOverflow(page);
    expect(result.overflow, result.detail).toBe(true);
  });
});

test.describe("touch targets and mobile chrome", () => {
  test("every interactive control meets the 44px minimum", async ({ page }) => {
    // 21_MOBILE_UX.md §Touch targets: "Minimum touch target: 44x44px [...] enforced as a design-token
    // constant (`spacing.touchTarget`), checked in component review, not just eyeballed."
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/__showcase__");

    const undersized = await page.evaluate(() => {
      const results: string[] = [];
      const controls = document.querySelectorAll<HTMLElement>("button, a[href], [role='button']");
      for (const control of Array.from(controls)) {
        const rect = control.getBoundingClientRect();
        // Skip the visually-hidden-until-focused skip link, which is off-screen by design.
        if (rect.width === 0 || rect.height === 0 || rect.top < 0) {
          continue;
        }
        if (rect.height < 44) {
          results.push(
            `${control.tagName.toLowerCase()}[${control.getAttribute("data-testid") ?? control.getAttribute("aria-label") ?? ""}] h=${Math.round(rect.height)}`,
          );
        }
      }
      return results;
    });
    expect(undersized).toEqual([]);
  });

  test("places toasts bottom-centre on mobile and top-right on desktop", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/__showcase__");
    await page.getByTestId("toast-error-button").click();
    await expect(page.getByTestId("toast-region")).toHaveAttribute("data-placement", "mobile-bottom-center");
    // ...and it must not sit on top of the bottom nav.
    const overlaps = await page.evaluate(() => {
      const region = document.querySelector<HTMLElement>("[data-testid='toast-region']");
      const nav = document.querySelector<HTMLElement>("[data-testid='bottom-nav']");
      if (!region || !nav) {
        return "missing";
      }
      return region.getBoundingClientRect().bottom > nav.getBoundingClientRect().top;
    });
    expect(overlaps).toBe(false);

    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.getByTestId("toast-region")).toHaveAttribute("data-placement", "desktop-top-right");
  });

  test("collapses and restores the desktop sidebar, remembering the choice", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__showcase__");
    await expect(page.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "false");
    const expandedWidth = (await page.getByTestId("sidebar").boundingBox())?.width ?? 0;

    await page.getByTestId("sidebar-toggle").click();
    await expect(page.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "true");
    // The width itself animates over the theme's `motion.duration.normal` (180ms) via a CSS
    // `transition: width`, so the bounding box read immediately after the click can still
    // observe the pre-collapse width mid-transition - poll instead of reading once.
    await expect
      .poll(async () => (await page.getByTestId("sidebar").boundingBox())?.width ?? expandedWidth, {
        timeout: 2000,
      })
      .toBeLessThan(expandedWidth);

    await page.reload();
    await expect(page.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "true");
  });
});
