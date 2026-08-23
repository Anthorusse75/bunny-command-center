/**
 * Server-side rendering of a notification's `message_key`+`parameters_json`
 * into localized text — needed because `apps/api` must render the Discord
 * DM's `content`/`footer` BEFORE enqueueing the `SEND_DM` `operator_commands`
 * row (this step's corrected contract: "Bunny does not render
 * `message_key`/`parameters` itself"). The Notification Center's own
 * in-app list (`GET /api/notifications`) renders through this exact same
 * function, using the same catalogs the browser's `react-i18next` instance
 * uses (`@bunny-command-center/shared/i18n/{fr,en,de}.json`, ADR-014's single
 * source of truth) — so in-app and DM text can never drift.
 *
 * DELIBERATELY NOT a second `i18next` instance running server-side: no
 * `i18next` runtime dependency is added to `apps/api` for this (its
 * package.json has none, `apps/web`'s `i18next`/`react-i18next` stay
 * web-only). This is a small, fully unit-tested, dependency-free
 * interpolator instead — proportionate to what this step actually needs
 * (flat `{{param}}` interpolation + i18next's own `_one`/`_other` CLDR
 * plural-suffix convention via `Intl.PluralRules`, the SAME mechanism
 * `apps/web/src/i18n/index.ts`'s own header comment documents i18next using
 * internally) rather than pulling in a full client-oriented i18n framework
 * for one server-side rendering path. Documented explicitly here as an
 * implementation-detail choice, not a silently narrower reimplementation of
 * ADR-014 (00_GLOBAL_IMPLEMENTATION_RULES.md #1).
 */
import { INTL_LOCALE_TAG, FALLBACK_LOCALE, type BccLocale } from "@bunny-command-center/shared";
import fr from "@bunny-command-center/shared/i18n/fr.json" with { type: "json" };
import en from "@bunny-command-center/shared/i18n/en.json" with { type: "json" };
import de from "@bunny-command-center/shared/i18n/de.json" with { type: "json" };

const CATALOGS: Record<BccLocale, unknown> = { fr, en, de };

function lookupRaw(catalog: unknown, dottedKey: string): string | undefined {
  const parts = dottedKey.split(".");
  let cursor: unknown = catalog;
  for (const part of parts) {
    if (cursor !== null && typeof cursor === "object" && part in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof cursor === "string" ? cursor : undefined;
}

/** i18next suffix-plural resolution (19_I18N_FR_EN_DE.md §Pluralization: real CLDR categories via `Intl.PluralRules`, not hand-written conditionals) — only engaged when `params.count` is a finite number. Falls back to `_other`, then the bare (unsuffixed) key. */
function resolveKey(
  locale: BccLocale,
  catalog: unknown,
  key: string,
  params: Readonly<Record<string, unknown>>,
): string | undefined {
  const count = params["count"];
  if (typeof count === "number" && Number.isFinite(count)) {
    const category = new Intl.PluralRules(INTL_LOCALE_TAG[locale]).select(count);
    const suffixed = lookupRaw(catalog, `${key}_${category}`);
    if (suffixed !== undefined) {
      return suffixed;
    }
    const other = lookupRaw(catalog, `${key}_other`);
    if (other !== undefined) {
      return other;
    }
  }
  return lookupRaw(catalog, key);
}

function stringifyParam(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  // A notification `parameters` value should always be a primitive
  // (`packages/shared/src/types/notifications.ts`'s registry is
  // string/number/boolean-shaped in practice) — an object/array here is
  // unexpected input, rendered as JSON rather than the useless
  // "[object Object]" a bare `String()` would produce.
  return JSON.stringify(value);
}

function interpolate(template: string, params: Readonly<Record<string, unknown>>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, name: string) =>
    stringifyParam(params[name]),
  );
}

/**
 * Renders one message key for one locale, with `{{param}}` interpolation and
 * plural-suffix resolution. Never throws on a missing key/locale — falls
 * back to `en` (19_I18N_FR_EN_DE.md §Language detection: "falling back to
 * English if unsupported"), and if the key is missing there too, returns the
 * raw key itself (visible-but-non-fatal, matches i18next's own
 * missing-key discipline — a malformed/unregistered `messageKey` must never
 * crash notification creation or DM enqueueing).
 */
export function renderMessage(
  locale: BccLocale,
  key: string,
  params: Readonly<Record<string, unknown>> = {},
): string {
  const catalog = CATALOGS[locale] ?? CATALOGS[FALLBACK_LOCALE];
  const template =
    resolveKey(locale, catalog, key, params) ??
    resolveKey(FALLBACK_LOCALE, CATALOGS[FALLBACK_LOCALE], key, params);
  if (template === undefined) {
    return key;
  }
  return interpolate(template, params);
}
