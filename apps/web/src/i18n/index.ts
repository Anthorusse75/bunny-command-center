// react-i18next configuration.
//
// ADR-014 decides the library and the single source of truth: "`react-i18next`,
// `packages/shared/i18n/{fr,en,de}.json`".
//
// Pluralization: 19_I18N_FR_EN_DE.md §Pluralization and interpolation specifies i18next's
// suffix key format by example (a base key plus an `_other`-suffixed sibling) and
// states the resolution mechanism explicitly: "French and German plural rules [...] are
// handled by `i18next`'s built-in plural resolver per locale, not by hand-written
// conditionals in components". i18next v21+ implements that resolver on top of
// `Intl.PluralRules` (node_modules/i18next/i18next.js:1063), i.e. real CLDR categories -
// which is why no `i18next-icu`/`intl-messageformat` dependency is added. ADR-014 explicitly
// allows either ("`i18next-icu` or native i18next plural suffix rules"), and the *format*
// the authoritative document shows is the suffix form, so that is what the catalogs use.
// Adding an ICU message-syntax layer would have contradicted 19_I18N_FR_EN_DE.md's own
// examples and added a dependency for nothing.

import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import {
  FALLBACK_LOCALE,
  SUPPORTED_LOCALES,
  resolveInitialLocale,
  type BccLocale,
} from "@bunny-command-center/shared";
import fr from "@bunny-command-center/shared/i18n/fr.json";
import en from "@bunny-command-center/shared/i18n/en.json";
import de from "@bunny-command-center/shared/i18n/de.json";
import { LOCALE_STORAGE_KEY } from "../theme/mode.js";

function readStoredLocale(): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeStoredLocale(locale: BccLocale): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    /* storage disabled - the in-session language still changes */
  }
}

/**
 * 19_I18N_FR_EN_DE.md §Language detection and persistence: stored preference wins, then
 * `navigator.language`, then English. Resolved through `packages/shared` so `apps/api` (which
 * has to pick a locale for a Discord DM) uses the exact same rule.
 */
export function detectInitialLocale(): BccLocale {
  return resolveInitialLocale({
    storedLocale: readStoredLocale(),
    navigatorLanguages:
      typeof navigator === "undefined"
        ? undefined
        : (navigator.languages ?? (navigator.language ? [navigator.language] : undefined)),
  });
}

void i18next.use(initReactI18next).init({
  resources: {
    fr: { translation: fr },
    en: { translation: en },
    de: { translation: de },
  },
  lng: detectInitialLocale(),
  fallbackLng: FALLBACK_LOCALE,
  supportedLngs: [...SUPPORTED_LOCALES],
  // React escapes for us; double-escaping mangles apostrophes in French copy.
  interpolation: { escapeValue: false },
  // A key that exists but is an empty string is a bug, not a deliberate blank - surface it
  // rather than rendering nothing. (The catalog lint gate also fails on empty values.)
  returnEmptyString: false,
});

export default i18next;
