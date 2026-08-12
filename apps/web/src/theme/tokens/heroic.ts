// HEROIC theme tokens.
//
// 20_DESIGN_SYSTEM_AND_THEMES.md's per-category brief for this theme:
//   Typography  - "a display face for headings"
//   Radius      - "sharper/angular accents on cards"
//   Surfaces    - "higher-contrast layered surfaces with a subtle glow on interactive
//                  elements"
//   Icons       - "filled/bold icon set"
//   Motion      - "slightly more pronounced transitions/micro-interactions"
//   Illustration- "Hero-Wars-adjacent iconography/illustration set (never the
//                  'Hero Wars' name/branding itself - visual reference only, per D-001)"
//
// ADR-015 §Risks names this theme specifically: "'Heroic' (gaming-styled) risks failing
// contrast/accessibility requirements if visual flair is prioritized over legibility."
// Its palette is therefore built on a warm high-contrast base rather than the low-
// contrast dark-on-dark look the genre invites, and the CI contrast gate covers it
// identically to the other two.

import { buildStatusTokens, focusRingHaloFor, solveUiLineColor } from "./primitives.js";
import {
  SHARED_SPACING,
  SHARED_TYPE_SCALE,
  SYSTEM_DISPLAY_STACK,
  SYSTEM_MONO_STACK,
  SYSTEM_SANS_STACK,
} from "./shared.js";
import type { BccThemeTokenSet, BccThemeTokens } from "./types.js";

const LIGHT_SURFACES = { default: "#f4efe4", paper: "#fffcf5", elevated: "#ffffff" };
const DARK_SURFACES = { default: "#100e0a", paper: "#1a1711", elevated: "#241f17" };

const LIGHT_SURFACE_LIST = Object.values(LIGHT_SURFACES);
const DARK_SURFACE_LIST = Object.values(DARK_SURFACES);

/** Heroic's warm neutral (parchment/bronze) and its crimson accent hue. */
const NEUTRAL_HUE = 36;
const ACCENT_HUE = 6;

const typography: BccThemeTokens["typography"] = {
  fontFamilyBody: SYSTEM_SANS_STACK,
  fontFamilyDisplay: SYSTEM_DISPLAY_STACK,
  displayFaceUsage: "all-headings",
  fontFamilyMono: SYSTEM_MONO_STACK,
  weight: { regular: 400, medium: 500, semibold: 600, bold: 800, display: 700 },
  scale: SHARED_TYPE_SCALE,
};

const radius: BccThemeTokens["radius"] = {
  none: 0,
  sm: 2,
  md: 4,
  lg: 6,
  pill: 999,
  card: 4,
  // "Sharper/angular accents on cards": the accent corner is square.
  accentCorner: 0,
  emphasisShape: "angular",
};

const motion: BccThemeTokens["motion"] = {
  intensity: "pronounced",
  duration: { instant: 0, fast: 160, normal: 260, slow: 380, celebration: 620 },
  easing: {
    standard: "cubic-bezier(0.2, 0, 0, 1)",
    emphasized: "cubic-bezier(0.16, 1, 0.3, 1)",
    decelerate: "cubic-bezier(0.05, 0.7, 0.1, 1)",
    accelerate: "cubic-bezier(0.3, 0, 0.8, 0.15)",
    celebration: "cubic-bezier(0.34, 1.56, 0.64, 1)",
  },
};

const icons: BccThemeTokens["icons"] = {
  variant: "filled",
  size: { sm: 20, md: 24, lg: 32 },
  emphasis: 1.15,
};

const light: BccThemeTokens = {
  name: "heroic",
  mode: "light",
  palette: {
    primary: { main: "#a32319", contrastText: "#ffffff" },
    secondary: { main: "#7a5100", contrastText: "#ffffff" },
    background: LIGHT_SURFACES,
    text: { primary: "#1e1608", secondary: "#544631", disabled: "#8d8271" },
    divider: "#e3d8c3",
    border: solveUiLineColor(NEUTRAL_HUE, 0.2, "light", LIGHT_SURFACE_LIST),
    focusRing: solveUiLineColor(ACCENT_HUE, 0.78, "light", LIGHT_SURFACE_LIST),
    focusRingHalo: focusRingHaloFor("light"),
    scrim: "#120e06",
  },
  status: buildStatusTokens("light", { saturationScale: 1.1, surfaces: LIGHT_SURFACE_LIST }),
  typography,
  spacing: SHARED_SPACING,
  radius,
  surfaces: {
    shadow: {
      none: "none",
      card: "0 2px 0 rgba(58, 42, 12, 0.18), 0 2px 8px rgba(58, 42, 12, 0.10)",
      raised: "0 3px 0 rgba(58, 42, 12, 0.22), 0 4px 12px rgba(58, 42, 12, 0.14)",
      overlay: "0 10px 30px rgba(40, 28, 6, 0.24)",
    },
    // "A subtle glow on interactive elements" - Heroic is the only theme where the glow
    // is not restricted to the primary CTA.
    glow: { scope: "interactive", shadow: "0 0 0 3px rgba(163, 35, 25, 0.18)" },
    action: { hoverOpacity: 0.08, selectedOpacity: 0.14, focusOpacity: 0.2, disabledOpacity: 0.38 },
  },
  icons,
  motion,
  illustration: {
    style: "heroic-adjacent",
    usage: "pervasive",
    accents: ["#a32319", "#7a5100", "#3f6b46"],
    motifOpacity: 0.1,
  },
};

const dark: BccThemeTokens = {
  name: "heroic",
  mode: "dark",
  palette: {
    primary: { main: "#f4705a", contrastText: "#25090a" },
    secondary: { main: "#f0c063", contrastText: "#241a02" },
    background: DARK_SURFACES,
    text: { primary: "#f5eedf", secondary: "#c3b79f", disabled: "#7c7260" },
    divider: "#2e2921",
    border: solveUiLineColor(NEUTRAL_HUE, 0.2, "dark", DARK_SURFACE_LIST),
    // Heroic's ring is gold rather than crimson: crimson on a near-black canvas needs to
    // be pushed so light it stops reading as the theme's primary colour.
    focusRing: solveUiLineColor(42, 0.85, "dark", DARK_SURFACE_LIST),
    focusRingHalo: focusRingHaloFor("dark"),
    scrim: "#050403",
  },
  status: buildStatusTokens("dark", { saturationScale: 1.1, surfaces: DARK_SURFACE_LIST }),
  typography,
  spacing: SHARED_SPACING,
  radius,
  surfaces: {
    shadow: {
      none: "none",
      card: "0 2px 0 rgba(0, 0, 0, 0.6), 0 2px 8px rgba(0, 0, 0, 0.5)",
      raised: "0 3px 0 rgba(0, 0, 0, 0.65), 0 4px 12px rgba(0, 0, 0, 0.55)",
      overlay: "0 10px 30px rgba(0, 0, 0, 0.7)",
    },
    glow: { scope: "interactive", shadow: "0 0 0 3px rgba(244, 112, 90, 0.28)" },
    action: { hoverOpacity: 0.12, selectedOpacity: 0.2, focusOpacity: 0.26, disabledOpacity: 0.38 },
  },
  icons,
  motion,
  illustration: {
    style: "heroic-adjacent",
    usage: "pervasive",
    accents: ["#f4705a", "#f0c063", "#7fc08c"],
    motifOpacity: 0.12,
  },
};

export const heroicTokens: BccThemeTokenSet = { light, dark };
