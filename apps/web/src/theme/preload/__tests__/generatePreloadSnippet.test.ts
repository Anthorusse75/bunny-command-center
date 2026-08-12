// The anti-FOUC snippet, verified two ways.
//
// (1) The generated CSS carries the *real* token colours for all six theme x mode sets, so it
//     can never drift from src/theme/tokens/*.ts.
// (2) The generated script is EXECUTED in jsdom against seeded localStorage and a seeded
//     `prefers-color-scheme`, and the resulting <html> attributes are read back. Asserting on
//     the script's source text would only prove it was written, not that it works.

import { describe, expect, it } from "vitest";
import {
  generatePreloadScript,
  generatePreloadStyleCss,
  generatePreloadTags,
} from "../generatePreloadSnippet.js";
import { COLOR_SCHEME_ATTRIBUTE, MODE_STORAGE_KEY, THEME_ATTRIBUTE, THEME_STORAGE_KEY } from "../../mode.js";
import {
  DEFAULT_MODE_PREFERENCE,
  DEFAULT_THEME_NAME,
  allThemeModeCombinations,
  getThemeTokens,
} from "../../tokens/index.js";
import { setSystemColorScheme } from "../../../test/matchMedia.js";

function runPreloadScript(): void {
  // Executing the generated snippet is the entire point of this test: the snippet ships to
  // browsers as an inline <script>, and asserting on its source text would prove it was written,
  // not that it works. `no-implied-eval`/`no-unsafe-call` exist to stop untrusted strings being
  // executed; this string is generated from our own token modules two files away.
  /* eslint-disable @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call */
  new Function(generatePreloadScript())();
  /* eslint-enable @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call */
}

describe("pre-paint style block", () => {
  it("carries the real background and text colour of every theme x mode combination", () => {
    const css = generatePreloadStyleCss();
    for (const { name, mode } of allThemeModeCombinations()) {
      const tokens = getThemeTokens(name, mode);
      const selector = `:root[${THEME_ATTRIBUTE}="${name}"][${COLOR_SCHEME_ATTRIBUTE}="${mode}"]`;
      expect(css).toContain(selector);
      const rule = css.split("\n").find((line) => line.startsWith(selector));
      expect(rule, `${name}/${mode}`).toBeDefined();
      expect(rule).toContain(`background-color:${tokens.palette.background.default}`);
      expect(rule).toContain(`color:${tokens.palette.text.primary}`);
      expect(rule).toContain(`color-scheme:${mode}`);
    }
  });

  it("gives a JS-disabled browser the documented default, in both OS appearances", () => {
    const css = generatePreloadStyleCss();
    const light = getThemeTokens(DEFAULT_THEME_NAME, "light");
    const dark = getThemeTokens(DEFAULT_THEME_NAME, "dark");
    expect(css).toContain(`:root{color-scheme:light;background-color:${light.palette.background.default}`);
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain(`background-color:${dark.palette.background.default}`);
  });

  it("paints the body, not only :root (some engines leave the canvas to the UA otherwise)", () => {
    expect(generatePreloadStyleCss()).toContain("body{background-color:inherit");
  });
});

describe("blocking script, executed", () => {
  it("applies the documented defaults on a first visit with a light OS", () => {
    setSystemColorScheme("light");
    runPreloadScript();
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe(DEFAULT_THEME_NAME);
    expect(document.documentElement.getAttribute(COLOR_SCHEME_ATTRIBUTE)).toBe("light");
    expect(DEFAULT_MODE_PREFERENCE).toBe("system");
  });

  it("resolves the default system preference to dark when the OS is dark", () => {
    setSystemColorScheme("dark");
    runPreloadScript();
    expect(document.documentElement.getAttribute(COLOR_SCHEME_ATTRIBUTE)).toBe("dark");
  });

  it("honours a stored theme and a stored explicit mode", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "heroic");
    window.localStorage.setItem(MODE_STORAGE_KEY, "dark");
    setSystemColorScheme("light");
    runPreloadScript();
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("heroic");
    // The explicit choice wins over the OS.
    expect(document.documentElement.getAttribute(COLOR_SCHEME_ATTRIBUTE)).toBe("dark");
  });

  it("keeps following the OS when the stored preference is system", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "premium");
    window.localStorage.setItem(MODE_STORAGE_KEY, "system");
    setSystemColorScheme("dark");
    runPreloadScript();
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("premium");
    expect(document.documentElement.getAttribute(COLOR_SCHEME_ATTRIBUTE)).toBe("dark");
  });

  it("falls back to the defaults when storage holds garbage", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "cosmic-deluxe");
    window.localStorage.setItem(MODE_STORAGE_KEY, "sepia");
    setSystemColorScheme("light");
    runPreloadScript();
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe(DEFAULT_THEME_NAME);
    expect(document.documentElement.getAttribute(COLOR_SCHEME_ATTRIBUTE)).toBe("light");
  });

  it("still applies a theme when matchMedia is unavailable altogether", () => {
    // Stashed via a property descriptor rather than a bare reference: reading the method off
    // `window` detaches it from its receiver, which `@typescript-eslint/unbound-method` rightly
    // objects to. The descriptor restores it exactly as it was.
    const original = Object.getOwnPropertyDescriptor(window, "matchMedia");
    // @ts-expect-error deliberately removing the API to emulate an old browser
    delete window.matchMedia;
    try {
      runPreloadScript();
      expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe(DEFAULT_THEME_NAME);
      expect(document.documentElement.getAttribute(COLOR_SCHEME_ATTRIBUTE)).toBe("light");
    } finally {
      if (original) {
        Object.defineProperty(window, "matchMedia", original);
      }
    }
  });

  it("agrees with the runtime resolver about the attribute names", () => {
    const script = generatePreloadScript();
    expect(script).toContain(THEME_ATTRIBUTE);
    expect(script).toContain(COLOR_SCHEME_ATTRIBUTE);
    expect(script).toContain(THEME_STORAGE_KEY);
    expect(script).toContain(MODE_STORAGE_KEY);
  });
});

describe("injected tags", () => {
  it("emits the style before the script, both inline and identifiable", () => {
    const tags = generatePreloadTags();
    expect(tags.indexOf('<style id="bcc-preload-theme">')).toBeLessThan(
      tags.indexOf('<script id="bcc-preload-theme-script">'),
    );
    // No `src`/`href`: an external file would not be guaranteed to arrive before first paint.
    expect(tags).not.toContain("src=");
    expect(tags).not.toContain("href=");
  });
});
