// Supported locales and the resolution rules around them.
//
// Sources:
// - DASHBOARD/19_I18N_FR_EN_DE.md §Language detection and persistence:
//   "Initial detection: browser `navigator.language`, falling back to English if
//    unsupported; a returning authenticated user's stored `dashboard_users.locale`
//    always wins once set."
// - DASHBOARD/01_FINAL_PRODUCT_DECISIONS.md D-019 (FR/EN/DE, no other locales).

export const SUPPORTED_LOCALES = ["fr", "en", "de"] as const;

export type BccLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * Fallback locale. 19_I18N_FR_EN_DE.md is explicit: "falling back to English if
 * unsupported". This is the i18next `fallbackLng` too, so a key that somehow only
 * exists in one catalog degrades to English rather than to a raw key.
 */
export const FALLBACK_LOCALE: BccLocale = "en";

/**
 * The display convention for user-facing times, inherited invariant from
 * DASHBOARD/04_GLOBAL_TECHNICAL_ARCHITECTURE.md via 19_I18N_FR_EN_DE.md
 * §Dates, numbers, relative time: internal timestamps are UTC, user-facing display
 * localizes both language AND the existing Europe/Paris convention. A future
 * per-user timezone preference is explicitly out of scope for v1 but not
 * precluded - hence a named constant rather than a literal at each call site.
 */
export const DISPLAY_TIME_ZONE = "Europe/Paris";

export function isSupportedLocale(value: unknown): value is BccLocale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Maps an arbitrary BCP-47 tag (e.g. `de-AT`, `fr-CA`, `en-US`) onto one of the
 * three supported locales by primary subtag, falling back to English.
 *
 * Deliberately does NOT accept a full `navigator.languages` list here - the caller
 * decides the precedence order (see `resolveInitialLocale`), so this stays a pure,
 * trivially testable single-tag mapping.
 */
export function normalizeLocaleTag(tag: string | null | undefined): BccLocale | null {
  if (typeof tag !== "string" || tag.length === 0) {
    return null;
  }
  const primary = tag.toLowerCase().split("-")[0];
  return isSupportedLocale(primary) ? primary : null;
}

export interface InitialLocaleInputs {
  /**
   * The persisted user preference. Once a user has chosen a language it always
   * wins (19_I18N_FR_EN_DE.md: "a returning authenticated user's stored
   * `dashboard_users.locale` always wins once set"). Pre-auth this is the
   * locally-persisted choice; Step 04+ substitutes the server-stored value.
   */
  storedLocale?: string | null | undefined;
  /** `navigator.languages` (most-preferred first), or `[navigator.language]`. */
  navigatorLanguages?: readonly string[] | undefined;
}

/**
 * Precedence: stored preference > browser preference (in browser order) > English.
 * An unrecognized or corrupted stored value is ignored rather than throwing, so a
 * hand-edited localStorage entry can never lock a user out of the app.
 */
export function resolveInitialLocale(inputs: InitialLocaleInputs): BccLocale {
  const stored = normalizeLocaleTag(inputs.storedLocale ?? null);
  if (stored) {
    return stored;
  }
  for (const tag of inputs.navigatorLanguages ?? []) {
    const match = normalizeLocaleTag(tag);
    if (match) {
      return match;
    }
  }
  return FALLBACK_LOCALE;
}

/**
 * The full BCP-47 tag handed to `Intl.*` for each supported locale. `Intl` accepts
 * the bare primary subtag too, but pinning a region makes number/date formatting
 * deterministic across environments instead of dependent on the host default
 * (e.g. `de` alone can resolve differently from `de-DE` for some calendars).
 */
export const INTL_LOCALE_TAG: Record<BccLocale, string> = {
  fr: "fr-FR",
  en: "en-GB",
  de: "de-DE",
};
