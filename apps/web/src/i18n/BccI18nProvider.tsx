// Runtime language switching, plus the two document-level side effects that are easy to
// forget and impossible to notice visually.
//
// 19_I18N_FR_EN_DE.md §Language detection and persistence: "Changeable any time from Profile
// [...] applied immediately without a page reload (i18next language switch is synchronous
// in-memory)."
//
// The side effects:
//  * `<html lang>` must follow the active language. Without it a screen reader announces
//    French copy with an English voice and hyphenation/quotation rules are wrong - and no
//    visual test would ever catch it (28_ACCESSIBILITY.md's screen-reader requirements
//    depend on it).
//  * `document.title` must be localised too, since it is user-visible copy
//    (19_I18N_FR_EN_DE.md §What must be translated covers "titles").

import { createContext, useCallback, useContext, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SUPPORTED_LOCALES, isSupportedLocale, type BccLocale } from "@bunny-command-center/shared";
import { writeStoredLocale } from "./index.js";

interface BccLocaleContextValue {
  locale: BccLocale;
  setLocale: (locale: BccLocale) => void;
  availableLocales: readonly BccLocale[];
}

const BccLocaleContext = createContext<BccLocaleContextValue | null>(null);

export function BccI18nProvider({ children }: { children?: React.ReactNode }): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const active = i18n.resolvedLanguage ?? i18n.language;
  // `resolvedLanguage` is always one of `supportedLngs`, but a corrupted stored value could
  // still leave `language` as something odd before resolution, so this narrows rather than
  // casting.
  const locale: BccLocale = isSupportedLocale(active) ? active : "en";

  const setLocale = useCallback(
    (next: BccLocale) => {
      writeStoredLocale(next);
      void i18n.changeLanguage(next);
    },
    [i18n],
  );

  useEffect(() => {
    document.documentElement.setAttribute("lang", locale);
  }, [locale]);

  const title = t("app.title");
  useEffect(() => {
    document.title = title;
  }, [title]);

  const value = useMemo<BccLocaleContextValue>(
    () => ({ locale, setLocale, availableLocales: SUPPORTED_LOCALES }),
    [locale, setLocale],
  );

  return <BccLocaleContext.Provider value={value}>{children}</BccLocaleContext.Provider>;
}

export function useBccLocale(): BccLocaleContextValue {
  const value = useContext(BccLocaleContext);
  if (!value) {
    throw new Error("useBccLocale must be used inside <BccI18nProvider>.");
  }
  return value;
}
