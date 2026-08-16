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

export function App(): React.JSX.Element {
  const [queryClient] = useState(createBccQueryClient);

  return (
    <BccThemeProvider>
      <BccI18nProvider>
        <QueryClientProvider client={queryClient}>
          <SseProvider>
            <ToastProvider>
              <AppShell>
                <DesignSystemShowcase />
              </AppShell>
              {realtimeTestProbeEnabled() ? <RealtimeTestProbe /> : null}
            </ToastProvider>
          </SseProvider>
        </QueryClientProvider>
      </BccI18nProvider>
    </BccThemeProvider>
  );
}
