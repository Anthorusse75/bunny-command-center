// The explicit, auditable list of colour pairs every theme x mode must satisfy.
//
// DASHBOARD/28_ACCESSIBILITY.md §Contrast: "Every theme x mode combination (9 total)
// passes WCAG 2.2 AA contrast ratios (4.5:1 normal text, 3:1 large text/meaningful UI
// components), verified by an automated contrast-check test in CI, not a one-time manual
// check". 20_DESIGN_SYSTEM_AND_THEMES.md §Accessibility floor repeats it as a ship gate:
// "a theme cannot ship if it fails this check, regardless of how it looks."
//
// Enumerated by hand rather than by walking the token tree, because the *required ratio*
// depends on what a colour is used for, which no automatic walk can know. Anything
// deliberately excluded is listed at the bottom with its WCAG justification.

import { AA_NON_TEXT, AA_NORMAL_TEXT, contrastRatio } from "./contrast.js";
import { getThemeTokens, type BccMode, type BccThemeName, type BccThemeTokens } from "./tokens/index.js";
import { STATUS_TONES } from "@bunny-command-center/shared";

export interface ContrastPair {
  /** Human-readable `foreground on background` description used in gate output. */
  label: string;
  foreground: string;
  background: string;
  required: number;
  /** Why this ratio, so a reviewer can check the requirement not just the number. */
  reason: string;
}

export interface ContrastResult extends ContrastPair {
  ratio: number;
  passed: boolean;
}

const SURFACES = ["default", "paper", "elevated"] as const;

export function contrastPairsFor(tokens: BccThemeTokens): ContrastPair[] {
  const { palette, status } = tokens;
  const pairs: ContrastPair[] = [];

  for (const surface of SURFACES) {
    const background = palette.background[surface];
    pairs.push({
      label: `text.primary on background.${surface}`,
      foreground: palette.text.primary,
      background,
      required: AA_NORMAL_TEXT,
      reason: "Body copy. WCAG 2.2 SC 1.4.3 normal text.",
    });
    pairs.push({
      label: `text.secondary on background.${surface}`,
      foreground: palette.text.secondary,
      background,
      required: AA_NORMAL_TEXT,
      reason:
        "Secondary copy is still body text (captions, helper text), not decoration - the same 4.5:1 applies.",
    });
    pairs.push({
      label: `palette.border on background.${surface}`,
      foreground: palette.border,
      background,
      required: AA_NON_TEXT,
      reason:
        "Input outlines and chip borders identify a UI component's boundary. WCAG 2.2 SC 1.4.11 non-text contrast.",
    });
    pairs.push({
      label: `palette.focusRing on background.${surface}`,
      foreground: palette.focusRing,
      background,
      required: AA_NON_TEXT,
      reason:
        "28_ACCESSIBILITY.md §Focus management calls a themed focus ring an easy accidental-contrast-failure point. SC 1.4.11.",
    });
    pairs.push({
      label: `palette.primary.main on background.${surface}`,
      foreground: palette.primary.main,
      background,
      required: AA_NON_TEXT,
      reason: "Primary CTA fill must be distinguishable from the surface behind it. SC 1.4.11.",
    });
    pairs.push({
      label: `palette.secondary.main on background.${surface}`,
      foreground: palette.secondary.main,
      background,
      required: AA_NON_TEXT,
      reason: "Secondary accent fill. SC 1.4.11.",
    });
  }

  pairs.push({
    label: "palette.primary.contrastText on palette.primary.main",
    foreground: palette.primary.contrastText,
    background: palette.primary.main,
    required: AA_NORMAL_TEXT,
    reason: "Label inside a filled primary button. SC 1.4.3.",
  });
  pairs.push({
    label: "palette.secondary.contrastText on palette.secondary.main",
    foreground: palette.secondary.contrastText,
    background: palette.secondary.main,
    required: AA_NORMAL_TEXT,
    reason: "Label inside a filled secondary button. SC 1.4.3.",
  });
  // The focus treatment is two-tone: the ring is drawn with an `outline-offset` gap so it
  // lands on the surface behind the component (covered by the per-surface pairs above),
  // and `focusRingHalo` is drawn immediately inside it so the ring is still delimited
  // when the component's own fill happens to sit close to the ring's colour. A single
  // ring colour provably cannot do both - it would have to contrast with a near-white
  // page AND with a dark filled button simultaneously - so this pair is what makes the
  // treatment sound, and it is enforced rather than waived.
  pairs.push({
    label: "palette.focusRingHalo on palette.focusRing",
    foreground: palette.focusRingHalo,
    background: palette.focusRing,
    required: AA_NON_TEXT,
    reason:
      "28_ACCESSIBILITY.md §Focus management: the ring must stay visible against any component fill; the halo is what guarantees it. SC 1.4.11.",
  });

  for (const tone of STATUS_TONES) {
    const color = status[tone];
    pairs.push({
      label: `status.${tone}.contrastText on status.${tone}.main`,
      foreground: color.contrastText,
      background: color.main,
      required: AA_NORMAL_TEXT,
      reason: "Solid status chip label. SC 1.4.3.",
    });
    pairs.push({
      label: `status.${tone}.onSurface on status.${tone}.surface`,
      foreground: color.onSurface,
      background: color.surface,
      required: AA_NORMAL_TEXT,
      reason: "Tinted status badge label - the default StatusBadge rendering. SC 1.4.3.",
    });
    for (const surface of SURFACES) {
      pairs.push({
        label: `status.${tone}.border on background.${surface}`,
        foreground: color.border,
        background: palette.background[surface],
        required: AA_NON_TEXT,
        reason:
          "28_ACCESSIBILITY.md §Color is never the sole state carrier: the badge outline is part of how a state is identified. SC 1.4.11.",
      });
      pairs.push({
        label: `status.${tone}.main on background.${surface}`,
        foreground: color.main,
        background: palette.background[surface],
        required: AA_NON_TEXT,
        reason: "Status dot/icon rendered directly on a surface. SC 1.4.11.",
      });
    }
  }

  return pairs;
}

