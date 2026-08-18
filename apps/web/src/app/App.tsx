// The provider stack. 02_design_system_i18n.md §SCOPE, "Modify": "`apps/web`'s root App
// component to wrap children in the new providers."
//
// Order matters and is not arbitrary:
//   BccThemeProvider   - must be outermost of the two, because ToastProvider and every
//                        primitive read `theme.bcc`/`theme.vars` and MUI's colour-scheme
//                        context from it.
//   BccI18nProvider    - owns `<html lang>`, `document.title` and the language context every
//                        primitive's label goes through.
//   QueryClientProvider - TanStack Query's cache, needed by SseProvider (query invalidation)
//                        and by every future screen's data fetching (ADR-003).
//   SseProvider        - realtime transport (03_realtime_infrastructure.md). Sits inside the
//                        QueryClientProvider (it calls useQueryClient()) and inside i18n (its
//                        OfflineBanner renders translated text), outside ToastProvider so a
//                        future step can raise a toast from a realtime event.
//   ToastProvider      - renders the fixed toast region, so it must sit inside the theme but
//                        outside the surface that raises toasts.
//   AppShell           - the responsive chrome.

import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router";
import { useState } from "react";
import { BccI18nProvider } from "../i18n/BccI18nProvider.js";
import { ToastProvider } from "../design-system/index.js";
import { BccThemeProvider } from "../theme/BccThemeProvider.js";
import { SseProvider, createBccQueryClient } from "../realtime/index.js";
import { RealtimeTestProbe, realtimeTestProbeEnabled } from "../realtime/RealtimeTestProbe.js";
import { AuthProvider, AuthGate } from "../features/auth/index.js";
import { createAppRouter } from "../navigation/routes.js";
import { initGuildRealtimeWiring } from "../features/guilds/index.js";

// Step 06 addition (03_realtime_infrastructure.md's Step-06+ extension
// point) — registers the multi-guild model's SSE -> invalidation mapping
// once, at module load, before any component mounts. See
// features/guilds/realtimeWiring.ts's own doc comment for this
// registration's honest current status (inert until a later step emits the
// `permissions_changed` event).
initGuildRealtimeWiring();

// STEP 04 UPDATE (04_discord_oauth_sessions.md): `AuthProvider` sits inside
// `QueryClientProvider`/`BccI18nProvider` (its Login/error screens are
// translated) but OUTSIDE `SseProvider` — `/api/stream` does not require
// authentication yet (see apps/api/src/sse/route.ts's own HANDOVER-deviation
// comment), so the realtime transport connects regardless of auth status,
// exactly as it did in Step 03. `AuthGate` is the single place that decides
// whether the authenticated app content or one of SCREENS/AUTH.md's pre-auth
// states renders.
//
// STEP 06 UPDATE (06_multi_guild_navigation.md): the Step 02 design-system
// showcase (`AppShell` wrapping `DesignSystemShowcase` directly) is replaced
// by the real route tree (`navigation/routes.tsx`) — `AppShell` itself now
// lives INSIDE the router, at `RootLayout`, so every screen gets the same
// chrome without `App.tsx` needing to know about routing at all. The
// showcase route itself was never part of `03_INFORMATION_ARCHITECTURE.md`'s
// domain table (it's not a product feature, not linked from any nav chrome)
// but is still deliberately reachable at the dedicated `/__showcase__` path
// (`navigation/routes.tsx`) — CORRECTED (Step 06, Copilot review pass,
// Finding 2): an earlier version of this comment claimed it was "dropped
// from the live app," which was never accurate — it stays registered in the
// real router precisely so the existing Step 01-03 real-browser Playwright
// coverage (`theme-matrix`/`responsive`/`i18n`/`accessibility`.spec.ts) keeps
// exercising the design-system primitives through a real route, not a
// component rendered in isolation (see `navigation/routes.tsx`'s own comment
// on this route for the full rationale). `design-system/__tests__/*`
// component tests are a SEPARATE, additional layer that render individual
// primitives directly, without the router at all.
export function App(): React.JSX.Element {
  const [queryClient] = useState(createBccQueryClient);
  const [router] = useState(createAppRouter);

  return (
    <BccThemeProvider>
      <BccI18nProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <SseProvider>
              <ToastProvider>
                <AuthGate>
                  <RouterProvider router={router} />
                </AuthGate>
                {realtimeTestProbeEnabled() ? <RealtimeTestProbe /> : null}
              </ToastProvider>
            </SseProvider>
          </AuthProvider>
        </QueryClientProvider>
      </BccI18nProvider>
    </BccThemeProvider>
  );
}
