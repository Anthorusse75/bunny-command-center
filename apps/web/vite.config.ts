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

// 03_realtime_infrastructure.md's real-browser E2E suite needs `/api/*` (and
// specifically `/api/stream`) reachable from the SAME origin the built SPA is
// served from - proxying here rather than hardcoding a cross-origin URL
// matches production's actual same-origin topology (ADR-017: "The Dashboard
// is a same-origin app"), which Step 22 will wire for real via
// `apps/api` serving the built SPA directly; until then, this dev/preview-time
// proxy is the E2E-time stand-in. Only active when
// `E2E_API_PROXY_TARGET` is set (apps/web/playwright.config.ts sets it to the
// real apps/api E2E server it starts) - unset in every other context
// (ordinary `vite dev`/`vite preview`, the production build, every non-E2E
// test), so this never changes behavior outside the Playwright run.
const E2E_API_PROXY_TARGET = process.env["E2E_API_PROXY_TARGET"];

export default defineConfig({
  plugins: [react(), bccPreloadThemePlugin()],
  ...(E2E_API_PROXY_TARGET
    ? {
        preview: { proxy: { "/api": { target: E2E_API_PROXY_TARGET, changeOrigin: true } } },
        server: { proxy: { "/api": { target: E2E_API_PROXY_TARGET, changeOrigin: true } } },
      }
    : {}),
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // Playwright specs live in ./e2e and are run by `npm run test:e2e`, never by Vitest -
    // Vitest would try to execute them in jsdom and fail on the Playwright imports.
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
  },
});
