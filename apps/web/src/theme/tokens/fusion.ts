// FUSION theme tokens - the default theme (D-017,
// 20_DESIGN_SYSTEM_AND_THEMES.md §Default theme).
//
// Fusion is defined by that document strictly as a *composition* of the other two, so
// every category below states which parent it takes and where it deviates:
//   Typography  - "Premium's sans + Heroic's display face for hero numbers/section
//                  titles only"
//   Radius      - "Premium's rounding with Heroic accent corners on emphasis elements
//                  only"
//   Surfaces    - "Premium's restraint with Heroic's glow reserved for primary CTAs"
//   Icons       - "outlined by default, filled for primary actions"
//   Motion      - "Premium's speed with Heroic's easing curves on badge/achievement
//                  moments only"
//   Illustration- "a restrained blend, illustration used sparingly (empty states,
//                  onboarding) rather than pervasively"

import { buildStatusTokens, focusRingHaloFor, solveUiLineColor } from "./primitives.js";
import {
  SHARED_SPACING,
  SHARED_TYPE_SCALE,
  SYSTEM_DISPLAY_STACK,
  SYSTEM_MONO_STACK,
  SYSTEM_SANS_STACK,
} from "./shared.js";
import type { BccThemeTokenSet, BccThemeTokens } from "./types.js";

const LIGHT_SURFACES = { default: "#f6f7f9", paper: "#ffffff", elevated: "#ffffff" };
const DARK_SURFACES = { default: "#0d1117", paper: "#151b23", elevated: "#1d242e" };

const LIGHT_SURFACE_LIST = Object.values(LIGHT_SURFACES);
const DARK_SURFACE_LIST = Object.values(DARK_SURFACES);

/** Premium's cool neutral, with Fusion's own blue-teal accent hue. */
const NEUTRAL_HUE = 214;
const ACCENT_HUE = 205;

const typography: BccThemeTokens["typography"] = {
  // Premium's body face...
  fontFamilyBody: SYSTEM_SANS_STACK,
  // ...with Heroic's display face, restricted by `displayFaceUsage` to hero numbers and
  // section titles rather than every heading.
  fontFamilyDisplay: SYSTEM_DISPLAY_STACK,
  displayFaceUsage: "hero-and-section-titles",
  fontFamilyMono: SYSTEM_MONO_STACK,
  weight: { regular: 400, medium: 500, semibold: 600, bold: 700, display: 700 },
  scale: SHARED_TYPE_SCALE,
};

const radius: BccThemeTokens["radius"] = {
  none: 0,
  sm: 6,
  md: 10,
  lg: 14,
  // Premium's rounding for ordinary cards...
  card: 12,
  pill: 999,
  // ...and Heroic's angular corner, available only to emphasis elements.
  accentCorner: 2,
  emphasisShape: "hybrid",
};

const motion: BccThemeTokens["motion"] = {
  intensity: "balanced",
  // Premium's speed.
  duration: { instant: 0, fast: 120, normal: 180, slow: 240, celebration: 520 },
  easing: {
    standard: "cubic-bezier(0.4, 0, 0.2, 1)",
    emphasized: "cubic-bezier(0.3, 0, 0.2, 1)",
    decelerate: "cubic-bezier(0, 0, 0.2, 1)",
    accelerate: "cubic-bezier(0.4, 0, 1, 1)",
    // Heroic's curve, celebration moments only.
    celebration: "cubic-bezier(0.34, 1.56, 0.64, 1)",
  },
};

const icons: BccThemeTokens["icons"] = {
  variant: "outlined-filled-primary",
  size: { sm: 18, md: 22, lg: 28 },
  emphasis: 1.05,
};

const light: BccThemeTokens = {
  name: "fusion",
  mode: "light",
  palette: {
    primary: { main: "#1f5074", contrastText: "#ffffff" },
    // Heroic's gold, deepened until white text on it is AA-legible.
    secondary: { main: "#7d5300", contrastText: "#ffffff" },
    background: LIGHT_SURFACES,
    text: { primary: "#151a21", secondary: "#4a5462", disabled: "#959daa" },
    divider: "#e2e6ec",
    border: solveUiLineColor(NEUTRAL_HUE, 0.13, "light", LIGHT_SURFACE_LIST),
    focusRing: solveUiLineColor(ACCENT_HUE, 0.72, "light", LIGHT_SURFACE_LIST),
    focusRingHalo: focusRingHaloFor("light"),
    scrim: "#0a0f16",
  },
  status: buildStatusTokens("light", { saturationScale: 0.95, surfaces: LIGHT_SURFACE_LIST }),
  typography,
  spacing: SHARED_SPACING,
  radius,
  surfaces: {
    // Premium's restraint.
    shadow: {
      none: "none",
      card: "0 1px 2px rgba(13, 17, 23, 0.06), 0 1px 3px rgba(13, 17, 23, 0.04)",
      raised: "0 2px 6px rgba(13, 17, 23, 0.09)",
      overlay: "0 8px 24px rgba(13, 17, 23, 0.13)",
    },
    // Heroic's glow, primary CTA only.
    glow: { scope: "primary-cta", shadow: "0 0 0 3px rgba(31, 80, 116, 0.16)" },
    action: { hoverOpacity: 0.05, selectedOpacity: 0.1, focusOpacity: 0.14, disabledOpacity: 0.38 },
  },
  icons,
  motion,
  illustration: {
    style: "restrained-blend",
    usage: "sparing",
    accents: ["#1f5074", "#7d5300", "#98a2ae"],
    motifOpacity: 0.06,
  },
};

const dark: BccThemeTokens = {
  name: "fusion",
  mode: "dark",
  palette: {
    primary: { main: "#8ebde8", contrastText: "#07121c" },
    secondary: { main: "#e6bb6c", contrastText: "#241a08" },
    background: DARK_SURFACES,
    text: { primary: "#e8edf4", secondary: "#a5b1c0", disabled: "#68727f" },
    divider: "#252d38",
    border: solveUiLineColor(NEUTRAL_HUE, 0.13, "dark", DARK_SURFACE_LIST),
    focusRing: solveUiLineColor(ACCENT_HUE, 0.72, "dark", DARK_SURFACE_LIST),
    focusRingHalo: focusRingHaloFor("dark"),
    scrim: "#04070b",
  },
  status: buildStatusTokens("dark", { saturationScale: 0.95, surfaces: DARK_SURFACE_LIST }),
  typography,
  spacing: SHARED_SPACING,
  radius,
  surfaces: {
    shadow: {
      none: "none",
      card: "0 1px 2px rgba(0, 0, 0, 0.5)",
      raised: "0 2px 6px rgba(0, 0, 0, 0.55)",
      overlay: "0 8px 24px rgba(0, 0, 0, 0.65)",
    },
    glow: { scope: "primary-cta", shadow: "0 0 0 3px rgba(142, 189, 232, 0.24)" },
    action: { hoverOpacity: 0.09, selectedOpacity: 0.16, focusOpacity: 0.22, disabledOpacity: 0.38 },
  },
  icons,
  motion,
  illustration: {
    style: "restrained-blend",
    usage: "sparing",
    accents: ["#8ebde8", "#e6bb6c", "#4a5461"],
    motifOpacity: 0.08,
  },
};

export const fusionTokens: BccThemeTokenSet = { light, dark };
