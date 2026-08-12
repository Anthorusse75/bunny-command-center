// axe-core over the real shell, plus keyboard-only operation of every control this step ships.
//
// 28_ACCESSIBILITY.md §Testing: "Automated: `axe-core` (via `@axe-core/playwright` or equivalent)
// run against every major screen in CI [...] keyboard-navigation smoke tests".
// 02_design_system_i18n.md §UX...: "Every component built here must itself pass the axe-core scan
// and the contrast check before this step is considered done, since every later step inherits
// these primitives."
//
// The scan runs across all three themes in both appearances, because a theme is a colour change
// and axe's colour-contrast rule is colour-sensitive - scanning only the default theme would leave
// two thirds of the palette unaudited by the tool.

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { THEMES, seedPreferences } from "./helpers.js";

const WCAG_AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test.describe("axe-core", () => {
  for (const theme of THEMES) {
    for (const mode of ["light", "dark"] as const) {
      test(`${theme}/${mode} has no axe violations`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: mode });
        await seedPreferences(page, { theme, mode });
        await page.goto("/");
        await expect(page.getByTestId("app-shell")).toBeVisible();

        const results = await new AxeBuilder({ page }).withTags(WCAG_AA_TAGS).analyze();
        const summary = results.violations.map(
          (violation) =>
            `${violation.id} (${violation.impact ?? "n/a"}): ${violation.help} [${violation.nodes
              .map((node) => node.target.join(" "))
              .join(" | ")}]`,
        );
        expect(summary, `${theme}/${mode} axe violations`).toEqual([]);
      });
    }
  }

  test("the toast region is clean once toasts are on screen", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("toast-info-button").click();
    await page.getByTestId("toast-error-button").click();
    await expect(page.getByTestId("toast")).toHaveCount(2);

    const results = await new AxeBuilder({ page }).withTags(WCAG_AA_TAGS).analyze();
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });

  test("the open tooltip surface is clean", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("info-tooltip-trigger").click();
    await expect(page.getByRole("tooltip")).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(WCAG_AA_TAGS).analyze();
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });
});

