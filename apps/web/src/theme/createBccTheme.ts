// The one theme factory. ADR-015 fixes both the signature and the strategy:
//
//   "**Option 2**: one theme factory function
//    `createBccTheme(themeName: 'heroic'|'premium'|'fusion', mode: 'light'|'dark'|'system')`
//    producing an MUI theme from token modules in `apps/web/src/theme/tokens/{...}.ts`.
//    `fusion` is the default (D-017)."
//
// and 20_DESIGN_SYSTEM_AND_THEMES.md §Light / Dark / System fixes the mechanism:
//
//   "MUI's `cssVariables: true` theme mode generates CSS custom properties so mode
//    switching is a CSS-level recompute (no React re-render storm, no flash-of-wrong-
//    theme on load [...])".
//
// Consequences that shape the code below:
//  * BOTH colour schemes are always built into the returned theme. Mode switching is
//    then MUI flipping one attribute on <html>, which re-points the CSS variables - the
//    theme object is NOT rebuilt, which is what "no React re-render storm" means in
//    practice. `mode` therefore only decides `defaultColorScheme` (which scheme's
//    variables also land on bare `:root`, i.e. the pre-attribute default) and which
//    scheme MUI shallow-merges to the theme's top level for JS reads like
//    `theme.palette.mode`.
//  * `mode: "system"` is resolved here, not stored here. The stored preference stays
//    "system" (see ./mode.ts and ./BccThemeProvider.tsx); this function just needs a
//    concrete scheme for the default, and takes it from `prefers-color-scheme`.

import { createTheme, type Theme, type ThemeOptions } from "@mui/material/styles";
import type { CSSObject } from "@mui/material/styles";
import { getThemeTokens } from "./tokens/index.js";
import {
  BCC_BREAKPOINTS,
  type BccIconVariant,
  type BccMode,
  type BccModePreference,
  type BccThemeName,
  type BccThemeTokens,
  type BccTypeStyle,
} from "./tokens/types.js";
import { COLOR_SCHEME_ATTRIBUTE, CSS_VAR_PREFIX, resolveMode } from "./mode.js";

export { COLOR_SCHEME_ATTRIBUTE, CSS_VAR_PREFIX, THEME_ATTRIBUTE } from "./mode.js";

// ---------------------------------------------------------------------------
// Theme augmentation
// ---------------------------------------------------------------------------

/** Mode-varying values that are not part of MUI's own palette vocabulary. */
export interface BccPaletteExtras {
  surface: { default: string; paper: string; elevated: string };
  border: string;
  focusRing: string;
  focusRingHalo: string;
  scrim: string;
  status: BccThemeTokens["status"];
  shadow: BccThemeTokens["surfaces"]["shadow"];
  /** Resolved glow shadow, or `"none"` when this theme/scope does not glow. */
  glow: string;
}

/** Mode-invariant token metadata components read directly off the theme. */
export interface BccThemeMeta {
  name: BccThemeName;
  radius: BccThemeTokens["radius"];
  space: BccThemeTokens["spacing"];
  motion: BccThemeTokens["motion"];
  icons: BccThemeTokens["icons"];
  illustration: Pick<BccThemeTokens["illustration"], "style" | "usage">;
  fontFamilyDisplay: string;
  fontFamilyBody: string;
  fontFamilyMono: string;
  displayFaceUsage: BccThemeTokens["typography"]["displayFaceUsage"];
  glowScope: BccThemeTokens["surfaces"]["glow"]["scope"];
}

declare module "@mui/material/styles" {
  /**
   * Opts the whole app into MUI's CSS-variables typings: `theme.vars` becomes non-optional
   * and `theme.colorSchemes`/`defaultColorScheme`/`colorSchemeSelector` become part of
   * `Theme`. Without this the factory still works at runtime but every consumer has to
   * pretend `vars` might be missing, and the tests cannot assert on `colorSchemes` at all.
   */
  interface CssThemeVariables {
    enabled: true;
  }
  interface Theme {
    bcc: BccThemeMeta;
  }
  interface ThemeOptions {
    bcc?: BccThemeMeta;
  }
  interface Palette {
    bcc: BccPaletteExtras;
  }
  interface PaletteOptions {
    bcc?: BccPaletteExtras;
  }
  interface TypographyVariants {
    heroNumber: React.CSSProperties;
  }
  interface TypographyVariantsOptions {
    heroNumber?: React.CSSProperties;
  }
}

