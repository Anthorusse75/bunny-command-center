// PREMIUM theme tokens.
//
// 20_DESIGN_SYSTEM_AND_THEMES.md's per-category brief for this theme:
//   Typography  - "a refined sans throughout" (so no display face at all)
//   Radius      - "consistent moderate rounding"
//   Surfaces    - "flat, restrained shadows"
//   Icons       - "outlined/light icon set"
//   Motion      - "minimal, fast, subdued"
//   Illustration- "abstract/geometric"

import { buildStatusTokens, focusRingHaloFor, solveUiLineColor } from "./primitives.js";
import { SHARED_SPACING, SHARED_TYPE_SCALE, SYSTEM_MONO_STACK, SYSTEM_SANS_STACK } from "./shared.js";
import type { BccThemeTokenSet, BccThemeTokens } from "./types.js";

const LIGHT_SURFACES = { default: "#f5f7fa", paper: "#ffffff", elevated: "#ffffff" };
const DARK_SURFACES = { default: "#0e1218", paper: "#161c25", elevated: "#1e2530" };

const LIGHT_SURFACE_LIST = Object.values(LIGHT_SURFACES);
const DARK_SURFACE_LIST = Object.values(DARK_SURFACES);

/** Premium's cool neutral (slate) and its indigo accent hue. */
const NEUTRAL_HUE = 215;
const ACCENT_HUE = 222;

const typography: BccThemeTokens["typography"] = {
  fontFamilyBody: SYSTEM_SANS_STACK,
  // Premium is a single refined sans "throughout": the display slot resolves to the
  // same family, and `displayFaceUsage: "none"` is what components check before
  // reaching for it, so the theme can never accidentally introduce a second face.
  fontFamilyDisplay: SYSTEM_SANS_STACK,
  fontFamilyMono: SYSTEM_MONO_STACK,
  displayFaceUsage: "none",
  weight: { regular: 400, medium: 500, semibold: 600, bold: 700, display: 600 },
  scale: SHARED_TYPE_SCALE,
};

const radius: BccThemeTokens["radius"] = {
  none: 0,
  sm: 6,
  md: 10,
  lg: 14,
  pill: 999,
  card: 12,
  // "Consistent moderate rounding": the accent corner is not a different shape.
  accentCorner: 12,
  emphasisShape: "rounded",
};

const motion: BccThemeTokens["motion"] = {
  intensity: "subdued",
  duration: { instant: 0, fast: 120, normal: 180, slow: 240, celebration: 240 },
  easing: {
    standard: "cubic-bezier(0.4, 0, 0.2, 1)",
    emphasized: "cubic-bezier(0.3, 0, 0.2, 1)",
    decelerate: "cubic-bezier(0, 0, 0.2, 1)",
    accelerate: "cubic-bezier(0.4, 0, 1, 1)",
    // Premium keeps its own restrained curve even for celebrations.
    celebration: "cubic-bezier(0.4, 0, 0.2, 1)",
  },
};

const icons: BccThemeTokens["icons"] = {
  variant: "outlined",
  size: { sm: 18, md: 22, lg: 28 },
  emphasis: 1,
};

const light: BccThemeTokens = {
  name: "premium",
  mode: "light",
  palette: {
    primary: { main: "#2b4c9b", contrastText: "#ffffff" },
    secondary: { main: "#6b4c9a", contrastText: "#ffffff" },
    background: LIGHT_SURFACES,
    text: { primary: "#161c24", secondary: "#4c5666", disabled: "#98a1ae" },
    divider: "#e1e5eb",
    border: solveUiLineColor(NEUTRAL_HUE, 0.14, "light", LIGHT_SURFACE_LIST),
    focusRing: solveUiLineColor(ACCENT_HUE, 0.8, "light", LIGHT_SURFACE_LIST),
    focusRingHalo: focusRingHaloFor("light"),
    scrim: "#0b1017",
  },
  status: buildStatusTokens("light", { saturationScale: 0.85, surfaces: LIGHT_SURFACE_LIST }),
  typography,
  spacing: SHARED_SPACING,
  radius,
  surfaces: {
    shadow: {
      none: "none",
      card: "0 1px 2px rgba(16, 24, 40, 0.06), 0 1px 3px rgba(16, 24, 40, 0.04)",
      raised: "0 2px 6px rgba(16, 24, 40, 0.08)",
      overlay: "0 8px 24px rgba(16, 24, 40, 0.12)",
    },
    // "Flat, restrained shadows" - no glow anywhere in Premium.
    glow: { scope: "none", shadow: "none" },
    action: { hoverOpacity: 0.04, selectedOpacity: 0.08, focusOpacity: 0.12, disabledOpacity: 0.38 },
  },
  icons,
  motion,
  illustration: {
    style: "abstract-geometric",
    usage: "sparing",
    accents: ["#2b4c9b", "#6b4c9a", "#9aa4b2"],
    motifOpacity: 0.06,
  },
};

const dark: BccThemeTokens = {
  name: "premium",
  mode: "dark",
  palette: {
    primary: { main: "#9dbcf7", contrastText: "#0b1220" },
    secondary: { main: "#c8aef2", contrastText: "#150f28" },
    background: DARK_SURFACES,
    text: { primary: "#e9edf3", secondary: "#a7b2c1", disabled: "#697382" },
    divider: "#262e3a",
    border: solveUiLineColor(NEUTRAL_HUE, 0.14, "dark", DARK_SURFACE_LIST),
    focusRing: solveUiLineColor(ACCENT_HUE, 0.8, "dark", DARK_SURFACE_LIST),
    focusRingHalo: focusRingHaloFor("dark"),
    scrim: "#04070c",
  },
  status: buildStatusTokens("dark", { saturationScale: 0.85, surfaces: DARK_SURFACE_LIST }),
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
    glow: { scope: "none", shadow: "none" },
    action: { hoverOpacity: 0.08, selectedOpacity: 0.14, focusOpacity: 0.2, disabledOpacity: 0.38 },
  },
  icons,
  motion,
  illustration: {
    style: "abstract-geometric",
    usage: "sparing",
    accents: ["#9dbcf7", "#c8aef2", "#4b5563"],
    motifOpacity: 0.08,
  },
};

export const premiumTokens: BccThemeTokenSet = { light, dark };
