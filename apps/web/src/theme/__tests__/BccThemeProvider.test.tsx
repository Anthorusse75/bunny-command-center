// Proof of wiring for the theme engine.
//
// 00_GLOBAL_IMPLEMENTATION_RULES.md #6: "A passing unit test proves the function works in
// isolation. It does **not** prove the function is ever called by anything real." So these
// tests never assert on `createBccTheme`'s return value. They render the real provider tree,
// drive the real user-facing control, and read back:
//   stored/default preference -> provider state -> token selection -> resolved MUI theme
//   -> <html> attribute -> a rendered component's computed style.
//
// The last link matters most: `getComputedStyle` on a real rendered node is the only assertion
// that cannot pass while the CSS-variable plumbing is broken.

import { describe, expect, it } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useTheme } from "@mui/material/styles";
import "../../i18n/index.js";
import { BccI18nProvider } from "../../i18n/BccI18nProvider.js";
import { BccThemeProvider, useBccMode, useBccThemeIdentity } from "../BccThemeProvider.js";
import { ModeSelector, ThemeSelector } from "../components/AppearanceSelectors.js";
import { COLOR_SCHEME_ATTRIBUTE, MODE_STORAGE_KEY, THEME_ATTRIBUTE, THEME_STORAGE_KEY } from "../mode.js";
import { getThemeTokens } from "../tokens/index.js";
import { setSystemColorScheme } from "../../test/matchMedia.js";

/** Reads back what the live theme object actually resolved to, from inside the tree. */
function ThemeReadback(): React.JSX.Element {
  const theme = useTheme();
  const { themeName } = useBccThemeIdentity();
  const { modePreference, resolvedMode } = useBccMode();
  return (
    <div
      data-testid="readback"
      data-theme-name={themeName}
      data-theme-bcc-name={theme.bcc.name}
      data-mode-preference={modePreference}
      data-resolved-mode={resolvedMode}
      data-display-usage={theme.bcc.displayFaceUsage}
      data-glow-scope={theme.bcc.glowScope}
      data-card-radius={String(theme.bcc.radius.card)}
    />
  );
}

function renderTree(props: Parameters<typeof BccThemeProvider>[0] = {}): void {
  render(
    <BccThemeProvider {...props}>
      <BccI18nProvider>
        <ThemeSelector />
        <ModeSelector />
        <ThemeReadback />
        {/* A node styled purely from theme variables - the end of the chain. */}
        <div
          data-testid="token-consumer"
          style={{
            backgroundColor: "var(--bcc-palette-background-default)",
            color: "var(--bcc-palette-text-primary)",
            borderColor: "var(--bcc-palette-bcc-border)",
          }}
        />
      </BccI18nProvider>
    </BccThemeProvider>,
  );
}

function readback(): HTMLElement {
  return screen.getByTestId("readback");
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

describe("BccThemeProvider — defaults and persistence", () => {
  it("uses Fusion + system on a first visit (D-017) and reflects it on <html>", () => {
    renderTree();
    expect(readback().dataset["themeName"]).toBe("fusion");
    expect(readback().dataset["themeBccName"]).toBe("fusion");
    expect(readback().dataset["modePreference"]).toBe("system");
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("fusion");
  });

  it("honours a previously stored theme choice", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "heroic");
    renderTree();
    expect(readback().dataset["themeName"]).toBe("heroic");
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("heroic");
    // ...and the tokens really followed: Heroic is the only theme with an interactive glow.
    expect(readback().dataset["glowScope"]).toBe("interactive");
    expect(readback().dataset["displayUsage"]).toBe("all-headings");
  });

  it("ignores a corrupted stored theme and falls back to the documented default", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "cosmic-deluxe");
    renderTree();
    expect(readback().dataset["themeName"]).toBe("fusion");
  });

  it("ignores a corrupted stored mode and falls back to system", () => {
    window.localStorage.setItem(MODE_STORAGE_KEY, "sepia");
    renderTree();
    expect(readback().dataset["modePreference"]).toBe("system");
  });

  it("persists a theme change so the next visit starts from it", async () => {
    const user = userEvent.setup();
    renderTree();
    await user.click(screen.getByTestId("theme-option-premium"));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("premium");
    expect(readback().dataset["themeName"]).toBe("premium");
  });
});

