// Token values that are deliberately NOT theme-expressive, plus the type scale all
// three themes share.
//
// 20_DESIGN_SYSTEM_AND_THEMES.md fixes spacing as a constant: "base unit (8px grid,
// shared across themes - spacing rhythm is a usability constant, not a theme
// expression)". The typographic *scale* (sizes/line-heights) is shared for the same
// reason - what varies per theme is the face, the weight, and where the display face
// is allowed, all of which live in each theme module.

import type { BccSpacingTokens, BccTypographyTokens } from "./types.js";

export const SHARED_SPACING: BccSpacingTokens = {
  baseUnit: 8,
  touchTarget: 44,
  page: { mobile: 16, desktop: 24 },
  section: 32,
  card: 16,
  inline: 8,
};

/**
 * A 1.25 major-third-ish ramp anchored at 1rem body text. Sizes are rem so a user's
 * browser font-size setting scales the whole UI (WCAG 1.4.4 resize text).
 */
export const SHARED_TYPE_SCALE: BccTypographyTokens["scale"] = {
  h1: { fontSize: "2.125rem", lineHeight: 1.2, fontWeight: 700, letterSpacing: "-0.01em", display: true },
  h2: { fontSize: "1.75rem", lineHeight: 1.25, fontWeight: 700, letterSpacing: "-0.008em", display: true },
  h3: { fontSize: "1.5rem", lineHeight: 1.3, fontWeight: 600, letterSpacing: "-0.005em", display: true },
  h4: { fontSize: "1.25rem", lineHeight: 1.35, fontWeight: 600, letterSpacing: "0em", display: true },
  h5: { fontSize: "1.125rem", lineHeight: 1.4, fontWeight: 600, letterSpacing: "0em" },
  h6: { fontSize: "1rem", lineHeight: 1.45, fontWeight: 600, letterSpacing: "0em" },
  subtitle1: { fontSize: "1rem", lineHeight: 1.5, fontWeight: 500, letterSpacing: "0em" },
  subtitle2: { fontSize: "0.875rem", lineHeight: 1.5, fontWeight: 500, letterSpacing: "0.005em" },
  body1: { fontSize: "1rem", lineHeight: 1.55, fontWeight: 400, letterSpacing: "0em" },
  body2: { fontSize: "0.875rem", lineHeight: 1.55, fontWeight: 400, letterSpacing: "0.005em" },
  button: {
    fontSize: "0.9375rem",
    lineHeight: 1.4,
    fontWeight: 600,
    letterSpacing: "0.01em",
    textTransform: "none",
  },
  caption: { fontSize: "0.8125rem", lineHeight: 1.45, fontWeight: 400, letterSpacing: "0.01em" },
  overline: {
    fontSize: "0.75rem",
    lineHeight: 1.4,
    fontWeight: 600,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
  },
  heroNumber: {
    fontSize: "2.75rem",
    lineHeight: 1.05,
    fontWeight: 700,
    letterSpacing: "-0.02em",
    display: true,
  },
};

/**
 * No web font is downloaded. 20_DESIGN_SYSTEM_AND_THEMES.md §Illustration/branding note
 * defers asset production (which includes licensed brand faces) to a user decision, and
 * a self-hosted font is an asset this architecture does not produce. Each theme
 * therefore expresses its face through a system-font stack; swapping in a real licensed
 * family later is a one-line change per theme module and nothing else.
 */
export const SYSTEM_SANS_STACK =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** A broadly-available humanist face with more character than the default UI sans. */
export const SYSTEM_DISPLAY_STACK =
  '"Trebuchet MS", "Segoe UI Semibold", "Lucida Grande", system-ui, sans-serif';

export const SYSTEM_MONO_STACK =
  'ui-monospace, "SF Mono", "Cascadia Mono", "Segoe UI Mono", "Roboto Mono", Menlo, monospace';
