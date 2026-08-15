// The Intl wrappers, in all three locales.
//
// 19_I18N_FR_EN_DE.md §Dates, numbers, relative time: formatting is "locale-driven from the
// user's stored preference - never a hardcoded `en-US` format string", and user-facing times
// display in Europe/Paris. These tests assert the differences BETWEEN locales, because a
// wrapper that quietly formatted everything as en-US would still pass a single-locale test.

import { describe, expect, it } from "vitest";
import {
  DISPLAY_TIME_ZONE,
  FALLBACK_LOCALE,
  INTL_LOCALE_TAG,
  SUPPORTED_LOCALES,
  formatBytes,
  formatDate,
  formatDateTime,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  isSupportedLocale,
  normalizeLocaleTag,
  resolveInitialLocale,
} from "../src/i18n/index.js";

/** 2026-08-12T12:34:56Z — 14:34 in Europe/Paris (CEST, UTC+2). */
const INSTANT = Date.parse("2026-08-12T12:34:56Z");

describe("locale set", () => {
  it("is exactly FR/EN/DE with English as the fallback (D-019)", () => {
    expect([...SUPPORTED_LOCALES]).toEqual(["fr", "en", "de"]);
    expect(FALLBACK_LOCALE).toBe("en");
  });

  it("pins a region per locale so formatting cannot depend on the host default", () => {
    expect(INTL_LOCALE_TAG).toEqual({ fr: "fr-FR", en: "en-GB", de: "de-DE" });
  });

  it("displays user-facing times in Europe/Paris, per the inherited invariant", () => {
    expect(DISPLAY_TIME_ZONE).toBe("Europe/Paris");
  });
});

describe("locale resolution", () => {
  it("maps regional tags onto the supported primary subtag", () => {
    expect(normalizeLocaleTag("de-AT")).toBe("de");
    expect(normalizeLocaleTag("fr-CA")).toBe("fr");
    expect(normalizeLocaleTag("en-US")).toBe("en");
    expect(normalizeLocaleTag("es-ES")).toBeNull();
    expect(normalizeLocaleTag("")).toBeNull();
    expect(normalizeLocaleTag(null)).toBeNull();
  });

  it("lets a stored preference win over the browser (19_I18N §Language detection)", () => {
    expect(resolveInitialLocale({ storedLocale: "de", navigatorLanguages: ["fr-FR", "en"] })).toBe("de");
  });

  it("falls back through the browser list in order, then to English", () => {
    expect(resolveInitialLocale({ navigatorLanguages: ["es-ES", "de-DE", "fr"] })).toBe("de");
    expect(resolveInitialLocale({ navigatorLanguages: ["es-ES", "ja"] })).toBe("en");
    expect(resolveInitialLocale({})).toBe("en");
  });

  it("ignores a corrupted stored preference instead of trusting it", () => {
    expect(resolveInitialLocale({ storedLocale: "klingon", navigatorLanguages: ["de"] })).toBe("de");
  });

  it("narrows unknown input safely", () => {
    expect(isSupportedLocale("fr")).toBe(true);
    expect(isSupportedLocale("FR")).toBe(false);
    expect(isSupportedLocale(42)).toBe(false);
  });
});

describe("dates", () => {
  it("formats the same instant differently per locale, and never as en-US", () => {
    const fr = formatDate("fr", INSTANT);
    const en = formatDate("en", INSTANT);
    const de = formatDate("de", INSTANT);
    expect(fr).toBe("12/08/2026");
    expect(en).toBe("12/08/2026");
    // German uses dots and a two-digit year for `dateStyle: "short"` - neither a hardcoded
    // format string nor an en-US formatter could produce this.
    expect(de).toBe("12.08.26");
    // en-US would render 8/12/2026; assert we never do.
    expect([fr, en, de]).not.toContain("8/12/2026");
  });

  it("renders times in Europe/Paris, not UTC", () => {
    // 12:34 UTC is 14:34 in Paris in August.
    for (const locale of SUPPORTED_LOCALES) {
      expect(formatDateTime(locale, INSTANT)).toContain("14:34");
    }
  });

  it("accepts Date, epoch millis and ISO strings alike", () => {
    expect(formatDate("de", new Date(INSTANT))).toBe(formatDate("de", INSTANT));
    expect(formatDate("de", "2026-08-12T12:34:56Z")).toBe(formatDate("de", INSTANT));
  });

  it("rejects an unparseable date loudly instead of rendering 'Invalid Date'", () => {
    expect(() => formatDate("en", "not-a-date")).toThrow(TypeError);
  });
});

describe("numbers", () => {
  it("uses each locale's own grouping and decimal separators", () => {
    // Non-breaking / narrow-no-break spaces are what Intl actually emits for fr-FR grouping.
    expect(
      formatNumber("fr", 1234567.89, { maximumFractionDigits: 2 }).replace(/[\s\u00a0\u202f]/g, " "),
    ).toBe("1 234 567,89");
    expect(formatNumber("en", 1234567.89, { maximumFractionDigits: 2 })).toBe("1,234,567.89");
    expect(formatNumber("de", 1234567.89, { maximumFractionDigits: 2 })).toBe("1.234.567,89");
  });

  it("formats percentages from a ratio", () => {
    expect(formatPercent("en", 0.873)).toBe("87%");
    expect(formatPercent("de", 0.873).replace(/[\s\u00a0\u202f]/g, " ")).toBe("87 %");
    expect(formatPercent("fr", 0.873).replace(/[\s\u00a0\u202f]/g, " ")).toBe("87 %");
  });

  it("scales byte sizes and localises the mantissa", () => {
    expect(formatBytes("en", 512)).toBe("512 B");
    expect(formatBytes("en", 2_500_000)).toBe("2.5 MB");
    expect(formatBytes("de", 2_500_000)).toBe("2,5 MB");
    expect(formatBytes("fr", 0)).toBe("0 B");
    // Never NaN or negative, whatever it is handed.
    expect(formatBytes("en", Number.NaN)).toBe("0 B");
    expect(formatBytes("en", -5)).toBe("0 B");
  });
});

describe("relative time", () => {
  const now = INSTANT;

  it("picks a sensible unit and localises the wording", () => {
    expect(formatRelativeTime("en", now - 45_000, now)).toBe("45 seconds ago");
    expect(formatRelativeTime("en", now - 3 * 60_000, now)).toBe("3 minutes ago");
    expect(formatRelativeTime("de", now - 3 * 60_000, now)).toBe("vor 3 Minuten");
    expect(formatRelativeTime("fr", now - 3 * 60_000, now)).toBe("il y a 3 minutes");
  });

  it("handles the future direction", () => {
    expect(formatRelativeTime("en", now + 2 * 3_600_000, now)).toBe("in 2 hours");
    expect(formatRelativeTime("de", now + 2 * 3_600_000, now)).toBe("in 2 Stunden");
  });

  it("uses `numeric: auto` so yesterday reads as a word, not a count", () => {
    expect(formatRelativeTime("en", now - 24 * 3_600_000, now)).toBe("yesterday");
    expect(formatRelativeTime("fr", now - 24 * 3_600_000, now)).toBe("hier");
  });

  it("says 'now' rather than 'in 0 seconds' below one second", () => {
    expect(formatRelativeTime("en", now - 100, now)).toBe("now");
  });
});
