// Colour primitives: the only place in the design system where colour is *computed*
// rather than semantic, and (together with the three theme modules) the only place raw
// colour literals are allowed to exist at all.
//
// Two jobs:
//  1. Hue-lock the status families. 20_DESIGN_SYSTEM_AND_THEMES.md requires
//     "the same underlying hue family across all 3 themes (a red is always recognizably
//     'error' red) with per-theme saturation/brightness tuning, never a different
//     semantic hue per theme". A shared hue table plus a per-theme saturation/lightness
//     tuning knob makes that structurally impossible to violate - a theme cannot pick a
//     different hue for `error` because it never supplies a hue at all.
//  2. Make AA contrast true by construction, not by luck. Each status role's lightness
//     is *solved* for its required ratio instead of being eyeballed, so the CI contrast
//     gate (28_ACCESSIBILITY.md §Contrast) verifies an independent claim rather than
//     re-deriving the same guess.

import { AA_NON_TEXT, AA_NORMAL_TEXT, contrastRatio, relativeLuminance } from "../contrast.js";
import type { BccMode, BccStatusColor, BccStatusTokens } from "./types.js";

/**
 * Hue angles shared by all three themes. The first four are the families
 * 20_DESIGN_SYSTEM_AND_THEMES.md names; `pending`/`progress`/`neutral` are the Step-02
 * additions documented on `BccStatusTokens`.
 */
export const STATUS_HUES = {
  success: 148,
  warning: 38,
  error: 2,
  info: 205,
  pending: 272,
  progress: 188,
  neutral: 215,
} as const satisfies Record<keyof BccStatusTokens, number>;

