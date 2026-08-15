import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import { generatePreloadTags } from "./src/theme/preload/generatePreloadSnippet.js";

/**
 * Injects the generated pre-paint theme <style> + blocking <script> into index.html, in dev
 * and in production alike.
 *
 * Why a plugin instead of pasting the snippet into index.html: the snippet contains the
 * background and text colour of all six theme x mode token sets. Hand-written in index.html
 * they would be a second copy of the palette, free to drift from
 * src/theme/tokens/*.ts with nothing to catch it. Generated at build time from the token
 * modules themselves, drift is impossible - and
 * src/theme/preload/__tests__/generatePreloadSnippet.test.ts asserts the generated output
 * still matches the tokens.
 *
 * Requirement: 20_DESIGN_SYSTEM_AND_THEMES.md §Light / Dark / System ("the initial mode is
 * resolved [...] via a blocking inline script reading the stored preference/
 * `prefers-color-scheme` before first paint, avoiding FOUC").
 */
function bccPreloadThemePlugin(): Plugin {
  return {
    name: "bcc-preload-theme",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return html.replace("<!--BCC_PRELOAD_THEME-->", generatePreloadTags());
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), bccPreloadThemePlugin()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // Playwright specs live in ./e2e and are run by `npm run test:e2e`, never by Vitest -
    // Vitest would try to execute them in jsdom and fail on the Playwright imports.
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
  },
});
