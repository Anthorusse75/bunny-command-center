// The provider stack. 02_design_system_i18n.md §SCOPE, "Modify": "`apps/web`'s root App
// component to wrap children in the new providers."
//
// Order matters and is not arbitrary:
//   BccThemeProvider   - must be outermost of the two, because ToastProvider and every
//                        primitive read `theme.bcc`/`theme.vars` and MUI's colour-scheme
//                        context from it.
//   BccI18nProvider    - owns `<html lang>`, `document.title` and the language context every
//                        primitive's label goes through.
//   ToastProvider      - renders the fixed toast region, so it must sit inside the theme but
//                        outside the surface that raises toasts.
//   AppShell           - the responsive chrome.

import { BccI18nProvider } from "../i18n/BccI18nProvider.js";
import { ToastProvider } from "../design-system/index.js";
import { BccThemeProvider } from "../theme/BccThemeProvider.js";
import { AppShell } from "../shell/AppShell.js";
import { DesignSystemShowcase } from "../showcase/DesignSystemShowcase.js";

export function App(): React.JSX.Element {
  return (
    <BccThemeProvider>
      <BccI18nProvider>
        <ToastProvider>
          <AppShell>
            <DesignSystemShowcase />
          </AppShell>
        </ToastProvider>
      </BccI18nProvider>
    </BccThemeProvider>
  );
}
