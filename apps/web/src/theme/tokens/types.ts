// The single token schema. One interface, three implementations
// (heroic.ts / premium.ts / fusion.ts), each producing a light and a dark variant.
//
// Source of truth: DASHBOARD/20_DESIGN_SYSTEM_AND_THEMES.md §Token architecture -
// "One token schema (TypeScript interface `BccThemeTokens`), three implementations
// [...] each producing light+dark variants". Its table fixes the eight themed
// categories: Typography, Spacing, Radius, Surfaces/elevation, Icons, Status colors,
// Motion, Illustration style. Every one of those has a field group below; the
// `palette` group carries the base colours the categories are expressed against.
//
// ADR-015 fixes the factory signature and the CSS-variables strategy.

export const BCC_THEME_NAMES = ["heroic", "premium", "fusion"] as const;
export type BccThemeName = (typeof BCC_THEME_NAMES)[number];

/** A resolved colour scheme. `system` is a *preference*, never a resolved value. */
export const BCC_MODES = ["light", "dark"] as const;
export type BccMode = (typeof BCC_MODES)[number];

/** What the user actually chooses and what gets persisted (D-017: LIGHT/DARK/SYSTEM). */
export const BCC_MODE_PREFERENCES = ["light", "dark", "system"] as const;
export type BccModePreference = (typeof BCC_MODE_PREFERENCES)[number];

/**
 * D-017 / 20_DESIGN_SYSTEM_AND_THEMES.md §Default theme: "**Fusion** [...] confirmed
 * as the final decision here, not left open."
 */
export const DEFAULT_THEME_NAME: BccThemeName = "fusion";

/**
 * No document fixes the default *mode*. `system` is chosen because it is the only
 * value that respects a platform preference the user already expressed elsewhere,
 * and because D-017 lists SYSTEM as a first-class mode rather than an escape hatch.
 * Recorded here as a Step-02 engineering decision, not as a documented one.
 */
export const DEFAULT_MODE_PREFERENCE: BccModePreference = "system";

// ---------------------------------------------------------------------------
// Colour primitives
// ---------------------------------------------------------------------------

/** A colour pair that always travels together, so no call site invents a foreground. */
export interface BccColorPair {
  /** Background / fill colour, `#rrggbb`. */
  main: string;
  /** Foreground guaranteed to meet WCAG 2.2 AA against `main`. */
  contrastText: string;
}

export interface BccStatusColor extends BccColorPair {
  /** Tinted container fill for badges/banners. */
  surface: string;
  /** Foreground guaranteed to meet AA against `surface`. */
  onSurface: string;
  /** Border for the tinted container; meets 3:1 against the page background. */
  border: string;
}

// ---------------------------------------------------------------------------
// Category: Status colors
// ---------------------------------------------------------------------------

/**
 * 20_DESIGN_SYSTEM_AND_THEMES.md: "success/warning/error/info - same underlying hue
 * family across all 3 themes (a red is always recognizably 'error' red) with per-theme
 * saturation/brightness tuning, never a different semantic hue per theme".
 *
 * `pending`/`progress`/`neutral` are NOT in that document's list. They are a Step-02
 * addition, because a state machine has queued/running/unknown states that are none of
 * success/warning/error/info, and forcing them into one of the four would make a badge
 * lie about severity. Their hues are fixed here exactly as strictly as the documented
 * four, and the contrast gate covers them identically.
 */
export interface BccStatusTokens {
  success: BccStatusColor;
  warning: BccStatusColor;
  error: BccStatusColor;
  info: BccStatusColor;
  pending: BccStatusColor;
  progress: BccStatusColor;
  neutral: BccStatusColor;
}

// ---------------------------------------------------------------------------
// Base palette
// ---------------------------------------------------------------------------

export interface BccPaletteTokens {
  primary: BccColorPair;
  secondary: BccColorPair;
  background: {
    /** The page canvas. */
    default: string;
    /** Cards, sheets, the nav chrome. */
    paper: string;
    /** Raised surfaces above `paper` (menus, popovers, dialogs). */
    elevated: string;
  };
  text: {
    primary: string;
    secondary: string;
    /**
     * Disabled text. WCAG 2.2 SC 1.4.3 exempts "inactive user interface components"
     * from the contrast minimum, so this is deliberately excluded from the required
     * pair list in ../contrast-requirements.ts and reported informationally instead.
     */
    disabled: string;
  };
  /** Decorative hairline between rows/sections. */
  divider: string;
  /** Boundary of a real UI component (input outline, chip border): needs 3:1. */
  border: string;
  /**
   * 28_ACCESSIBILITY.md §Focus management: "a themed focus ring is an easy accidental
   * -contrast-failure point" - so it is a first-class token with its own gate entry
   * rather than MUI's default blue.
   */
  focusRing: string;
  /**
   * Inner halo drawn between the focus ring and the focused component. A single ring
   * colour cannot contrast with both a near-white page and a dark filled button, so the
   * focus treatment is two-tone; this is the half that guarantees the ring is still
   * distinguishable when it sits directly against a component's own fill.
   */
  focusRingHalo: string;
  /** Scrim behind modals/bottom sheets. */
  scrim: string;
}

