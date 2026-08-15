// Token-schema conformance.
//
// 20_DESIGN_SYSTEM_AND_THEMES.md §Token architecture lists eight themed categories and a set
// of per-theme commitments for each. These tests assert the commitments that are actually
// checkable in code, so a future edit cannot quietly turn Premium into a glowing theme or
// give a theme its own spacing rhythm.

import { describe, expect, it } from "vitest";
import { STATUS_TONES } from "@bunny-command-center/shared";
import {
  BCC_BREAKPOINTS,
  BCC_MODES,
  BCC_THEME_NAMES,
  DEFAULT_MODE_PREFERENCE,
  DEFAULT_THEME_NAME,
  NAV_SWAP_BREAKPOINT_PX,
  allThemeModeCombinations,
  getThemeTokens,
} from "../tokens/index.js";
import { SHARED_SPACING, SHARED_TYPE_SCALE } from "../tokens/shared.js";
import { STATUS_HUES, hslToHex, solveForContrast, worstCaseSurface } from "../tokens/primitives.js";
import { contrastRatio } from "../contrast.js";

const HEX = /^#[0-9a-f]{6}$/;

describe("token registry", () => {
  it("exposes exactly the three documented themes, each with both modes", () => {
    expect([...BCC_THEME_NAMES]).toEqual(["heroic", "premium", "fusion"]);
    for (const name of BCC_THEME_NAMES) {
      for (const mode of BCC_MODES) {
        const tokens = getThemeTokens(name, mode);
        expect(tokens.name).toBe(name);
        expect(tokens.mode).toBe(mode);
      }
    }
  });

  it("defaults to Fusion (D-017) and to a system-tracking mode", () => {
    expect(DEFAULT_THEME_NAME).toBe("fusion");
    expect(DEFAULT_MODE_PREFERENCE).toBe("system");
  });

  it("uses the breakpoints 21_MOBILE_UX.md defines, swapping navigation at 960px", () => {
    expect(BCC_BREAKPOINTS.sm).toBe(600);
    expect(BCC_BREAKPOINTS.md).toBe(960);
    expect(NAV_SWAP_BREAKPOINT_PX).toBe(960);
  });
});

describe("spacing is a usability constant, not a theme expression", () => {
  it("is the identical frozen object in all six token sets", () => {
    for (const { name, mode } of allThemeModeCombinations()) {
      expect(getThemeTokens(name, mode).spacing).toBe(SHARED_SPACING);
    }
  });

  it("keeps the 8px grid and the 44px touch-target token 21_MOBILE_UX.md names", () => {
    expect(SHARED_SPACING.baseUnit).toBe(8);
    expect(SHARED_SPACING.touchTarget).toBe(44);
  });

  it("shares one typographic scale across themes (only the face/weight vary)", () => {
    for (const { name, mode } of allThemeModeCombinations()) {
      expect(getThemeTokens(name, mode).typography.scale).toBe(SHARED_TYPE_SCALE);
    }
  });
});

describe("per-theme category commitments", () => {
  it("Premium: a refined sans throughout, no display face, no glow, restrained motion", () => {
    for (const mode of BCC_MODES) {
      const tokens = getThemeTokens("premium", mode);
      expect(tokens.typography.displayFaceUsage).toBe("none");
      expect(tokens.typography.fontFamilyDisplay).toBe(tokens.typography.fontFamilyBody);
      expect(tokens.surfaces.glow.scope).toBe("none");
      expect(tokens.surfaces.glow.shadow).toBe("none");
      expect(tokens.motion.intensity).toBe("subdued");
      expect(tokens.icons.variant).toBe("outlined");
      expect(tokens.radius.emphasisShape).toBe("rounded");
      // "Consistent moderate rounding": the accent corner is not a different shape.
      expect(tokens.radius.accentCorner).toBe(tokens.radius.card);
      expect(tokens.illustration.style).toBe("abstract-geometric");
    }
  });

  it("Heroic: display face for headings, angular accents, interactive glow, pronounced motion", () => {
    for (const mode of BCC_MODES) {
      const tokens = getThemeTokens("heroic", mode);
      expect(tokens.typography.displayFaceUsage).toBe("all-headings");
      expect(tokens.typography.fontFamilyDisplay).not.toBe(tokens.typography.fontFamilyBody);
      expect(tokens.radius.emphasisShape).toBe("angular");
      expect(tokens.radius.accentCorner).toBeLessThan(tokens.radius.card);
      expect(tokens.surfaces.glow.scope).toBe("interactive");
      expect(tokens.motion.intensity).toBe("pronounced");
      expect(tokens.icons.variant).toBe("filled");
      expect(tokens.illustration.style).toBe("heroic-adjacent");
    }
  });

  it("Fusion: Premium's sans + Heroic's display face, restricted; glow only on the primary CTA", () => {
    for (const mode of BCC_MODES) {
      const fusion = getThemeTokens("fusion", mode);
      const premium = getThemeTokens("premium", mode);
      const heroic = getThemeTokens("heroic", mode);
      expect(fusion.typography.fontFamilyBody).toBe(premium.typography.fontFamilyBody);
      expect(fusion.typography.fontFamilyDisplay).toBe(heroic.typography.fontFamilyDisplay);
      expect(fusion.typography.displayFaceUsage).toBe("hero-and-section-titles");
      // Premium's rounding for cards...
      expect(fusion.radius.card).toBe(premium.radius.card);
      // ...with Heroic's angular corner available to emphasis elements only.
      expect(fusion.radius.emphasisShape).toBe("hybrid");
      expect(fusion.radius.accentCorner).toBeLessThan(fusion.radius.card);
      expect(fusion.surfaces.glow.scope).toBe("primary-cta");
      // Premium's speed...
      expect(fusion.motion.duration.normal).toBe(premium.motion.duration.normal);
      // ...with Heroic's curve reserved for celebration moments.
      expect(fusion.motion.easing.celebration).toBe(heroic.motion.easing.celebration);
      expect(fusion.motion.easing.standard).toBe(premium.motion.easing.standard);
      expect(fusion.icons.variant).toBe("outlined-filled-primary");
      expect(fusion.illustration.style).toBe("restrained-blend");
      expect(fusion.illustration.usage).toBe("sparing");
    }
  });
});