/** Base saturation per family, before the per-theme multiplier. */
const STATUS_BASE_SATURATION = {
  success: 0.55,
  warning: 0.82,
  error: 0.68,
  info: 0.62,
  pending: 0.42,
  progress: 0.55,
  neutral: 0.12,
} as const satisfies Record<keyof BccStatusTokens, number>;

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** `h` in degrees, `s`/`l` in 0..1. Returns an opaque `#rrggbb`. */
export function hslToHex(hue: number, saturation: number, lightness: number): string {
  const h = ((hue % 360) + 360) % 360;
  const s = clamp01(saturation);
  const l = clamp01(lightness);
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hPrime = h / 60;
  const x = c * (1 - Math.abs((hPrime % 2) - 1));
  const [r1, g1, b1] =
    hPrime < 1
      ? [c, x, 0]
      : hPrime < 2
        ? [x, c, 0]
        : hPrime < 3
          ? [0, c, x]
          : hPrime < 4
            ? [0, x, c]
            : hPrime < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = l - c / 2;
  const toHex = (value: number): string =>
    Math.round(clamp01(value + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`;
}

/**
 * Walks lightness in 1% steps from `startLightness` in `direction` until the colour
 * reaches `required` contrast against `against`. Returns the first qualifying hex, or -
 * if the whole range is exhausted - the extreme end, which the CI gate then reports as
 * a genuine failure rather than silently accepting a near-miss.
 */
export function solveForContrast(
  hue: number,
  saturation: number,
  startLightness: number,
  direction: -1 | 1,
  against: string,
  required: number,
): string {
  for (let step = 0; step <= 100; step += 1) {
    const lightness = startLightness + direction * step * 0.01;
    if (lightness < 0 || lightness > 1) {
      break;
    }
    const candidate = hslToHex(hue, saturation, lightness);
    if (contrastRatio(candidate, against) >= required) {
      return candidate;
    }
  }
  return hslToHex(hue, saturation, direction === -1 ? 0 : 1);
}

export interface StatusTuning {
  /** Multiplies every family's base saturation. Heroic > Fusion > Premium. */
  saturationScale: number;
  /**
   * Every surface a status colour can be drawn on (`background.default`, `.paper`,
   * `.elevated`). Solving against the *worst-case* surface rather than just the page
   * canvas is what makes a badge legible inside a dialog too - the first version of this
   * file solved against `default` only and the gate caught eight real failures on
   * `.paper`/`.elevated` in dark mode.
   */
  surfaces: readonly string[];
}

/**
 * The surface a foreground of the given mode has the *least* contrast against: the
 * darkest surface for a dark-on-light foreground, the lightest for light-on-dark.
 */
export function worstCaseSurface(mode: BccMode, surfaces: readonly string[]): string {
  const sorted = [...surfaces].sort((a, b) => relativeLuminance(a) - relativeLuminance(b));
  return (mode === "light" ? sorted[0] : sorted[sorted.length - 1])!;
}

/**
 * A 1px line that identifies a UI component boundary or draws a focus ring: solved to
 * WCAG 2.2 SC 1.4.11's 3:1 against the worst-case surface, so no theme can ship an
 * invisible input outline or focus ring. 28_ACCESSIBILITY.md §Focus management asks for
 * exactly this ("checked, not assumed, since a themed focus ring is an easy
 * accidental-contrast-failure point").
 */
export function solveUiLineColor(
  hue: number,
  saturation: number,
  mode: BccMode,
  surfaces: readonly string[],
): string {
  const against = worstCaseSurface(mode, surfaces);
  return mode === "light"
    ? solveForContrast(hue, saturation, 0.5, -1, against, AA_NON_TEXT)
    : solveForContrast(hue, saturation, 0.5, 1, against, AA_NON_TEXT);
}

/**
 * The inner halo drawn between a focus ring and the component it surrounds, so the ring
 * stays visible even when the component's own fill happens to be close to the ring's
 * colour. A single-colour ring cannot contrast with both a near-white page and a dark
 * filled button at once, which is why the focus treatment is two-tone (see
 * ../createBccTheme.ts, where the ring is drawn with an `outline-offset` gap plus this
 * halo).
 */
export function focusRingHaloFor(mode: BccMode): string {
  return mode === "light" ? "#ffffff" : "#000000";
}

function buildStatusColor(
  family: keyof BccStatusTokens,
  mode: BccMode,
  tuning: StatusTuning,
): BccStatusColor {
  const hue = STATUS_HUES[family];
  const saturation = clamp01(STATUS_BASE_SATURATION[family] * tuning.saturationScale);
  const against = worstCaseSurface(mode, tuning.surfaces);

  if (mode === "light") {
    const contrastText = "#ffffff";
    // Darken from a mid tone until white text is AA-legible on the fill.
    const main = solveForContrast(hue, saturation, 0.46, -1, contrastText, AA_NORMAL_TEXT);
    const surface = hslToHex(hue, clamp01(saturation * 0.6), 0.94);
    const onSurface = solveForContrast(hue, saturation, 0.34, -1, surface, AA_NORMAL_TEXT);
    const border = solveForContrast(hue, clamp01(saturation * 0.8), 0.58, -1, against, AA_NON_TEXT);
    return { main, contrastText, surface, onSurface, border };
  }

  // Dark mode: the fill is a light tint, so its foreground is a deep tone of the same
  // hue. `main` has to satisfy two constraints at once - AA against its own text, and
  // 3:1 against the page canvas so a chip is still identifiable (WCAG 1.4.11) - so both
  // are solved and the lighter result wins.
  const contrastText = hslToHex(hue, clamp01(saturation * 0.55), 0.08);
  const mainForText = solveForContrast(hue, saturation, 0.55, 1, contrastText, AA_NORMAL_TEXT);
  const mainForCanvas = solveForContrast(hue, saturation, 0.55, 1, against, AA_NON_TEXT);
  const main = contrastRatio(mainForText, against) >= AA_NON_TEXT ? mainForText : mainForCanvas;
  const surface = hslToHex(hue, clamp01(saturation * 0.5), 0.17);
  const onSurface = solveForContrast(hue, clamp01(saturation * 0.7), 0.72, 1, surface, AA_NORMAL_TEXT);
  const border = solveForContrast(hue, clamp01(saturation * 0.65), 0.42, 1, against, AA_NON_TEXT);
  return { main, contrastText, surface, onSurface, border };
}

export function buildStatusTokens(mode: BccMode, tuning: StatusTuning): BccStatusTokens {
  return {
    success: buildStatusColor("success", mode, tuning),
    warning: buildStatusColor("warning", mode, tuning),
    error: buildStatusColor("error", mode, tuning),
    info: buildStatusColor("info", mode, tuning),
    pending: buildStatusColor("pending", mode, tuning),
    progress: buildStatusColor("progress", mode, tuning),
    neutral: buildStatusColor("neutral", mode, tuning),
  };
}
