// Locale-driven Intl wrappers.
//
// DASHBOARD/19_I18N_FR_EN_DE.md §Dates, numbers, relative time requires
// `Intl.DateTimeFormat`/`Intl.NumberFormat`/`Intl.RelativeTimeFormat` "via a thin
// wrapper in `packages/shared`, locale-driven from the user's stored preference -
// never a hardcoded `en-US` format string", with internal timestamps in UTC and
// user-facing display in Europe/Paris.
//
// Formatter construction is genuinely expensive (Intl objects compile format
// patterns), and these are called per row in lists of hundreds of items, so each
// (locale, options) pair is memoized.

import { DISPLAY_TIME_ZONE, INTL_LOCALE_TAG, type BccLocale } from "./locales.js";

function cacheKey(locale: BccLocale, options: unknown): string {
  return `${locale}|${JSON.stringify(options ?? {})}`;
}

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();
const numberFormatters = new Map<string, Intl.NumberFormat>();
const relativeTimeFormatters = new Map<string, Intl.RelativeTimeFormat>();

export function getDateTimeFormat(
  locale: BccLocale,
  options: Intl.DateTimeFormatOptions = {},
): Intl.DateTimeFormat {
  const key = cacheKey(locale, options);
  let formatter = dateTimeFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(INTL_LOCALE_TAG[locale], {
      timeZone: DISPLAY_TIME_ZONE,
      ...options,
    });
    dateTimeFormatters.set(key, formatter);
  }
  return formatter;
}

export function getNumberFormat(
  locale: BccLocale,
  options: Intl.NumberFormatOptions = {},
): Intl.NumberFormat {
  const key = cacheKey(locale, options);
  let formatter = numberFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(INTL_LOCALE_TAG[locale], options);
    numberFormatters.set(key, formatter);
  }
  return formatter;
}

export function getRelativeTimeFormat(
  locale: BccLocale,
  options: Intl.RelativeTimeFormatOptions = {},
): Intl.RelativeTimeFormat {
  const key = cacheKey(locale, options);
  let formatter = relativeTimeFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(INTL_LOCALE_TAG[locale], {
      numeric: "auto",
      ...options,
    });
    relativeTimeFormatters.set(key, formatter);
  }
  return formatter;
}

/** Date only, e.g. FR `12/08/2026`, EN `12/08/2026`, DE `12.08.2026`. */
export function formatDate(locale: BccLocale, value: Date | number | string): string {
  return getDateTimeFormat(locale, { dateStyle: "short" }).format(toDate(value));
}

/** Date + time in Europe/Paris, e.g. DE `12.08.2026, 14:05`. */
export function formatDateTime(locale: BccLocale, value: Date | number | string): string {
  return getDateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(toDate(value));
}

export function formatNumber(locale: BccLocale, value: number, options?: Intl.NumberFormatOptions): string {
  return getNumberFormat(locale, options).format(value);
}

/** Percentage from a 0..1 ratio. `0.873` -> FR `87 %`, EN `87%`, DE `87 %`. */
export function formatPercent(locale: BccLocale, ratio: number, fractionDigits = 0): string {
  return getNumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(ratio);
}

const RELATIVE_UNIT_THRESHOLDS: readonly { unit: Intl.RelativeTimeFormatUnit; ms: number }[] = [
  { unit: "year", ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: "month", ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: "week", ms: 7 * 24 * 60 * 60 * 1000 },
  { unit: "day", ms: 24 * 60 * 60 * 1000 },
  { unit: "hour", ms: 60 * 60 * 1000 },
  { unit: "minute", ms: 60 * 1000 },
  { unit: "second", ms: 1000 },
];

/**
 * Relative time against an explicit `now` (injected, never `Date.now()` implicitly)
 * so callers - and tests - stay deterministic. Picks the largest unit whose
 * threshold the delta clears, matching what `Intl.RelativeTimeFormat` expects to be
 * handed (it formats a value+unit, it does not choose the unit itself).
 */
export function formatRelativeTime(
  locale: BccLocale,
  value: Date | number | string,
  now: Date | number = Date.now(),
): string {
  const deltaMs = toDate(value).getTime() - toDate(now).getTime();
  const absMs = Math.abs(deltaMs);
  const formatter = getRelativeTimeFormat(locale);
  for (const { unit, ms } of RELATIVE_UNIT_THRESHOLDS) {
    if (absMs >= ms) {
      return formatter.format(Math.round(deltaMs / ms), unit);
    }
  }
  // Below one second: "now" rather than "in 0 seconds".
  return formatter.format(0, "second");
}

/**
 * Byte sizes for upload UI. Uses locale number formatting for the mantissa; the
 * unit suffix itself is an SI symbol, identical across FR/EN/DE, so it is not a
 * translated string (19_I18N_FR_EN_DE.md's "units" requirement covers words like
 * "screenshots", not the `kB`/`MB` symbols).
 */
const BYTE_UNITS = ["B", "kB", "MB", "GB", "TB"] as const;

export function formatBytes(locale: BccLocale, bytes: number): string {
  const safe = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  let unitIndex = 0;
  let scaled = safe;
  while (scaled >= 1000 && unitIndex < BYTE_UNITS.length - 1) {
    scaled /= 1000;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 ? 0 : scaled < 10 ? 1 : 0;
  return `${formatNumber(locale, scaled, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} ${BYTE_UNITS[unitIndex]}`;
}

function toDate(value: Date | number | string): Date {
  if (value instanceof Date) {
    return value;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`Not a valid date: ${String(value)}`);
  }
  return parsed;
}
