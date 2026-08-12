// WCAG 2.2 contrast maths. Pure functions, no DOM, no theme knowledge.
//
// Implements the relative-luminance and contrast-ratio definitions from WCAG 2.2
// (https://www.w3.org/TR/WCAG22/#dfn-relative-luminance,
//  https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio) rather than trusting a
// third-party colour library, so the gate DASHBOARD/28_ACCESSIBILITY.md §Contrast
// requires has no dependency that could silently change its rounding.

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** AA thresholds from 28_ACCESSIBILITY.md §Contrast. */
export const AA_NORMAL_TEXT = 4.5;
export const AA_LARGE_TEXT = 3;
export const AA_NON_TEXT = 3;

const HEX_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function parseHexColor(hex: string): Rgb {
  if (!HEX_PATTERN.test(hex)) {
    throw new TypeError(
      `Expected a #rgb or #rrggbb colour, got "${hex}". Tokens are deliberately restricted to opaque hex so the contrast gate can evaluate every one of them.`,
    );
  }
  const body = hex.slice(1);
  const full =
    body.length === 3
      ? body
          .split("")
          .map((char) => char + char)
          .join("")
      : body;
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

function channelLuminance(value255: number): number {
  const channel = value255 / 255;
  return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(color: string | Rgb): number {
  const { r, g, b } = typeof color === "string" ? parseHexColor(color) : color;
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

export function contrastRatio(a: string | Rgb, b: string | Rgb): number {
  const luminanceA = relativeLuminance(a);
  const luminanceB = relativeLuminance(b);
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Rounded down to 2dp so a reported "4.50" can never be a rounded-up 4.497. */
export function formatRatio(ratio: number): string {
  return (Math.floor(ratio * 100) / 100).toFixed(2);
}

export function meetsRatio(foreground: string, background: string, required: number): boolean {
  return contrastRatio(foreground, background) >= required;
}