/**
 * Pairs measured and reported but NOT enforced, each with the WCAG clause that exempts
 * it. Listed in code (rather than simply omitted) so an exemption is a visible, reviewed
 * decision instead of an absence nobody notices.
 */
export function informationalPairsFor(tokens: BccThemeTokens): ContrastPair[] {
  const { palette } = tokens;
  return [
    {
      label: "text.disabled on background.default",
      foreground: palette.text.disabled,
      background: palette.background.default,
      required: AA_NORMAL_TEXT,
      reason:
        "EXEMPT: WCAG 2.2 SC 1.4.3 excludes text that is part of an inactive user interface component. Reported so a regression is still visible.",
    },
    {
      label: "palette.divider on background.default",
      foreground: palette.divider,
      background: palette.background.default,
      required: AA_NON_TEXT,
      reason:
        "EXEMPT: WCAG 2.2 SC 1.4.11 excludes purely decorative parts. A divider hairline carries no state; component boundaries use palette.border, which IS enforced.",
    },
  ];
}

export function evaluatePairs(pairs: readonly ContrastPair[]): ContrastResult[] {
  return pairs.map((pair) => {
    const ratio = contrastRatio(pair.foreground, pair.background);
    return { ...pair, ratio, passed: ratio >= pair.required };
  });
}

export function evaluateThemeMode(
  name: BccThemeName,
  mode: BccMode,
): { required: ContrastResult[]; informational: ContrastResult[] } {
  const tokens = getThemeTokens(name, mode);
  return {
    required: evaluatePairs(contrastPairsFor(tokens)),
    informational: evaluatePairs(informationalPairsFor(tokens)),
  };
}