describe("BccThemeProvider — the 9 theme x mode combinations, end to end", () => {
  const combinations = (["heroic", "premium", "fusion"] as const).flatMap((name) =>
    (["light", "dark", "system"] as const).map((preference) => ({ name, preference })),
  );

  for (const { name, preference } of combinations) {
    for (const systemScheme of preference === "system" ? (["light", "dark"] as const) : ([null] as const)) {
      const label = systemScheme ? `${name}/${preference} (OS=${systemScheme})` : `${name}/${preference}`;
      it(`${label} applies that combination's real token values`, () => {
        if (systemScheme) {
          setSystemColorScheme(systemScheme);
        }
        renderTree({ initialThemeName: name, initialModePreference: preference });

        const expectedMode = preference === "system" ? systemScheme! : preference;
        const tokens = getThemeTokens(name, expectedMode);

        // 1. The stored preference survived resolution.
        expect(readback().dataset["modePreference"]).toBe(preference);
        // 2. It resolved to the right scheme.
        expect(readback().dataset["resolvedMode"]).toBe(expectedMode);
        // 3. MUI selected that scheme on the document.
        expect(document.documentElement.getAttribute(COLOR_SCHEME_ATTRIBUTE)).toBe(expectedMode);
        expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe(name);
        // 4. The theme identity's own non-colour tokens came from the right module.
        expect(readback().dataset["cardRadius"]).toBe(String(tokens.radius.card));
        // 5. The CSS custom properties actually carry that combination's colours - i.e. the
        //    stylesheet MUI generated is the one for this theme AND this scheme.
        expect(cssVar("--bcc-palette-background-default")).toBe(tokens.palette.background.default);
        expect(cssVar("--bcc-palette-text-primary")).toBe(tokens.palette.text.primary);
        expect(cssVar("--bcc-palette-bcc-border")).toBe(tokens.palette.border);
        expect(cssVar("--bcc-palette-bcc-status-error-surface")).toBe(tokens.status.error.surface);
        // 6. And a real rendered node resolves them.
        const consumer = screen.getByTestId("token-consumer");
        expect(getComputedStyle(consumer).backgroundColor).not.toBe("");
      });
    }
  }
});

describe("BccThemeProvider — SYSTEM tracks the OS live", () => {
  it("re-resolves on a prefers-color-scheme change without a reload, keeping the preference at SYSTEM", () => {
    setSystemColorScheme("light");
    renderTree({ initialThemeName: "fusion", initialModePreference: "system" });

    expect(readback().dataset["resolvedMode"]).toBe("light");
    expect(document.documentElement.getAttribute(COLOR_SCHEME_ATTRIBUTE)).toBe("light");
    expect(cssVar("--bcc-palette-background-default")).toBe(
      getThemeTokens("fusion", "light").palette.background.default,
    );

    // The OS setting changes while the app is running. No remount, no reload.
    act(() => {
      setSystemColorScheme("dark");
    });

    expect(readback().dataset["resolvedMode"]).toBe("dark");
    expect(document.documentElement.getAttribute(COLOR_SCHEME_ATTRIBUTE)).toBe("dark");
    expect(cssVar("--bcc-palette-background-default")).toBe(
      getThemeTokens("fusion", "dark").palette.background.default,
    );
    // The crucial part: the *preference* is still SYSTEM, not the value it resolved to.
    expect(readback().dataset["modePreference"]).toBe("system");

    // ...and it tracks back the other way too.
    act(() => {
      setSystemColorScheme("light");
    });
    expect(readback().dataset["resolvedMode"]).toBe("light");
    expect(readback().dataset["modePreference"]).toBe("system");
  });

  it("stops following the OS once the user picks an explicit mode", async () => {
    const user = userEvent.setup();
    setSystemColorScheme("light");
    renderTree({ initialThemeName: "fusion", initialModePreference: "system" });

    await user.click(screen.getByTestId("mode-option-dark"));
    expect(readback().dataset["modePreference"]).toBe("dark");
    expect(readback().dataset["resolvedMode"]).toBe("dark");

    act(() => {
      setSystemColorScheme("light");
    });
    // An explicit choice is not overridden by the OS.
    expect(readback().dataset["resolvedMode"]).toBe("dark");
    expect(window.localStorage.getItem(MODE_STORAGE_KEY)).toBe("dark");
  });
});

describe("BccThemeProvider — switching at runtime", () => {
  it("swaps every token when the theme identity changes, with no remount", async () => {
    const user = userEvent.setup();
    renderTree({ initialThemeName: "fusion", initialModePreference: "light" });

    const fusion = getThemeTokens("fusion", "light");
    const heroic = getThemeTokens("heroic", "light");
    expect(cssVar("--bcc-palette-background-default")).toBe(fusion.palette.background.default);
    expect(readback().dataset["cardRadius"]).toBe(String(fusion.radius.card));

    await user.click(screen.getByTestId("theme-option-heroic"));

    expect(cssVar("--bcc-palette-background-default")).toBe(heroic.palette.background.default);
    expect(readback().dataset["cardRadius"]).toBe(String(heroic.radius.card));
    expect(readback().dataset["glowScope"]).toBe("interactive");
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("heroic");
    // The mode was untouched by a theme change.
    expect(readback().dataset["resolvedMode"]).toBe("light");
  });

  it("swaps only the colour scheme when the mode changes, keeping the theme identity", async () => {
    const user = userEvent.setup();
    renderTree({ initialThemeName: "heroic", initialModePreference: "light" });

    await user.click(screen.getByTestId("mode-option-dark"));

    expect(document.documentElement.getAttribute(COLOR_SCHEME_ATTRIBUTE)).toBe("dark");
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("heroic");
    expect(cssVar("--bcc-palette-background-default")).toBe(
      getThemeTokens("heroic", "dark").palette.background.default,
    );
    expect(readback().dataset["themeName"]).toBe("heroic");
  });
});
