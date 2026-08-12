// Mode resolution + preference persistence, as pure logic.
//
// The invariant these tests exist to protect: a stored preference of "system" must survive
// resolution. 20_DESIGN_SYSTEM_AND_THEMES.md §Light / Dark / System: system "resolves to one
// of the two via `prefers-color-scheme`, re-evaluated live on OS-level change" - resolution
// is a read, never a write.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODE_PREFERENCE,
  DEFAULT_THEME_NAME,
  MODE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  isModePreference,
  isThemeName,
  readStoredModePreference,
  readStoredThemeName,
  readSystemPrefersDark,
  resolveMode,
  writeStoredThemeName,
} from "../mode.js";
import { setSystemColorScheme } from "../../test/matchMedia.js";

describe("resolveMode", () => {
  it("passes explicit preferences through untouched, whatever the OS says", () => {
    expect(resolveMode("light", true)).toBe("light");
    expect(resolveMode("light", false)).toBe("light");
    expect(resolveMode("dark", false)).toBe("dark");
    expect(resolveMode("dark", true)).toBe("dark");
  });

  it("resolves system from prefers-color-scheme, in both directions", () => {
    expect(resolveMode("system", false)).toBe("light");
    expect(resolveMode("system", true)).toBe("dark");
  });

  it("reads the live media query when no explicit value is injected", () => {
    setSystemColorScheme("dark");
    expect(readSystemPrefersDark()).toBe(true);
    expect(resolveMode("system")).toBe("dark");
    setSystemColorScheme("light");
    expect(readSystemPrefersDark()).toBe(false);
    expect(resolveMode("system")).toBe("light");
  });
});

describe("stored preference validation", () => {
  it("accepts exactly the three theme names and the three mode preferences", () => {
    expect(isThemeName("fusion")).toBe(true);
    expect(isThemeName("heroic")).toBe(true);
    expect(isThemeName("premium")).toBe(true);
    expect(isThemeName("FUSION")).toBe(false);
    expect(isThemeName("cosmic")).toBe(false);
    expect(isThemeName(null)).toBe(false);
    expect(isModePreference("system")).toBe(true);
    expect(isModePreference("auto")).toBe(false);
  });

  it("falls back to the documented defaults when storage is empty", () => {
    expect(readStoredThemeName()).toBe(DEFAULT_THEME_NAME);
    expect(readStoredModePreference()).toBe(DEFAULT_MODE_PREFERENCE);
  });

  it("falls back to the documented defaults when storage holds garbage", () => {
    // Hand-edited or stale values must never propagate into the theme factory.
    window.localStorage.setItem(THEME_STORAGE_KEY, "cosmic-deluxe");
    window.localStorage.setItem(MODE_STORAGE_KEY, "sepia");
    expect(readStoredThemeName()).toBe("fusion");
    expect(readStoredModePreference()).toBe("system");
  });

  it("round-trips a valid theme choice", () => {
    writeStoredThemeName("heroic");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("heroic");
    expect(readStoredThemeName()).toBe("heroic");
  });
});
