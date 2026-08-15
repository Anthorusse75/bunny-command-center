import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

/** The shape of the locale catalogs, narrowed to the parts the browser specs assert on. */
export interface Catalog {
  app: { title: string };
  common: { status: Record<string, string> };
  showcase: { title: string };
}

const CATALOG_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "shared",
  "src",
  "i18n",
);

export function loadCatalog(locale: string): Catalog {
  return JSON.parse(readFileSync(path.join(CATALOG_DIR, `${locale}.json`), "utf-8")) as Catalog;
}

export const THEME_ATTRIBUTE = "data-bcc-theme";
export const COLOR_SCHEME_ATTRIBUTE = "data-bcc-color-scheme";
export const THEME_STORAGE_KEY = "bcc.theme";
export const MODE_STORAGE_KEY = "bcc.mode";
export const LOCALE_STORAGE_KEY = "bcc.locale";

export const THEMES = ["heroic", "premium", "fusion"] as const;
export const MODE_PREFERENCES = ["light", "dark", "system"] as const;
export const LOCALES = ["fr", "en", "de"] as const;

/**
 * Seeds localStorage BEFORE the first navigation, so the blocking pre-paint script sees the
 * preference on its very first run. Setting storage after `goto` would test a reload, not a
 * cold start, and would never exercise the anti-FOUC path.
 */
export async function seedPreferences(
  page: Page,
  preferences: { theme?: string; mode?: string; locale?: string },
): Promise<void> {
  await page.addInitScript((prefs: Record<string, string | undefined>) => {
    if (prefs["theme"]) {
      window.localStorage.setItem("bcc.theme", prefs["theme"]);
    }
    if (prefs["mode"]) {
      window.localStorage.setItem("bcc.mode", prefs["mode"]);
    }
    if (prefs["locale"]) {
      window.localStorage.setItem("bcc.locale", prefs["locale"]);
    }
  }, preferences);
}

export async function readCssVar(page: Page, name: string): Promise<string> {
  return page.evaluate(
    (varName) => getComputedStyle(document.documentElement).getPropertyValue(varName).trim(),
    name,
  );
}

/** Effective background colour of the page canvas, as the engine actually resolved it. */
export async function readBodyBackground(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

export function hexToRgbString(hex: string): string {
  const body = hex.replace("#", "");
  const r = Number.parseInt(body.slice(0, 2), 16);
  const g = Number.parseInt(body.slice(2, 4), 16);
  const b = Number.parseInt(body.slice(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

/** True when any element makes the document scroll sideways at the current viewport. */
export async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    // 1px of tolerance: sub-pixel layout rounding is not an overflow bug.
    return doc.scrollWidth > doc.clientWidth + 1;
  });
}

/**
 * Names the element responsible for `hasHorizontalOverflow`, checking both directions: an
 * element extending past the right edge (`rect.right > clientWidth`) is the common case, but
 * a negative-margin technique (MUI's connected-border `ToggleButtonGroup`, for one) can just
 * as easily push an element's LEFT edge past `x = 0`, which inflates `scrollWidth` exactly the
 * same way and would otherwise go unreported here.
 */
export async function widestOverflowingElement(page: Page): Promise<string> {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    let worst = "";
    let worstRight = limit;
    let worstLeft = 0;
    for (const element of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const rect = element.getBoundingClientRect();
      const label = `${element.tagName.toLowerCase()}.${element.className.toString().slice(0, 60)}`;
      if (rect.right > worstRight + 1) {
        worstRight = rect.right;
        worst = `${label} right=${Math.round(rect.right)} limit=${limit}`;
      }
      if (rect.left < worstLeft - 1) {
        worstLeft = rect.left;
        worst = `${label} left=${Math.round(rect.left)} (extends before x=0)`;
      }
    }
    if (worst) {
      return worst;
    }
    // No single element's own box exceeds the viewport by more than the 1px tolerance, yet
    // `scrollWidth` still does - report the raw numbers so this is distinguishable from "no
    // overflow at all" and from a genuine large single-element offender.
    const doc = document.documentElement;
    return `(no single element individually exceeds the 1px tolerance) scrollWidth=${doc.scrollWidth} clientWidth=${doc.clientWidth} delta=${doc.scrollWidth - doc.clientWidth}`;
  });
}
