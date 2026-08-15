// The provider that wires the theme factory into the app.
//
// Division of responsibility, deliberately split:
//
//  * THEME IDENTITY (heroic/premium/fusion) is owned here. It changes the theme object,
//    because a different theme means different tokens.
//  * MODE PREFERENCE (light/dark/system) is owned by MUI's ThemeProvider, reached through
//    `useBccMode()`. This is not laziness - it is what makes
//    20_DESIGN_SYSTEM_AND_THEMES.md §Light / Dark / System's "mode switching is a
//    CSS-level recompute (no React re-render storm)" literally true: the returned theme
//    already contains BOTH colour schemes, so switching mode flips one attribute on
//    <html> and the CSS variables re-point. The theme object is not rebuilt, and
//    `forceThemeRerender` is left at its default `false` so MUI does not rebuild it either.
//    MUI's implementation also already tracks `prefers-color-scheme` live via matchMedia
//    (@mui/system/cssVars/useCurrentColorScheme.js:184-198), which is exactly the
//    "re-evaluated live on OS-level change" requirement - reimplementing a second listener
//    beside it would be the "second, divergent implementation of theming"
//    02_design_system_i18n.md §REJECTION CRITERIA forbids.

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider, useColorScheme } from "@mui/material/styles";
import { createBccTheme } from "./createBccTheme.js";
import {
  COLOR_SCHEME_STORAGE_KEY,
  MODE_STORAGE_KEY,
  THEME_ATTRIBUTE,
  readStoredModePreference,
  readStoredThemeName,
  resolveMode,
  writeStoredThemeName,
} from "./mode.js";
import { BCC_THEME_NAMES, type BccMode, type BccModePreference, type BccThemeName } from "./tokens/types.js";
import { createValidatedStorageManager } from "./validatedStorageManager.js";

const storageManager = createValidatedStorageManager();

interface BccThemeIdentityContextValue {
  themeName: BccThemeName;
  setThemeName: (name: BccThemeName) => void;
  availableThemes: readonly BccThemeName[];
}

const BccThemeIdentityContext = createContext<BccThemeIdentityContextValue | null>(null);

export interface BccThemeProviderProps {
  children?: React.ReactNode;
  /** Test seam: skips localStorage for the initial identity. */
  initialThemeName?: BccThemeName;
  /** Test seam: skips localStorage for the initial mode preference. */
  initialModePreference?: BccModePreference;
}

export function BccThemeProvider({
  children,
  initialThemeName,
  initialModePreference,
}: BccThemeProviderProps): React.JSX.Element {
  const [themeName, setThemeNameState] = useState<BccThemeName>(
    () => initialThemeName ?? readStoredThemeName(),
  );
  // Captured once. It only decides which scheme's variables also land on bare `:root`
  // (the pre-attribute default); MUI sets the attribute explicitly from mount onwards, so
  // this never goes stale in a way that can be observed. Keeping it out of the memo key is
  // what stops a mode change from rebuilding the theme.
  const [initialMode] = useState<BccModePreference>(
    () => initialModePreference ?? readStoredModePreference(),
  );

  const theme = useMemo(() => createBccTheme(themeName, initialMode), [themeName, initialMode]);

  useEffect(() => {
    document.documentElement.setAttribute(THEME_ATTRIBUTE, themeName);
  }, [themeName]);

  const identity = useMemo<BccThemeIdentityContextValue>(
    () => ({
      themeName,
      setThemeName: (name: BccThemeName) => {
        writeStoredThemeName(name);
        setThemeNameState(name);
      },
      availableThemes: BCC_THEME_NAMES,
    }),
    [themeName],
  );

  return (
    <BccThemeIdentityContext.Provider value={identity}>
      <ThemeProvider
        theme={theme}
        defaultMode={initialMode}
        modeStorageKey={MODE_STORAGE_KEY}
        colorSchemeStorageKey={COLOR_SCHEME_STORAGE_KEY}
        // MUI reads localStorage itself and would otherwise trust whatever string it finds -
        // see ./validatedStorageManager.ts for the failing case this closes.
        storageManager={storageManager}
        // Suppresses the cross-fade that would otherwise animate every colour on the page
        // during a mode switch - the switch should be instant, not a 200ms wash.
        disableTransitionOnChange
        // jsdom has no matchMedia by default; `noSsr` makes MUI resolve the mode on the
        // first client render instead of deferring to an effect, so a component test sees
        // the real resolved scheme on its first assertion.
        noSsr
      >
        <CssBaseline enableColorScheme />
        {children}
      </ThemeProvider>
    </BccThemeIdentityContext.Provider>
  );
}

export function useBccThemeIdentity(): BccThemeIdentityContextValue {
  const value = useContext(BccThemeIdentityContext);
  if (!value) {
    throw new Error("useBccThemeIdentity must be used inside <BccThemeProvider>.");
  }
  return value;
}

export interface BccModeState {
  /** What the user chose and what is persisted. Stays "system" when system is chosen. */
  modePreference: BccModePreference;
  /** What "system" currently resolves to; tracks OS changes live. */
  resolvedMode: BccMode;
  setModePreference: (preference: BccModePreference) => void;
}

/**
 * The only supported way to read or change the mode. Returning both the preference and the
 * resolution separately is the point: a UI that showed `resolvedMode` in its selector
 * would silently turn a "system" choice into a "light" choice the first time it rendered.
 */
export function useBccMode(): BccModeState {
  const { mode, systemMode, setMode } = useColorScheme();
  const modePreference: BccModePreference = mode ?? "system";
  const resolvedMode: BccMode =
    modePreference === "system" ? (systemMode ?? resolveMode("system")) : modePreference;

  return {
    modePreference,
    resolvedMode,
    setModePreference: (preference: BccModePreference) => {
      setMode(preference);
    },
  };
}
