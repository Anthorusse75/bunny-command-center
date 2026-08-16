import { defineConfig, type Plugin } from "vitest/config";
import type { ProxyOptions } from "vite";
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

/**
 * Found via the real native-EventSource-reconnect E2E test
 * (apps/web/e2e/realtime.spec.ts's "A2" test): once `http-proxy` (what
 * Vite's dev/preview proxy uses internally) has started PIPING an upstream
 * response into the downstream one, an ABRUPT, mid-stream destroy of the
 * UPSTREAM (real apps/api E2E server) socket does NOT surface as the
 * proxy's `error` event at all - Node's HTTP client instead emits `aborted`/
 * `close` directly on the upstream response object, which plain `.pipe()`
 * does not automatically propagate to the destination. Without handling
 * this, the DOWNSTREAM (browser) response just hangs forever: no more
 * bytes, but never actually closed either - confirmed directly with
 * Playwright's own request/response/requestfailed listeners, which showed
 * a real request and 200 response and then NOTHING else, ever, for the
 * proxied connection. A genuinely hung connection never triggers
 * `EventSource`'s reconnect (the SSE spec's retry logic fires on a
 * connection actually ENDING, not on silence). The fix listens on the raw
 * upstream response (`proxyRes`) directly and destroys the downstream
 * response when the upstream ends unexpectedly - which IS what makes the
 * browser see a genuine transport-level failure and triggers native
 * `EventSource` reconnect, making it possible to prove Case A
 * (apps/api/src/sse/route.ts's own doc comment) through this proxy at all.
 */
function sseFriendlyProxyOptions(target: string): ProxyOptions {
  return {
    target,
    changeOrigin: true,
    configure: (proxy) => {
      proxy.on("proxyRes", (proxyRes, _req, res) => {
        const destroyDownstreamIfStillOpen = (): void => {
          if (!res.writableEnded && !res.destroyed) {
            res.destroy();
          }
        };
        proxyRes.on("aborted", destroyDownstreamIfStillOpen);
        proxyRes.on("close", destroyDownstreamIfStillOpen);
        proxyRes.on("error", destroyDownstreamIfStillOpen);
      });
      proxy.on("error", (_err, _req, res) => {
        if ("destroy" in res && typeof res.destroy === "function") {
          res.destroy();
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), bccPreloadThemePlugin()],
  ...(E2E_API_PROXY_TARGET
    ? {
        preview: { proxy: { "/api": sseFriendlyProxyOptions(E2E_API_PROXY_TARGET) } },
        server: { proxy: { "/api": sseFriendlyProxyOptions(E2E_API_PROXY_TARGET) } },
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
