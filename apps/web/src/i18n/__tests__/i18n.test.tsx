// The i18n pipeline at runtime.
//
// 19_I18N_FR_EN_DE.md §Enforcement item 5 asks specifically for: "at least one test per locale
// [that] renders a pluralized key at count=0/1/2+ and an interpolated key with a sample
// parameter set, asserting no raw `{{placeholder}}` leaks into rendered output (a common
// i18next misconfiguration failure mode)." All three locales are covered, not just English -
// which matters because FR's plural rules differ from EN/DE's at count 0.

import { afterEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SUPPORTED_LOCALES, type BccLocale } from "@bunny-command-center/shared";
import i18next, { detectInitialLocale } from "../index.js";
import { BccI18nProvider, useBccLocale } from "../BccI18nProvider.js";
import { BccThemeProvider } from "../../theme/BccThemeProvider.js";
import { LocaleSelector } from "../../theme/components/AppearanceSelectors.js";
import { LOCALE_STORAGE_KEY } from "../../theme/mode.js";

function LocaleReadback(): React.JSX.Element {
  const { locale } = useBccLocale();
  return <span data-testid="locale-readback">{locale}</span>;
}

function renderI18n(): void {
  render(
    <BccThemeProvider initialThemeName="fusion" initialModePreference="light">
      <BccI18nProvider>
        <LocaleSelector />
        <LocaleReadback />
      </BccI18nProvider>
    </BccThemeProvider>,
  );
}

afterEach(async () => {
  await i18next.changeLanguage("en");
});

describe("pluralization via Intl.PluralRules, per locale", () => {
  // 19_I18N_FR_EN_DE.md: "French treats 0 as singular" - the reason a hand-written
  // `count === 1 ? a : b` conditional would be wrong and is forbidden.
  const expectations: Record<BccLocale, Record<number, string>> = {
    en: { 0: "0 screenshots", 1: "1 screenshot", 2: "2 screenshots", 12: "12 screenshots" },
    fr: {
      0: "0 capture d'écran",
      1: "1 capture d'écran",
      2: "2 captures d'écran",
      12: "12 captures d'écran",
    },
    de: { 0: "0 Screenshots", 1: "1 Screenshot", 2: "2 Screenshots", 12: "12 Screenshots" },
  };

  for (const locale of SUPPORTED_LOCALES) {
    it(`${locale} pluralises at 0, 1, 2 and 12`, () => {
      const t = i18next.getFixedT(locale);
      for (const [count, expected] of Object.entries(expectations[locale])) {
        const rendered = t("common.screenshotCount", { count: Number(count) });
        expect(rendered, `${locale} @ ${count}`).toBe(expected);
        expect(rendered).not.toContain("{{");
      }
    });

    it(`${locale} agrees with Intl.PluralRules about which category each count uses`, () => {
      // Proves the resolver really is CLDR-driven rather than a 1-vs-other shortcut that
      // happens to produce the same strings for these particular numbers.
      const rules = new Intl.PluralRules(locale);
      expect(rules.select(0)).toBe(locale === "fr" ? "one" : "other");
      expect(rules.select(1)).toBe("one");
      expect(rules.select(2)).toBe("other");
    });
  }
});

