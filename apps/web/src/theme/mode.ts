// Mode resolution and preference persistence.
//
// The distinction this file exists to protect: a *preference* is one of
// light/dark/system and is what gets stored; a *resolved mode* is only ever light or
// dark. 20_DESIGN_SYSTEM_AND_THEMES.md §Light / Dark / System: "system mode resolves to
// one of the two via `prefers-color-scheme`, re-evaluated live on OS-level change" -
// so a stored "system" must never be silently rewritten to the value it happened to
// resolve to at the time.

import {
  BCC_MODE_PREFERENCES,
  BCC_THEME_NAMES,
  DEFAULT_MODE_PREFERENCE,
  DEFAULT_THEME_NAME,
  type BccMode,
  type BccModePreference,
  type BccThemeName,
} from "./tokens/types.js";

export const PREFERS_DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * The `<html>` attribute MUI flips to select a colour scheme. Named for this product
 * rather than left at MUI's default (`data-mui-color-scheme`) so the pre-paint inline
 * script in index.html and MUI's own runtime agree on one attribute.
 */
export const COLOR_SCHEME_ATTRIBUTE = "data-bcc-color-scheme";

/** The `<html>` attribute carrying the theme identity, read by the pre-paint styles. */
export const THEME_ATTRIBUTE = "data-bcc-theme";

/** Prefix for every generated CSS custom property (`--bcc-palette-primary-main`). */
export const CSS_VAR_PREFIX = "bcc";

/**
 * localStorage keys. Prefixed so they cannot collide with MUI's own defaults
 * (`mui-mode`/`mui-color-scheme`) - the app owns these, and Step 04+ will mirror them
 * into `dashboard_users`/`dashboard_preferences` server-side without renaming them.
 */
export const THEME_STORAGE_KEY = "bcc.theme";
export const MODE_STORAGE_KEY = "bcc.mode";
export const COLOR_SCHEME_STORAGE_KEY = "bcc.colorScheme";
export const LOCALE_STORAGE_KEY = "bcc.locale";

export function isThemeName(value: unknown): value is BccThemeName {
  return typeof value === "string" && (BCC_THEME_NAMES as readonly string[]).includes(value);
}

export function isModePreference(value: unknown): value is BccModePreference {
  return typeof value === "string" && (BCC_MODE_PREFERENCES as readonly string[]).includes(value);
}

/**
 * Reads `prefers-color-scheme` once. Returns `false` (light) when `matchMedia` is absent
 * - jsdom without a mock, or a very old browser - rather than throwing, because a missing
 * media-query implementation must degrade to a readable UI, not to a blank page.
 */
export function readSystemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(PREFERS_DARK_QUERY).matches;
}

/**
 * The single resolution rule, used by the theme factory, the provider, the pre-paint
 * inline script generator, and the tests - so there is exactly one definition of what
 * "system" means.
 */
export function resolveMode(
  preference: BccModePreference,
  systemPrefersDark: boolean = readSystemPrefersDark(),
): BccMode {
  if (preference === "light" || preference === "dark") {
    return preference;
  }
  return systemPrefersDark ? "dark" : "light";
}

function readStorage(key: string): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(key);
  } catch {
    // Private-mode Safari and hardened browser profiles throw on localStorage access.
    // A user with storage disabled gets the defaults, never an error page.
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* see readStorage */
  }
}

/**
 * A hand-edited, stale, or corrupted stored value falls back to the documented default
 * (D-017: Fusion) instead of propagating an invalid theme name into the factory.
 */
export function readStoredThemeName(): BccThemeName {
  const stored = readStorage(THEME_STORAGE_KEY);
  return isThemeName(stored) ? stored : DEFAULT_THEME_NAME;
}

export function readStoredModePreference(): BccModePreference {
  const stored = readStorage(MODE_STORAGE_KEY);
  return isModePreference(stored) ? stored : DEFAULT_MODE_PREFERENCE;
}

export function writeStoredThemeName(name: BccThemeName): void {
  writeStorage(THEME_STORAGE_KEY, name);
}

export { DEFAULT_MODE_PREFERENCE, DEFAULT_THEME_NAME };
