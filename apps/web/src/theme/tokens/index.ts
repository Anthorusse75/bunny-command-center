// The token registry: the one place that maps a theme name to its token set.
//
// Anything that needs "all 9 combinations" (the contrast gate, the pre-paint style
// generator, the theme-matrix tests, the browser suite) enumerates from here, so a
// fourth theme could never be half-wired.

import { heroicTokens } from "./heroic.js";
import { premiumTokens } from "./premium.js";
import { fusionTokens } from "./fusion.js";
import {
  BCC_MODES,
  BCC_THEME_NAMES,
  type BccMode,
  type BccThemeName,
  type BccThemeTokenSet,
  type BccThemeTokens,
} from "./types.js";

export const BCC_THEME_TOKENS: Readonly<Record<BccThemeName, BccThemeTokenSet>> = {
  heroic: heroicTokens,
  premium: premiumTokens,
  fusion: fusionTokens,
};

export function getThemeTokens(name: BccThemeName, mode: BccMode): BccThemeTokens {
  return BCC_THEME_TOKENS[name][mode];
}

/** Every theme x resolved-mode pair, in a stable order. */
export function allThemeModeCombinations(): { name: BccThemeName; mode: BccMode }[] {
  return BCC_THEME_NAMES.flatMap((name) => BCC_MODES.map((mode) => ({ name, mode })));
}

export * from "./types.js";
export { heroicTokens, premiumTokens, fusionTokens };