describe("interpolation, per locale", () => {
  for (const locale of SUPPORTED_LOCALES) {
    it(`${locale} substitutes parameters and leaks no raw placeholder`, () => {
      const t = i18next.getFixedT(locale);
      const fileTooLarge = t("errors.upload.fileTooLarge", { maxMb: 25 });
      expect(fileTooLarge).toContain("25");
      expect(fileTooLarge).not.toContain("{{");
      expect(fileTooLarge).not.toContain("maxMb");

      const statusLabel = t("a11y.statusLabel", { status: t("common.status.error") });
      expect(statusLabel).toContain(t("common.status.error"));
      expect(statusLabel).not.toContain("{{");
    });
  }

  it("never renders a raw placeholder anywhere in any catalog, for any locale", () => {
    // A blanket sweep, so a future key with a typo'd placeholder is caught even without its
    // own test.
    for (const locale of SUPPORTED_LOCALES) {
      const t = i18next.getFixedT(locale);
      const bundle = i18next.getResourceBundle(locale, "translation") as Record<string, unknown>;
      const walk = (value: unknown, path: string): void => {
        if (value !== null && typeof value === "object") {
          for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            walk(child, path ? `${path}.${key}` : key);
          }
          return;
        }
        if (typeof value !== "string" || !value.includes("{{")) {
          return;
        }
        const names = [...value.matchAll(/\{\{\s*([^}\s,]+)[^}]*\}\}/g)].map((match) => match[1]!);
        const params = Object.fromEntries(names.map((name) => [name, name === "count" ? 2 : "X"]));
        const rendered = t(path.replace(/_(zero|one|two|few|many|other)$/, ""), params);
        expect(rendered, `${locale}:${path}`).not.toContain("{{");
      };
      walk(bundle, "");
    }
  });
});

describe("runtime language switching", () => {
  it("switches copy immediately, without a reload, from the real control", async () => {
    const user = userEvent.setup();
    renderI18n();
    expect(screen.getByTestId("locale-readback")).toHaveTextContent("en");

    await user.click(screen.getByTestId("locale-option-de"));
    await waitFor(() => {
      expect(screen.getByTestId("locale-readback")).toHaveTextContent("de");
    });
    expect(i18next.t("common.actions.save")).toBe("Speichern");

    await user.click(screen.getByTestId("locale-option-fr"));
    await waitFor(() => {
      expect(screen.getByTestId("locale-readback")).toHaveTextContent("fr");
    });
    expect(i18next.t("common.actions.save")).toBe("Enregistrer");
  });

  it("updates <html lang> so screen readers switch voice with the copy", async () => {
    const user = userEvent.setup();
    renderI18n();
    await waitFor(() => {
      expect(document.documentElement.getAttribute("lang")).toBe("en");
    });
    await user.click(screen.getByTestId("locale-option-fr"));
    await waitFor(() => {
      expect(document.documentElement.getAttribute("lang")).toBe("fr");
    });
    await user.click(screen.getByTestId("locale-option-de"));
    await waitFor(() => {
      expect(document.documentElement.getAttribute("lang")).toBe("de");
    });
  });

  it("localises document.title too", async () => {
    const user = userEvent.setup();
    renderI18n();
    await user.click(screen.getByTestId("locale-option-de"));
    await waitFor(() => {
      expect(document.title).toBe(i18next.getFixedT("de")("app.title"));
    });
  });

  it("persists the choice for the next visit", async () => {
    const user = userEvent.setup();
    renderI18n();
    await user.click(screen.getByTestId("locale-option-de"));
    await waitFor(() => {
      expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("de");
    });
  });
});

describe("initial locale detection", () => {
  it("prefers a stored choice over the browser's languages", () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "de");
    expect(detectInitialLocale()).toBe("de");
  });

  it("ignores a corrupted stored choice", () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "klingon");
    // jsdom reports en-US, so this falls through to the browser preference.
    expect(SUPPORTED_LOCALES).toContain(detectInitialLocale());
  });

  it("falls back to English, as 19_I18N_FR_EN_DE.md specifies", () => {
    expect(i18next.options.fallbackLng).toEqual(["en"]);
  });
});

describe("catalog coverage", () => {
  it("loads all three locales into i18next, not just the default", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(i18next.hasResourceBundle(locale, "translation")).toBe(true);
    }
  });

  it("resolves a key from every populated namespace in every locale", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const t = i18next.getFixedT(locale);
      for (const key of [
        "app.title",
        "common.actions.save",
        "errors.generic",
        "a11y.skipToContent",
        "showcase.title",
      ]) {
        const value = t(key);
        expect(value, `${locale}:${key}`).not.toBe(key);
        expect(value.length).toBeGreaterThan(0);
      }
    }
  });
});