test.describe("keyboard-only operation", () => {
  test("reaches the skip link first, then every appearance control", async ({ page }) => {
    await page.goto("/");

    await page.keyboard.press("Tab");
    await expect(page.getByTestId("skip-link")).toBeFocused();

    // Each selector below is an exclusive `ToggleButtonGroup`. MUI 9 implements exclusive
    // toggle groups as a real ARIA composite widget (`@mui/utils/useRovingTabIndex`): Tab lands
    // on ONE roving tab stop per group and ArrowLeft/ArrowRight move the roving stop within the
    // group - Tab does not visit every button in turn (confirmed against the installed MUI
    // 9.3.1 source, not assumed from an older MUI version). The desktop sidebar's own collapse
    // button, and the showcase's toast-trigger buttons, are real intervening Tab stops between
    // these groups (and before the tooltip trigger) - this walks forward with Tab like a real
    // keyboard user, and only switches to ArrowRight once focus has actually landed inside a
    // known group, rather than assuming any fixed adjacency.
    const groups: ReadonlyArray<{ label: string; options: readonly string[] }> = [
      {
        label: "theme",
        options: ["theme-option-heroic", "theme-option-premium", "theme-option-fusion"],
      },
      { label: "mode", options: ["mode-option-light", "mode-option-dark", "mode-option-system"] },
      { label: "locale", options: ["locale-option-fr", "locale-option-en", "locale-option-de"] },
    ];
    const totalGroupOptions = groups.reduce((n, g) => n + g.options.length, 0);
    const reached = new Set<string>();
    const visitedGroups = new Set<string>();

    for (let step = 0; step < 60 && reached.size < totalGroupOptions; step += 1) {
      const focusedTestId = await page.evaluate(
        () => document.activeElement?.getAttribute("data-testid") ?? "",
      );
      const group = groups.find((candidate) => candidate.options.includes(focusedTestId));
      if (group && !visitedGroups.has(group.label)) {
        visitedGroups.add(group.label);
        reached.add(focusedTestId);
        for (let i = 0; i < group.options.length - 1; i += 1) {
          await page.keyboard.press("ArrowRight");
          const next = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? "");
          reached.add(next);
        }
      }
      await page.keyboard.press("Tab");
    }

    for (const group of groups) {
      expect([...reached].filter((id) => group.options.includes(id)).sort(), group.label).toEqual(
        [...group.options].sort(),
      );
    }

    // Keep walking forward past the groups (through the toast-trigger buttons, ...) until the
    // tooltip trigger is reached, still bounded so a real regression still fails the test.
    let tooltipReached = false;
    for (let step = 0; step < 20 && !tooltipReached; step += 1) {
      const focusedTestId = await page.evaluate(
        () => document.activeElement?.getAttribute("data-testid") ?? "",
      );
      if (focusedTestId === "info-tooltip-trigger") {
        tooltipReached = true;
        break;
      }
      await page.keyboard.press("Tab");
    }
    expect(tooltipReached).toBe(true);
    await expect(page.getByTestId("info-tooltip-trigger")).toBeFocused();
  });

  test("changes theme, mode and language with the keyboard alone", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");

    await page.getByTestId("theme-option-heroic").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveAttribute("data-bcc-theme", "heroic");

    await page.getByTestId("mode-option-dark").focus();
    await page.keyboard.press("Space");
    await expect(page.locator("html")).toHaveAttribute("data-bcc-color-scheme", "dark");

    await page.getByTestId("locale-option-de").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
  });

  test("shows a visible focus ring built from the theme's own focus tokens", async ({ page }) => {
    await page.goto("/");
    const control = page.getByTestId("theme-option-heroic");
    await control.focus();

    const focusStyles = await control.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        outlineWidth: style.outlineWidth,
        outlineStyle: style.outlineStyle,
        outlineColor: style.outlineColor,
        boxShadow: style.boxShadow,
      };
    });
    expect(focusStyles.outlineStyle).toBe("solid");
    expect(Number.parseFloat(focusStyles.outlineWidth)).toBeGreaterThanOrEqual(2);
    // The ring is the theme token, not the UA default, and the two-tone halo is present.
    // MUI keeps camelCase in generated variable names (`focusRing`, not `focus-ring`).
    const ringToken = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--bcc-palette-bcc-focusRing").trim(),
    );
    expect(ringToken).not.toBe("");
    expect(focusStyles.outlineColor.replace(/\s/g, "")).toBe(
      await page.evaluate((hex: string) => {
        const probe = document.createElement("span");
        probe.style.color = hex;
        document.body.appendChild(probe);
        const resolved = getComputedStyle(probe).color.replace(/\s/g, "");
        probe.remove();
        return resolved;
      }, ringToken),
    );
    expect(focusStyles.boxShadow).not.toBe("none");
  });

  test("dismisses a toast from the keyboard", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("toast-error-button").click();
    await expect(page.getByTestId("toast")).toHaveCount(1);

    const close = page.getByTestId("toast").getByRole("button");
    await close.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("toast")).toHaveCount(0);
  });

  test("opens and closes the tooltip from the keyboard, restoring focus", async ({ page }) => {
    await page.goto("/");
    const trigger = page.getByTestId("info-tooltip-trigger");
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tooltip")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});

test.describe("reduced motion", () => {
  test("collapses transitions to an instant change without removing the state change", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    // 28_ACCESSIBILITY.md §Reduced motion: reduced to an instant, never removed. The state change
    // itself must still happen.
    await page.getByTestId("mode-option-dark").click();
    await expect(page.locator("html")).toHaveAttribute("data-bcc-color-scheme", "dark");

    const duration = await page
      .getByTestId("theme-option-heroic")
      .evaluate((element) => getComputedStyle(element).transitionDuration);
    // `getComputedStyle` always normalises `transition-duration` to seconds and switches to
    // scientific notation for very small values (e.g. "1e-05s" for the 0.01ms the
    // reduced-motion rule clamps every transition to) - parse the number rather than
    // string-matching a decimal prefix, which "1e-05s" does not have.
    const firstDurationMs = Number.parseFloat(duration.split(",")[0] ?? "NaN") * 1000;
    expect(firstDurationMs).toBeGreaterThanOrEqual(0);
    expect(firstDurationMs).toBeLessThan(1);
  });
});