// ---------------------------------------------------------------------------
// Category: Typography
// ---------------------------------------------------------------------------

export interface BccTypeStyle {
  /** rem string, so user font-size settings scale the UI. */
  fontSize: string;
  lineHeight: number;
  fontWeight: number;
  letterSpacing: string;
  /** When true the style renders in `fontFamilyDisplay` instead of the body face. */
  display?: boolean;
  textTransform?: "none" | "uppercase";
}

/**
 * Where each theme is allowed to use its display face.
 * 20_DESIGN_SYSTEM_AND_THEMES.md: Heroic uses "a display face for headings"; Premium
 * is "a refined sans throughout"; Fusion is "Premium's sans + Heroic's display face
 * for hero numbers/section titles only".
 */
export type BccDisplayFaceUsage = "none" | "all-headings" | "hero-and-section-titles";

export interface BccTypographyTokens {
  fontFamilyBody: string;
  fontFamilyDisplay: string;
  fontFamilyMono: string;
  displayFaceUsage: BccDisplayFaceUsage;
  weight: {
    regular: number;
    medium: number;
    semibold: number;
    bold: number;
    /** Weight the display face is set at. */
    display: number;
  };
  scale: {
    h1: BccTypeStyle;
    h2: BccTypeStyle;
    h3: BccTypeStyle;
    h4: BccTypeStyle;
    h5: BccTypeStyle;
    h6: BccTypeStyle;
    subtitle1: BccTypeStyle;
    subtitle2: BccTypeStyle;
    body1: BccTypeStyle;
    body2: BccTypeStyle;
    button: BccTypeStyle;
    caption: BccTypeStyle;
    overline: BccTypeStyle;
    /** Big single numbers (PremiumPlus counters, leaderboard ranks). */
    heroNumber: BccTypeStyle;
  };
}

// ---------------------------------------------------------------------------
// Category: Spacing
// ---------------------------------------------------------------------------

/**
 * 20_DESIGN_SYSTEM_AND_THEMES.md is explicit that spacing is NOT a theme expression:
 * "base unit (8px grid, shared across themes - spacing rhythm is a usability
 * constant, not a theme expression)". The interface exists so tokens stay
 * self-describing, but all three themes import the same frozen object from ./shared.ts.
 */
export interface BccSpacingTokens {
  baseUnit: 8;
  /**
   * 21_MOBILE_UX.md §Touch targets: "Minimum touch target: 44x44px [...] enforced as a
   * design-token constant (`spacing.touchTarget`)". The name is fixed by that document.
   */
  touchTarget: 44;
  page: { mobile: number; desktop: number };
  section: number;
  card: number;
  inline: number;
}

// ---------------------------------------------------------------------------
// Category: Radius
// ---------------------------------------------------------------------------

/**
 * Heroic: "sharper/angular accents on cards"; Premium: "consistent moderate rounding";
 * Fusion: "Premium's rounding with Heroic accent corners on emphasis elements only".
 */
export type BccEmphasisShape = "angular" | "rounded" | "hybrid";

export interface BccRadiusTokens {
  none: number;
  sm: number;
  md: number;
  lg: number;
  pill: number;
  /** Default card radius. */
  card: number;
  /**
   * Radius applied to the two "accent" corners of an emphasis element. For `angular`
   * and `hybrid` shapes this differs from `card`; for `rounded` it equals `card`.
   */
  accentCorner: number;
  emphasisShape: BccEmphasisShape;
}

// ---------------------------------------------------------------------------
// Category: Surfaces / elevation
// ---------------------------------------------------------------------------

/**
 * Heroic: "higher-contrast layered surfaces with a subtle glow on interactive
 * elements"; Premium: "flat, restrained shadows"; Fusion: "Premium's restraint with
 * Heroic's glow reserved for primary CTAs".
 */
export type BccGlowScope = "none" | "interactive" | "primary-cta";

export interface BccSurfaceTokens {
  /** MUI shadow ladder positions actually used by this design system. */
  shadow: {
    none: string;
    card: string;
    raised: string;
    overlay: string;
  };
  glow: {
    scope: BccGlowScope;
    /** `box-shadow` value applied in addition to the elevation shadow. */
    shadow: string;
  };
  /** Opacity of the hover/selected overlays MUI derives its action states from. */
  action: {
    hoverOpacity: number;
    selectedOpacity: number;
    focusOpacity: number;
    disabledOpacity: number;
  };
}

// ---------------------------------------------------------------------------
// Category: Icons
// ---------------------------------------------------------------------------

