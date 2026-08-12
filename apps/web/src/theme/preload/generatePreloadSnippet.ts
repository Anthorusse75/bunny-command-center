// Flash-of-wrong-theme prevention.
//
// 20_DESIGN_SYSTEM_AND_THEMES.md §Light / Dark / System requires "no flash-of-wrong-theme
// on load - the initial mode is resolved server-side-adjacent via a blocking inline script
// reading the stored preference/`prefers-color-scheme` before first paint, avoiding FOUC",
// and 02_design_system_i18n.md restates it as an acceptance criterion ("switching
// theme/mode causes no full-page reload and no flash-of-wrong-theme").
//
// Two halves are needed, and one without the other does nothing:
//  1. A blocking inline SCRIPT that reads the stored preference and sets the two <html>
//     attributes before the first paint. MUI's own runtime sets the colour-scheme
//     attribute too, but only after React mounts - far too late.
//  2. A pre-paint STYLE block that gives those attribute combinations a background and
//     text colour. MUI's CSS variables are injected by Emotion at render time, so between
//     first paint and mount there is nothing to make the page dark; a script alone would
//     still flash white.
//
// Both are GENERATED FROM THE TOKENS by the functions below and injected into index.html
// by the Vite plugin in ../../../vite.config.ts, in dev and in production alike. Nothing
// here is hand-copied, so the pre-paint colours cannot drift from the real theme - the
// duplication that would otherwise be inevitable is what this generator exists to avoid.

import {
  BCC_MODES,
  BCC_THEME_NAMES,
  DEFAULT_MODE_PREFERENCE,
  DEFAULT_THEME_NAME,
  getThemeTokens,
} from "../tokens/index.js";
import {
  COLOR_SCHEME_ATTRIBUTE,
  MODE_STORAGE_KEY,
  PREFERS_DARK_QUERY,
  THEME_ATTRIBUTE,
  THEME_STORAGE_KEY,
} from "../mode.js";

/**
 * CSS applied before any JS runs. Includes:
 *  - a bare `:root` rule carrying the documented defaults, so even a browser with JS
 *    disabled gets a coherent page rather than an unstyled one;
 *  - a `prefers-color-scheme: dark` variant of that default, for the (common) case of a
 *    first visit with no stored preference and a dark OS;
 *  - one rule per theme x mode, selected by the attributes the inline script sets.
 */
export function generatePreloadStyleCss(): string {
  const rules: string[] = [];
  const defaultTokensLight = getThemeTokens(DEFAULT_THEME_NAME, "light");
  const defaultTokensDark = getThemeTokens(DEFAULT_THEME_NAME, "dark");

  rules.push(
    `:root{color-scheme:light;background-color:${defaultTokensLight.palette.background.default};color:${defaultTokensLight.palette.text.primary}}`,
  );
  if (DEFAULT_MODE_PREFERENCE === "system") {
    rules.push(
      `@media ${PREFERS_DARK_QUERY}{:root:not([${COLOR_SCHEME_ATTRIBUTE}="light"]){color-scheme:dark;background-color:${defaultTokensDark.palette.background.default};color:${defaultTokensDark.palette.text.primary}}}`,
    );
  }

  for (const name of BCC_THEME_NAMES) {
    for (const mode of BCC_MODES) {
      const tokens = getThemeTokens(name, mode);
      rules.push(
        `:root[${THEME_ATTRIBUTE}="${name}"][${COLOR_SCHEME_ATTRIBUTE}="${mode}"]{color-scheme:${mode};background-color:${tokens.palette.background.default};color:${tokens.palette.text.primary}}`,
      );
    }
  }

  // A body background is what actually paints; `:root` alone leaves the canvas to the UA
  // in some engines. `inherit` keeps one source of truth per combination.
  rules.push("body{background-color:inherit;color:inherit;margin:0}");

  return rules.join("\n");
}

/**
 * The blocking script body. Deliberately plain ES5 in a try/catch: it runs before any
 * bundle, on whatever the browser is, and a throw here would leave the page unstyled -
 * so every failure path falls through to the documented defaults.
 */
export function generatePreloadScript(): string {
  return [
    "(function(){",
    "try{",
    `var themes=${JSON.stringify([...BCC_THEME_NAMES])};`,
    `var theme=null;var mode=null;`,
    "try{",
    `theme=window.localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});`,
    `mode=window.localStorage.getItem(${JSON.stringify(MODE_STORAGE_KEY)});`,
    "}catch(e){}",
    `if(themes.indexOf(theme)===-1){theme=${JSON.stringify(DEFAULT_THEME_NAME)};}`,
    `if(mode!=="light"&&mode!=="dark"&&mode!=="system"){mode=${JSON.stringify(DEFAULT_MODE_PREFERENCE)};}`,
    "var resolved=mode;",
    "if(mode==='system'){",
    `resolved=(window.matchMedia&&window.matchMedia(${JSON.stringify(PREFERS_DARK_QUERY)}).matches)?"dark":"light";`,
    "}",
    "var root=document.documentElement;",
    `root.setAttribute(${JSON.stringify(THEME_ATTRIBUTE)},theme);`,
    `root.setAttribute(${JSON.stringify(COLOR_SCHEME_ATTRIBUTE)},resolved);`,
    "}catch(e){}",
    "})();",
  ].join("");
}

/** The two tags, ready to inject into `<head>` ahead of the module script. */
export function generatePreloadTags(): string {
  return `<style id="bcc-preload-theme">${generatePreloadStyleCss()}</style>\n<script id="bcc-preload-theme-script">${generatePreloadScript()}</script>`;
}
