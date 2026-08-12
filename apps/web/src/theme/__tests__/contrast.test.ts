// The WCAG 2.2 AA contrast gate, as tests.
//
// The CLI script (apps/web/scripts/check-contrast.ts) is what CI runs; these tests cover the
// same requirement from the other direction: that the maths matches the published WCAG
// definition (so a passing gate means something), and that every one of the 9 theme x mode
// combinations passes it.

import { describe, expect, it } from "vitest";
import { AA_NON_TEXT, AA_NORMAL_TEXT, contrastRatio, parseHexColor, relativeLuminance } from "../contrast.js";
import {
  contrastPairsFor,
  evaluatePairs,
  evaluateThemeMode,
  informationalPairsFor,
} from "../contrast-requirements.js";
import {
  BCC_MODE_PREFERENCES,
  BCC_MODES,
  BCC_THEME_NAMES,
  DEFAULT_THEME_NAME,
  allThemeModeCombinations,
  getThemeTokens,
} from "../tokens/index.js";
import { resolveMode } from "../mode.js";

describe("WCAG contrast maths", () => {
  it("matches the published reference ratios for black/white", () => {
    // https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio - the maximum possible ratio is 21:1.
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });

  it("is symmetric in its arguments", () => {
    expect(contrastRatio("#1f5074", "#f6f7f9")).toBeCloseTo(contrastRatio("#f6f7f9", "#1f5074"), 10);
  });

  it("computes the reference relative luminance of pure primaries", () => {
    // The sRGB coefficients from the WCAG definition, at full channel value.
    expect(relativeLuminance("#ff0000")).toBeCloseTo(0.2126, 4);
    expect(relativeLuminance("#00ff00")).toBeCloseTo(0.7152, 4);
    expect(relativeLuminance("#0000ff")).toBeCloseTo(0.0722, 4);
  });

  it("expands 3-digit hex and rejects anything it cannot evaluate", () => {
    expect(parseHexColor("#abc")).toEqual(parseHexColor("#aabbcc"));
    expect(() => parseHexColor("rgb(0,0,0)")).toThrow(/opaque hex/);
    expect(() => parseHexColor("#12345")).toThrow();
  });
});

describe("theme x mode contrast gate", () => {
  it("covers all 9 user-selectable combinations with 6 distinct token sets", () => {
    expect(BCC_THEME_NAMES.length * BCC_MODE_PREFERENCES.length).toBe(9);
    expect(allThemeModeCombinations()).toHaveLength(6);
  });

  for (const { name, mode } of allThemeModeCombinations()) {
    it(`${name}/${mode} passes every required pair`, () => {
      const { required } = evaluateThemeMode(name, mode);
      const failures = required
        .filter((result) => !result.passed)
        .map((result) => `${result.label}: ${result.ratio.toFixed(2)}:1 < ${result.required}:1`);
      expect(failures).toEqual([]);
      // Guards against the gate silently becoming empty (e.g. a refactor that drops a loop),
      // which would make it pass for the wrong reason.
      expect(required.length).toBeGreaterThan(60);
    });
  }

  for (const preference of BCC_MODE_PREFERENCES) {
    it(`the ${DEFAULT_THEME_NAME} theme passes in the "${preference}" preference under both OS settings`, () => {
      for (const systemPrefersDark of [false, true]) {
        const resolved = resolveMode(preference, systemPrefersDark);
        const { required } = evaluateThemeMode(DEFAULT_THEME_NAME, resolved);
        expect(required.every((result) => result.passed)).toBe(true);
      }
    });
  }

  it("enumerates a pair for every status tone on every surface", () => {
    const tokens = getThemeTokens("fusion", "light");
    const labels = contrastPairsFor(tokens).map((pair) => pair.label);
    for (const tone of Object.keys(tokens.status)) {
      expect(labels).toContain(`status.${tone}.onSurface on status.${tone}.surface`);
      expect(labels).toContain(`status.${tone}.contrastText on status.${tone}.main`);
      for (const surface of ["default", "paper", "elevated"]) {
        expect(labels).toContain(`status.${tone}.border on background.${surface}`);
      }
    }
  });

  it("documents its exemptions instead of silently omitting them", () => {
    for (const mode of BCC_MODES) {
      const informational = informationalPairsFor(getThemeTokens("heroic", mode));
      expect(informational.length).toBeGreaterThan(0);
      for (const pair of informational) {
        // Every non-enforced pair must state WHY it is exempt, with the WCAG clause.
        expect(pair.reason).toMatch(/^EXEMPT: WCAG 2\.2 SC/);
      }
    }
  });

  it("actually fails a pair that is below its requirement (the gate is not vacuous)", () => {
    // Negative proof of the evaluator itself. The gate was also proven negatively against real
    // tokens during Step 02: its first run reported 38 genuine failures (mostly
    // `palette.border` and `status.*.border` against `.paper`/`.elevated`, plus a single-colour
    // focus ring), which is why `solveUiLineColor`/`worstCaseSurface` and the two-tone focus
    // treatment exist at all.
    const results = evaluatePairs([
      {
        label: "mid grey on white",
        foreground: "#999999",
        background: "#ffffff",
        required: AA_NORMAL_TEXT,
        reason: "synthetic",
      },
      {
        label: "near-white on white",
        foreground: "#fdfdfd",
        background: "#ffffff",
        required: AA_NON_TEXT,
        reason: "synthetic",
      },
      {
        label: "black on white",
        foreground: "#000000",
        background: "#ffffff",
        required: AA_NORMAL_TEXT,
        reason: "synthetic",
      },
    ]);
    expect(results.map((result) => result.passed)).toEqual([false, false, true]);
  });

  it("keeps the focus ring's two-tone treatment enforced, not waived", () => {
    for (const { name, mode } of allThemeModeCombinations()) {
      const labels = contrastPairsFor(getThemeTokens(name, mode)).map((pair) => pair.label);
      expect(labels).toContain("palette.focusRingHalo on palette.focusRing");
      expect(labels).toContain("palette.focusRing on background.default");
    }
  });
});