declare module "@mui/material/Typography" {
  interface TypographyPropsVariantOverrides {
    heroNumber: true;
  }
}

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

/**
 * Which variants are allowed to use the display face, per theme.
 * 20_DESIGN_SYSTEM_AND_THEMES.md: Heroic uses a display face "for headings"; Premium is
 * "a refined sans throughout"; Fusion uses it "for hero numbers/section titles only".
 * "Section titles" is read as h1/h2 - the titles that name a section - not every heading
 * down to h4, which is what "only" is doing in that sentence.
 */
const DISPLAY_FACE_VARIANTS: Record<BccThemeTokens["typography"]["displayFaceUsage"], readonly string[]> = {
  none: [],
  "all-headings": ["h1", "h2", "h3", "h4", "heroNumber"],
  "hero-and-section-titles": ["h1", "h2", "heroNumber"],
};

function typeStyleToCss(
  variant: string,
  style: BccTypeStyle,
  tokens: BccThemeTokens,
): Record<string, unknown> {
  const usesDisplay =
    style.display === true && DISPLAY_FACE_VARIANTS[tokens.typography.displayFaceUsage].includes(variant);
  return {
    fontFamily: usesDisplay ? tokens.typography.fontFamilyDisplay : tokens.typography.fontFamilyBody,
    fontSize: style.fontSize,
    lineHeight: style.lineHeight,
    fontWeight: usesDisplay ? tokens.typography.weight.display : style.fontWeight,
    letterSpacing: style.letterSpacing,
    ...(style.textTransform ? { textTransform: style.textTransform } : {}),
  };
}