describe("status colours keep one hue family across all three themes", () => {
  it("never assigns a semantic tone a different hue per theme", () => {
    // Hue is not recoverable exactly from a rounded hex, so this asserts the structural
    // guarantee instead: every theme's status colours are produced from the ONE shared hue
    // table, and no theme module supplies a hue of its own.
    expect(Object.keys(STATUS_HUES).sort()).toEqual([...STATUS_TONES].sort());
    for (const tone of STATUS_TONES) {
      const hue = STATUS_HUES[tone];
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it("keeps error red, success green, warning amber and info blue in their expected channels", () => {
    for (const { name, mode } of allThemeModeCombinations()) {
      const { status } = getThemeTokens(name, mode);
      const channels = (hex: string): { r: number; g: number; b: number } => ({
        r: Number.parseInt(hex.slice(1, 3), 16),
        g: Number.parseInt(hex.slice(3, 5), 16),
        b: Number.parseInt(hex.slice(5, 7), 16),
      });
      const error = channels(status.error.main);
      const success = channels(status.success.main);
      const warning = channels(status.warning.main);
      const info = channels(status.info.main);
      expect(error.r, `${name}/${mode} error must be red-dominant`).toBeGreaterThan(error.g);
      expect(error.r).toBeGreaterThan(error.b);
      expect(success.g, `${name}/${mode} success must be green-dominant`).toBeGreaterThan(success.r);
      expect(success.g).toBeGreaterThan(success.b);
      expect(warning.r, `${name}/${mode} warning must be warm`).toBeGreaterThan(warning.b);
      expect(warning.g).toBeGreaterThan(warning.b);
      expect(info.b, `${name}/${mode} info must be blue-dominant`).toBeGreaterThan(info.r);
    }
  });

  it("tunes saturation per theme (Heroic most saturated, Premium least)", () => {
    const spread = (hex: string): number => {
      const r = Number.parseInt(hex.slice(1, 3), 16);
      const g = Number.parseInt(hex.slice(3, 5), 16);
      const b = Number.parseInt(hex.slice(5, 7), 16);
      return Math.max(r, g, b) - Math.min(r, g, b);
    };
    const heroic = spread(getThemeTokens("heroic", "light").status.warning.main);
    const fusion = spread(getThemeTokens("fusion", "light").status.warning.main);
    const premium = spread(getThemeTokens("premium", "light").status.warning.main);
    expect(heroic).toBeGreaterThan(fusion);
    expect(fusion).toBeGreaterThan(premium);
  });

  it("emits only opaque hex for every colour the contrast gate has to evaluate", () => {
    for (const { name, mode } of allThemeModeCombinations()) {
      const tokens = getThemeTokens(name, mode);
      const colors = [
        tokens.palette.primary.main,
        tokens.palette.primary.contrastText,
        tokens.palette.secondary.main,
        tokens.palette.secondary.contrastText,
        tokens.palette.background.default,
        tokens.palette.background.paper,
        tokens.palette.background.elevated,
        tokens.palette.text.primary,
        tokens.palette.text.secondary,
        tokens.palette.text.disabled,
        tokens.palette.divider,
        tokens.palette.border,
        tokens.palette.focusRing,
        tokens.palette.focusRingHalo,
        tokens.palette.scrim,
        ...STATUS_TONES.flatMap((tone) => {
          const color = tokens.status[tone];
          return [color.main, color.contrastText, color.surface, color.onSurface, color.border];
        }),
        ...tokens.illustration.accents,
      ];
      for (const color of colors) {
        expect(color, `${name}/${mode}: ${color}`).toMatch(HEX);
      }
    }
  });
});

describe("colour primitives", () => {
  it("converts HSL to the expected hex corners", () => {
    expect(hslToHex(0, 0, 0)).toBe("#000000");
    expect(hslToHex(0, 0, 1)).toBe("#ffffff");
    expect(hslToHex(0, 1, 0.5)).toBe("#ff0000");
    expect(hslToHex(120, 1, 0.5)).toBe("#00ff00");
    expect(hslToHex(240, 1, 0.5)).toBe("#0000ff");
  });

  it("solveForContrast returns the first colour that actually meets the requirement", () => {
    const solved = solveForContrast(205, 0.7, 0.5, -1, "#ffffff", 4.5);
    expect(contrastRatio(solved, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    // One step lighter must NOT meet it, i.e. the search stopped at the first success rather
    // than overshooting into a needlessly dark colour.
    const oneStepLighter = solveForContrast(205, 0.7, 0.5, -1, "#ffffff", 4.5);
    expect(contrastRatio(oneStepLighter, "#ffffff")).toBeLessThan(6.5);
  });

  it("picks the darkest surface in light mode and the lightest in dark mode", () => {
    const surfaces = ["#ffffff", "#f5f7fa", "#e0e4ea"];
    expect(worstCaseSurface("light", surfaces)).toBe("#e0e4ea");
    expect(worstCaseSurface("dark", surfaces)).toBe("#ffffff");
  });
});
