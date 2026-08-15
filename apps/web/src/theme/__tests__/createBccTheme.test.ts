// The theme factory, per theme x mode combination.
//
// ADR-015's signature is `createBccTheme(themeName, mode)` with mode including `system`, so
// all 9 combinations are exercised here, with `system` driven from an injected
// `prefers-color-scheme` result in BOTH directions.

import { describe, expect, it } from "vitest";
import { createBccTheme } from "../createBccTheme.js";
import { COLOR_SCHEME_ATTRIBUTE, CSS_VAR_PREFIX, resolveMode } from "../mode.js";
import {
  BCC_MODE_PREFERENCES,
  BCC_THEME_NAMES,
  DEFAULT_THEME_NAME,
  allThemeModeCombinations,
  getThemeTokens,
} from "../tokens/index.js";

describe("createBccTheme", () => {
  it("builds all 9 theme x mode-preference combinations, resolving system both ways", () => {
    const built: string[] = [];
    for (const name of BCC_THEME_NAMES) {
      for (const preference of BCC_MODE_PREFERENCES) {
        for (const systemPrefersDark of preference === "system" ? [false, true] : [false]) {
          const theme = createBccTheme(name, preference, { systemPrefersDark });
          const expected = resolveMode(preference, systemPrefersDark);
          expect(theme.defaultColorScheme).toBe(expected);
          expect(theme.palette.mode).toBe(expected);
          built.push(`${name}/${preference}`);
        }
      }
    }
    expect(new Set(built).size).toBe(9);
  });

  it("always ships BOTH colour schemes so a mode switch is a CSS recompute, not a rebuild", () => {
    for (const name of BCC_THEME_NAMES) {
      for (const preference of BCC_MODE_PREFERENCES) {
        const theme = createBccTheme(name, preference, { systemPrefersDark: false });
        expect(theme.colorSchemes?.light).toBeDefined();
        expect(theme.colorSchemes?.dark).toBeDefined();
      }
    }
  });

  it("enables CSS variables under the product's own attribute and prefix", () => {
    const theme = createBccTheme("fusion", "light");
    expect(theme.colorSchemeSelector).toBe(COLOR_SCHEME_ATTRIBUTE);
    expect(theme.cssVarPrefix).toBe(CSS_VAR_PREFIX);
    expect(theme.vars).toBeDefined();
    // A generated variable, proving the CSS-variable machinery actually ran. MUI emits the
    // default colour scheme's value as the var()'s fallback, which is why this is a prefix
    // match rather than an exact one.
    expect(theme.vars.palette.primary.main).toMatch(
      new RegExp(`^var\\(--${CSS_VAR_PREFIX}-palette-primary-main[,)]`),
    );
    expect(theme.vars.palette.bcc.status.error.surface).toContain(
      `--${CSS_VAR_PREFIX}-palette-bcc-status-error-surface`,
    );
  });

  it("carries every token category from the token module onto the theme", () => {
    for (const { name, mode } of allThemeModeCombinations()) {
      const tokens = getThemeTokens(name, mode);
      const theme = createBccTheme(name, mode);

      // Identity + mode-invariant categories.
      expect(theme.bcc.name).toBe(name);
      expect(theme.bcc.radius).toEqual(tokens.radius);
      expect(theme.bcc.space).toEqual(tokens.spacing);
      expect(theme.bcc.motion).toEqual(tokens.motion);
      expect(theme.bcc.icons).toEqual(tokens.icons);
      expect(theme.bcc.displayFaceUsage).toBe(tokens.typography.displayFaceUsage);
      expect(theme.bcc.glowScope).toBe(tokens.surfaces.glow.scope);
      expect(theme.bcc.illustration).toEqual({
        style: tokens.illustration.style,
        usage: tokens.illustration.usage,
      });

      // Colour: resolved values live under the active colour scheme.
      const scheme = theme.colorSchemes?.[mode];
      expect(scheme?.palette.primary.main).toBe(tokens.palette.primary.main);
      expect(scheme?.palette.background.default).toBe(tokens.palette.background.default);
      expect(scheme?.palette.text.secondary).toBe(tokens.palette.text.secondary);
      expect(scheme?.palette.bcc.border).toBe(tokens.palette.border);
      expect(scheme?.palette.bcc.focusRing).toBe(tokens.palette.focusRing);
      expect(scheme?.palette.bcc.focusRingHalo).toBe(tokens.palette.focusRingHalo);
      expect(scheme?.palette.bcc.surface.elevated).toBe(tokens.palette.background.elevated);
      expect(scheme?.palette.bcc.shadow.card).toBe(tokens.surfaces.shadow.card);
      expect(scheme?.palette.bcc.glow).toBe(tokens.surfaces.glow.shadow);
      expect(scheme?.palette.bcc.status.error.surface).toBe(tokens.status.error.surface);
    }
  });

  it("reuses the four documented status families as MUI's own semantic colours", () => {
    // 02_design_system_i18n.md §REJECTION CRITERIA forbids "a second, divergent
    // implementation" - so MuiAlert/MuiChip/color=\"error\" must resolve to the same values
    // StatusBadge uses, not to MUI's stock red.
    for (const { name, mode } of allThemeModeCombinations()) {
      const tokens = getThemeTokens(name, mode);
      const scheme = createBccTheme(name, mode).colorSchemes?.[mode];
      expect(scheme?.palette.success.main).toBe(tokens.status.success.main);
      expect(scheme?.palette.warning.main).toBe(tokens.status.warning.main);
      expect(scheme?.palette.error.main).toBe(tokens.status.error.main);
      expect(scheme?.palette.info.main).toBe(tokens.status.info.main);
    }
  });

  it("maps the documented breakpoints onto MUI's tokens (md = 960, not MUI's stock 900)", () => {
    const theme = createBccTheme("fusion", "light");
    expect(theme.breakpoints.values.sm).toBe(600);
    expect(theme.breakpoints.values.md).toBe(960);
    expect(theme.breakpoints.up("md")).toBe("@media (min-width:960px)");
  });

  it("applies each theme's display-face policy to the right typography variants", () => {
    const heroic = createBccTheme("heroic", "light");
    const premium = createBccTheme("premium", "light");
    const fusion = createBccTheme("fusion", "light");

    // Heroic: display face on every heading.
    expect(heroic.typography.h1.fontFamily).toBe(heroic.bcc.fontFamilyDisplay);
    expect(heroic.typography.h3.fontFamily).toBe(heroic.bcc.fontFamilyDisplay);
    // Premium: one face throughout - the display slot resolves to the body face.
    expect(premium.typography.h1.fontFamily).toBe(premium.bcc.fontFamilyBody);
    // Fusion: hero numbers and section titles only, so h3/h4 stay on the body face.
    expect(fusion.typography.h1.fontFamily).toBe(fusion.bcc.fontFamilyDisplay);
    expect(fusion.typography.h2.fontFamily).toBe(fusion.bcc.fontFamilyDisplay);
    expect(fusion.typography.h3.fontFamily).toBe(fusion.bcc.fontFamilyBody);
    expect(fusion.typography.heroNumber.fontFamily).toBe(fusion.bcc.fontFamilyDisplay);
    expect(fusion.bcc.fontFamilyDisplay).not.toBe(fusion.bcc.fontFamilyBody);
  });

  it("drives MUI's transition durations and easings from the motion tokens", () => {
    for (const name of BCC_THEME_NAMES) {
      const tokens = getThemeTokens(name, "light");
      const theme = createBccTheme(name, "light");
      expect(theme.transitions.duration.standard).toBe(tokens.motion.duration.normal);
      expect(theme.transitions.easing.easeInOut).toBe(tokens.motion.easing.standard);
    }
  });

  it("sets MUI's spacing unit from the shared 8px grid", () => {
    const theme = createBccTheme("premium", "dark");
    // With cssVariables on, spacing resolves through a CSS variable whose fallback carries
    // the real value - so the 8px grid is asserted on the fallback and on the multiple.
    expect(theme.spacing(1)).toBe("var(--bcc-spacing, 8px)");
    expect(theme.spacing(2)).toBe("calc(2 * var(--bcc-spacing, 8px))");
    expect(theme.bcc.space.baseUnit).toBe(8);
  });

  it("uses Fusion when handed the documented default", () => {
    expect(createBccTheme(DEFAULT_THEME_NAME, "light").bcc.name).toBe("fusion");
  });
});