function buildTypography(tokens: BccThemeTokens): ThemeOptions["typography"] {
  const { scale } = tokens.typography;
  const variants = Object.fromEntries(
    Object.entries(scale).map(([variant, style]) => [variant, typeStyleToCss(variant, style, tokens)]),
  );
  return {
    fontFamily: tokens.typography.fontFamilyBody,
    fontWeightRegular: tokens.typography.weight.regular,
    fontWeightMedium: tokens.typography.weight.medium,
    fontWeightBold: tokens.typography.weight.bold,
    ...variants,
  };
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

function buildPaletteExtras(tokens: BccThemeTokens): BccPaletteExtras {
  return {
    surface: { ...tokens.palette.background },
    border: tokens.palette.border,
    focusRing: tokens.palette.focusRing,
    focusRingHalo: tokens.palette.focusRingHalo,
    scrim: tokens.palette.scrim,
    status: tokens.status,
    shadow: tokens.surfaces.shadow,
    glow: tokens.surfaces.glow.shadow,
  };
}

function buildColorScheme(tokens: BccThemeTokens): { palette: Record<string, unknown> } {
  const { palette, status, surfaces } = tokens;
  return {
    palette: {
      mode: tokens.mode,
      primary: { main: palette.primary.main, contrastText: palette.primary.contrastText },
      secondary: { main: palette.secondary.main, contrastText: palette.secondary.contrastText },
      // The four documented status families double as MUI's own semantic colours, so
      // every stock MUI component (Alert, Chip, Button color="error", ...) inherits the
      // same values StatusBadge uses. A second, divergent status palette is exactly what
      // 02_design_system_i18n.md §REJECTION CRITERIA forbids.
      success: { main: status.success.main, contrastText: status.success.contrastText },
      warning: { main: status.warning.main, contrastText: status.warning.contrastText },
      error: { main: status.error.main, contrastText: status.error.contrastText },
      info: { main: status.info.main, contrastText: status.info.contrastText },
      background: { default: palette.background.default, paper: palette.background.paper },
      text: {
        primary: palette.text.primary,
        secondary: palette.text.secondary,
        disabled: palette.text.disabled,
      },
      divider: palette.divider,
      action: {
        hoverOpacity: surfaces.action.hoverOpacity,
        selectedOpacity: surfaces.action.selectedOpacity,
        focusOpacity: surfaces.action.focusOpacity,
        disabledOpacity: surfaces.action.disabledOpacity,
      },
      bcc: buildPaletteExtras(tokens),
    },
  };
}

// ---------------------------------------------------------------------------
// Component overrides
// ---------------------------------------------------------------------------

/**
 * 28_ACCESSIBILITY.md §Focus management: a visible ring on EVERY focusable element, tuned per
 * theme. Two-tone by design - see BccPaletteExtras.focusRingHalo.
 *
 * MUI's `ButtonBase` (the root of Button/IconButton/ToggleButton/Chip's clickable variant/...)
 * always sets `outline: 0` on its own root style and tracks focus-visibility itself via a
 * `.Mui-focusVisible` class rather than relying on the native `:focus-visible` pseudo-class -
 * axe-core's first browser run on Step 02 confirmed the browser DOES match `:focus-visible` on
 * these elements, but `ButtonBase`'s own same-specificity `outline: 0` rule is injected later in
 * the sheet and wins the cascade, so the global rule below never painted a ring on any button,
 * icon button, or toggle button. Both rules share this one literal so they can never drift.
 */
function focusRingCss(v: Theme["vars"]): CSSObject {
  return {
    outline: `2px solid ${v.palette.bcc.focusRing}`,
    outlineOffset: "1px",
    boxShadow: `0 0 0 1px ${v.palette.bcc.focusRingHalo}`,
  };
}

function buildComponents(tokens: BccThemeTokens): ThemeOptions["components"] {
  const { radius, spacing, surfaces, icons } = tokens;
  const glowsOnInteractive = surfaces.glow.scope === "interactive";
  const glowsOnPrimaryCta = surfaces.glow.scope !== "none";

  return {
    MuiCssBaseline: {
      styleOverrides: (theme: Theme): CSSObject => {
        const v = theme.vars;
        return {
          ":root": {
            colorScheme: tokens.mode,
          },
          body: {
            backgroundColor: v.palette.background.default,
            color: v.palette.text.primary,
            // 21_MOBILE_UX.md §Navigation: the bottom nav is safe-area aware. Exposing the
            // inset as a variable keeps the arithmetic in one place.
            "--bcc-safe-area-bottom": "env(safe-area-inset-bottom, 0px)",
            // Real bug, found via a real GitHub Actions CI run at 320px/German: a single
            // unbreakable compound word ("Benachrichtigungen", 19 characters, zero spaces or
            // hyphens) has no wrap opportunity under the default `overflow-wrap: normal`, so a
            // font wide enough to need more than its container's width (confirmed: fits exactly
            // under this machine's fonts, genuinely overflows under the CI Linux runner's) makes
            // that single word - and therefore its container, and therefore the page - actually
            // horizontally scrollable (21_MOBILE_UX.md/§29 "German expansion considered" covers
            // exactly this, not just longer sentences). `break-word` lets the browser break
            // inside a word only when it has no other choice, i.e. it never affects normal
            // wrapping for any shorter or space-containing text.
            overflowWrap: "break-word",
          },
          // Non-ButtonBase focusable elements (links, inputs, the skip link, ...) still rely
          // on the native pseudo-class; ButtonBase-derived controls get the same styling via
          // MuiButtonBase's `&.Mui-focusVisible` override below.
          ":focus-visible": focusRingCss(v),
          // 28_ACCESSIBILITY.md §Reduced motion: "reduced to an instant or minimal-crossfade
          // transition, never fully removing the state change itself". The motion token
          // dials intensity; this always wins over it, for every theme.
          "@media (prefers-reduced-motion: reduce)": {
            "*, *::before, *::after": {
              animationDuration: "0.01ms !important",
              animationIterationCount: "1 !important",
              transitionDuration: "0.01ms !important",
              scrollBehavior: "auto !important",
            },
          },
        };
      },
    },
    MuiButtonBase: {
      styleOverrides: {
        root: ({ theme }: { theme: Theme }) => ({
          "&.Mui-focusVisible": focusRingCss(theme.vars),
        }),
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: ({ theme }: { theme: Theme }) => ({
          backgroundImage: "none",
          borderRadius: radius.card,
          "&.MuiPaper-elevation0": { boxShadow: "none" },
          "&.MuiPaper-elevation1": { boxShadow: theme.vars.palette.bcc.shadow.card },
          "&.MuiPaper-elevation2": { boxShadow: theme.vars.palette.bcc.shadow.raised },
          "&.MuiPaper-elevation3, &.MuiPaper-elevation4, &.MuiPaper-elevation8": {
            boxShadow: theme.vars.palette.bcc.shadow.overlay,
            backgroundColor: theme.vars.palette.bcc.surface.elevated,
          },
        }),
      },
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: ({ theme }: { theme: Theme }) => ({
          borderRadius: radius.md,
          // 21_MOBILE_UX.md §Touch targets: 44x44 minimum, from the token, not a guess.
          minHeight: spacing.touchTarget,
          paddingInline: spacing.inline * 2,
          ...(glowsOnInteractive ? { "&:hover": { boxShadow: theme.vars.palette.bcc.glow } } : {}),
        }),
        contained: ({ theme }: { theme: Theme }) =>
          glowsOnPrimaryCta ? { "&:hover": { boxShadow: theme.vars.palette.bcc.glow } } : {},
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          minWidth: spacing.touchTarget,
          minHeight: spacing.touchTarget,
          borderRadius: radius.md,
        },
      },
    },
    MuiToggleButton: {
      styleOverrides: {
        // MUI's stock ToggleButton colours its unselected label with
        // `palette.action.active` - a translucent black/white that lands around 4:1 on a light
        // canvas. axe-core flagged it as a real `color-contrast` violation on every light theme
        // during Step 02's first browser run, on the theme/mode/language selectors themselves.
        // These overrides put both states on gated tokens instead: `text.primary` on the surface,
        // and `primary.contrastText` on `primary.main` when selected - both of which the contrast
        // gate in ../contrast-requirements.ts already enforces at 4.5:1.
        root: ({ theme }: { theme: Theme }) => ({
          minHeight: spacing.touchTarget,
          borderRadius: radius.md,
          textTransform: "none",
          color: theme.vars.palette.text.primary,
          borderColor: theme.vars.palette.bcc.border,
          "&.Mui-selected": {
            backgroundColor: theme.vars.palette.primary.main,
            color: theme.vars.palette.primary.contrastText,
            "&:hover": {
              backgroundColor: theme.vars.palette.primary.main,
              color: theme.vars.palette.primary.contrastText,
            },
          },
        }),
      },
    },
    MuiChip: {
      styleOverrides: {
        root: { borderRadius: radius.pill, fontWeight: tokens.typography.weight.semibold },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: ({ theme }: { theme: Theme }) => ({
          borderRadius: radius.card,
          border: `1px solid ${theme.vars.palette.divider}`,
          boxShadow: theme.vars.palette.bcc.shadow.card,
        }),
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: ({ theme }: { theme: Theme }) => ({
          backgroundColor: theme.vars.palette.bcc.surface.elevated,
          color: theme.vars.palette.text.primary,
          border: `1px solid ${theme.vars.palette.bcc.border}`,
          borderRadius: radius.sm,
          boxShadow: theme.vars.palette.bcc.shadow.overlay,
          fontSize: tokens.typography.scale.body2.fontSize,
          padding: spacing.inline,
          maxWidth: 320,
        }),
        arrow: ({ theme }: { theme: Theme }) => ({
          color: theme.vars.palette.bcc.surface.elevated,
        }),
      },
    },
    MuiSvgIcon: {
      styleOverrides: {
        root: { fontSize: icons.size.md },
        fontSizeSmall: { fontSize: icons.size.sm },
        fontSizeLarge: { fontSize: icons.size.lg },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        notchedOutline: ({ theme }: { theme: Theme }) => ({
          borderColor: theme.vars.palette.bcc.border,
        }),
      },
    },
    MuiDivider: {
      styleOverrides: {
        root: ({ theme }: { theme: Theme }) => ({ borderColor: theme.vars.palette.divider }),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateBccThemeOptions {
  /**
   * Injectable `prefers-color-scheme: dark` result, so `mode: "system"` is testable
   * without a real media query. Defaults to reading `window.matchMedia`.
   */
  systemPrefersDark?: boolean;
}

export function createBccTheme(
  themeName: BccThemeName,
  mode: BccModePreference,
  options: CreateBccThemeOptions = {},
): Theme {
  const resolved: BccMode = resolveMode(mode, options.systemPrefersDark);
  const lightTokens = getThemeTokens(themeName, "light");
  const darkTokens = getThemeTokens(themeName, "dark");
  const activeTokens = resolved === "dark" ? darkTokens : lightTokens;

  return createTheme({
    cssVariables: {
      colorSchemeSelector: COLOR_SCHEME_ATTRIBUTE,
      cssVarPrefix: CSS_VAR_PREFIX,
    },
    defaultColorScheme: resolved,
    colorSchemes: {
      light: buildColorScheme(lightTokens),
      dark: buildColorScheme(darkTokens),
    },
    // 21_MOBILE_UX.md §Breakpoints defines mobile < 600, tablet 600-959, desktop >= 960 and
    // asks for them to be mapped onto MUI's own xs/sm/md/lg/xl tokens. MUI's stock `md` is
    // 900, so `md` is set to 960 here - the names are MUI's, the values are the document's.
    breakpoints: {
      values: {
        xs: 0,
        sm: BCC_BREAKPOINTS.sm,
        md: BCC_BREAKPOINTS.md,
        lg: BCC_BREAKPOINTS.lg,
        xl: BCC_BREAKPOINTS.xl,
      },
    },
    spacing: activeTokens.spacing.baseUnit,
    shape: { borderRadius: activeTokens.radius.md },
    typography: buildTypography(activeTokens),
    transitions: {
      duration: {
        shortest: activeTokens.motion.duration.instant,
        shorter: activeTokens.motion.duration.fast,
        short: activeTokens.motion.duration.fast,
        standard: activeTokens.motion.duration.normal,
        complex: activeTokens.motion.duration.slow,
        enteringScreen: activeTokens.motion.duration.normal,
        leavingScreen: activeTokens.motion.duration.fast,
      },
      easing: {
        easeInOut: activeTokens.motion.easing.standard,
        easeOut: activeTokens.motion.easing.decelerate,
        easeIn: activeTokens.motion.easing.accelerate,
        sharp: activeTokens.motion.easing.emphasized,
      },
    },
    components: buildComponents(activeTokens),
    bcc: {
      name: themeName,
      radius: activeTokens.radius,
      space: activeTokens.spacing,
      motion: activeTokens.motion,
      icons: activeTokens.icons,
      illustration: {
        style: activeTokens.illustration.style,
        usage: activeTokens.illustration.usage,
      },
      fontFamilyDisplay: activeTokens.typography.fontFamilyDisplay,
      fontFamilyBody: activeTokens.typography.fontFamilyBody,
      fontFamilyMono: activeTokens.typography.fontFamilyMono,
      displayFaceUsage: activeTokens.typography.displayFaceUsage,
      glowScope: activeTokens.surfaces.glow.scope,
    },
  });
}

/** Whether a theme's icon variant asks for the filled or the outlined icon of a pair. */
export function prefersFilledIcon(variant: BccIconVariant, isPrimaryAction: boolean): boolean {
  switch (variant) {
    case "filled":
      return true;
    case "outlined":
      return false;
    case "outlined-filled-primary":
      return isPrimaryAction;
  }
}
