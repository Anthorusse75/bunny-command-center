// Real native Pixel 7 mobile-emulation overflow proof.
//
// responsive.spec.ts's viewport sweep deliberately opts OUT of mobile device emulation
// (`test.use({ isMobile: false })`) because combining Playwright's `devices["Pixel 7"]`
// profile with per-test `page.setViewportSize()` overrides produces inconsistent Chromium
// viewport metrics - real CI evidence, documented in that file. That correction is right for
// an arbitrary-width sweep, but by itself it means nothing in this suite proves the page is
// overflow-free under genuine, unmodified mobile emulation. This file is that proof: no
// `setViewportSize` call anywhere, so the `mobile-chromium` project's own configured Pixel 7
// viewport, device scale factor, and touch/UA emulation are exactly what a real device would
// report - the same combination the earlier viewport-mismatch bug specifically could not be
// trusted under.

import { expect, test } from "@playwright/test";
import { checkHorizontalOverflow, seedPreferences } from "./helpers.js";

test("no horizontal overflow under real Pixel 7 emulation, at its own native viewport", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-chromium",
    "meaningful only under mobile-chromium's real Pixel 7 emulation - desktop-chromium's width sweep lives in responsive.spec.ts",
  );

  await seedPreferences(page, { locale: "de" });
  // Deliberately no setViewportSize call: this is the project's own configured Pixel 7
  // viewport, completely untouched by this suite's other viewport-override tests.
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-layout", "mobile");

  const result = await checkHorizontalOverflow(page);
  expect(result.overflow, result.detail).toBe(false);
});
