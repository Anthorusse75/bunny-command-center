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
import { useState } from "react";
import { BccI18nProvider } from "../i18n/BccI18nProvider.js";
import { ToastProvider } from "../design-system/index.js";
import { BccThemeProvider } from "../theme/BccThemeProvider.js";
import { AppShell } from "../shell/AppShell.js";
import { DesignSystemShowcase } from "../showcase/DesignSystemShowcase.js";
import { SseProvider, createBccQueryClient } from "../realtime/index.js";
import { RealtimeTestProbe, realtimeTestProbeEnabled } from "../realtime/RealtimeTestProbe.js";
import { AuthProvider, AuthGate } from "../features/auth/index.js";

// STEP 04 UPDATE (04_discord_oauth_sessions.md): `AuthProvider` sits inside
// `QueryClientProvider`/`BccI18nProvider` (its Login/error screens are
// translated) but OUTSIDE `SseProvider` — `/api/stream` does not require
// authentication yet (see apps/api/src/sse/route.ts's own HANDOVER-deviation
// comment), so the realtime transport connects regardless of auth status,
// exactly as it did in Step 03. `AuthGate` is the single place that decides
// whether the authenticated app content (today: the Step 02 showcase; Step
// 06 replaces this with real routes) or one of SCREENS/AUTH.md's pre-auth
// states renders.
export function App(): React.JSX.Element {
  const [queryClient] = useState(createBccQueryClient);

  return (
    <BccThemeProvider>
      <BccI18nProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <SseProvider>
              <ToastProvider>
                <AuthGate>
                  <AppShell>
                    <DesignSystemShowcase />
                  </AppShell>
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