/**
 * Heroic: "filled/bold icon set"; Premium: "outlined/light icon set"; Fusion:
 * "outlined by default, filled for primary actions".
 */
export type BccIconVariant = "filled" | "outlined" | "outlined-filled-primary";

export interface BccIconTokens {
  variant: BccIconVariant;
  size: { sm: number; md: number; lg: number };
  /** Multiplier applied to the icon's optical weight (maps to font-weight/stroke). */
  emphasis: number;
}

// ---------------------------------------------------------------------------
// Category: Motion
// ---------------------------------------------------------------------------

/**
 * Heroic: "slightly more pronounced transitions"; Premium: "minimal, fast, subdued";
 * Fusion: "Premium's speed with Heroic's easing curves on badge/achievement moments
 * only". 28_ACCESSIBILITY.md §Reduced motion: the intensity dial never overrides
 * `prefers-reduced-motion: reduce`, which always wins.
 */
export type BccMotionIntensity = "pronounced" | "subdued" | "balanced";

export interface BccMotionTokens {
  intensity: BccMotionIntensity;
  duration: {
    instant: number;
    fast: number;
    normal: number;
    slow: number;
    /** Badge/achievement moments only. */
    celebration: number;
  };
  easing: {
    standard: string;
    emphasized: string;
    decelerate: string;
    accelerate: string;
    /** Applied only to celebration moments (Fusion borrows Heroic's curve here). */
    celebration: string;
  };
}

// ---------------------------------------------------------------------------
// Category: Illustration style
// ---------------------------------------------------------------------------

/**
 * Heroic: "Hero-Wars-adjacent iconography/illustration set (never the 'Hero Wars'
 * name/branding itself - visual reference only, per D-001)"; Premium:
 * "abstract/geometric"; Fusion: "a restrained blend, illustration used sparingly
 * (empty states, onboarding) rather than pervasively".
 *
 * Actual artwork is out of scope: 20_DESIGN_SYSTEM_AND_THEMES.md §Illustration/branding
 * note defers asset production to a user decision. These are the hooks a future asset
 * set is selected and tinted by, not the assets themselves.
 */
export type BccIllustrationStyle = "heroic-adjacent" | "abstract-geometric" | "restrained-blend";
export type BccIllustrationUsage = "pervasive" | "sparing";

export interface BccIllustrationTokens {
  style: BccIllustrationStyle;
  usage: BccIllustrationUsage;
  /** Accent colours an illustration set is tinted with for this theme/mode. */
  accents: readonly [string, string, string];
  /** Opacity for decorative background motifs. */
  motifOpacity: number;
}

// ---------------------------------------------------------------------------
// Breakpoints
// ---------------------------------------------------------------------------

/**
 * 21_MOBILE_UX.md §Breakpoints: mobile < 600px, tablet 600-959px, desktop >= 960px,
 * mapped onto "MUI's default breakpoint tokens (`xs/sm/md/lg/xl`) [...] rather than
 * inventing a parallel breakpoint system" - so `sm` = 600 and `md` = 960, which are
 * MUI's own defaults, and these constants exist to be *asserted* against, not to
 * redefine anything.
 */
export const BCC_BREAKPOINTS = {
  /** Mobile/tablet boundary. */
  sm: 600,
  /** Tablet/desktop boundary - where the shell swaps bottom nav for sidebar. */
  md: 960,
  lg: 1280,
  xl: 1920,
} as const;

/**
 * 21_MOBILE_UX.md §Tablet-specific decisions: "Tablet defaults to the mobile
 * navigation pattern (bottom nav) below 960px". So the bottom nav is shown for
 * everything under `md`, and the sidebar from `md` up - one swap point, at 960.
 */
export const NAV_SWAP_BREAKPOINT_PX: number = BCC_BREAKPOINTS.md;

/**
 * The narrowest viewport the product is tested at. 21_MOBILE_UX.md names no explicit
 * minimum width; 320px is the narrowest mainstream device viewport (iPhone SE 1st gen
 * / small Android) and is what the responsive overflow tests use. Recorded as a
 * Step-02 engineering decision.
 */
export const MIN_SUPPORTED_VIEWPORT_PX = 320;

// ---------------------------------------------------------------------------
// The whole token set
// ---------------------------------------------------------------------------

export interface BccThemeTokens {
  name: BccThemeName;
  mode: BccMode;
  palette: BccPaletteTokens;
  status: BccStatusTokens;
  typography: BccTypographyTokens;
  spacing: BccSpacingTokens;
  radius: BccRadiusTokens;
  surfaces: BccSurfaceTokens;
  icons: BccIconTokens;
  motion: BccMotionTokens;
  illustration: BccIllustrationTokens;
}

/** Each token module exports exactly this shape: both modes, no more, no less. */
export type BccThemeTokenSet = Readonly<Record<BccMode, BccThemeTokens>>;
