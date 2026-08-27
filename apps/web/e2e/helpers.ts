import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

/** The shape of the locale catalogs, narrowed to the parts the browser specs assert on. */
export interface Catalog {
  app: { title: string };
  common: { status: Record<string, string>; nav: Record<string, string> };
  showcase: { title: string };
  errors: { guildNotAccessible: { title: string }; forbiddenGuild: { title: string } };
  // Step 10 external-review correction round, Phase 3 (onboarding.spec.ts).
  onboarding: {
    checklist: { heading: string };
    sections: Record<string, { title: string }> & {
      seasonQuotas: { title: string; acceptDefaults: string };
      notifications: { title: string; inApp: string };
    };
    actions: { requestActivation: string; pause: string };
    pending: { title: string; unlocks: Record<string, string> };
  };
  superadmin: {
    review: { title: string; actions: { approve: string } };
  };
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

/** Shared Playwright `storageState` file `auth.setup.ts` writes and `playwright.config.ts` applies to every project that needs an authenticated session (Step 04). */
export const STORAGE_STATE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".auth",
  "session.json",
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

/** Geometric tolerance in CSS pixels - ordinary sub-pixel layout rounding, nothing else. */
const GEOMETRIC_TOLERANCE_PX = 1;

export interface HorizontalOverflowResult {
  /**
   * True only when the page is ACTUALLY horizontally scrollable (the real scroll probe below
   * moved), or a real element visibly exceeds the viewport by more than the 1px geometric
   * tolerance. `scrollWidth`/`clientWidth` disagreeing on their own is NOT sufficient - see
   * `detail` for why that distinction is load-bearing here.
   */
  overflow: boolean;
  /** Every measured metric plus the scroll-probe outcome, for a precise assertion message. */
  detail: string;
}

/**
 * Determines whether the page has REAL, user-reachable horizontal overflow at the current
 * viewport - not merely whether `scrollWidth` and `clientWidth` disagree.
 *
 * Why this distinction matters (found chasing a real 320px/German CI failure): a first version
 * of this check compared `document.documentElement.scrollWidth` to `clientWidth` with a 1px
 * tolerance. Two real bugs were found and fixed that way (a `mobile-chromium` device-emulation
 * viewport mismatch, and a `Stack` double-spacing bug) - but after both fixes, the exact same
 * `scrollWidth=329 clientWidth=320` reading persisted, bit-for-bit, on `desktop-chromium` (no
 * device emulation involved), never reproduced on a local Windows Chromium running the
 * identical Chromium build CI uses, and no failure screenshot ever showed anything visibly
 * clipped. That combination matches a documented class of Chromium behavior: `scrollWidth`/
 * `scrollHeight` can exceed `clientWidth`/`clientHeight` even with no visible scrollbar, and
 * `position: fixed` + `inset` can disagree with the scrollbar gutter's effect on viewport
 * metrics - both differing between Windows and Ubuntu's native scrollbar rendering, which is
 * exactly the two platforms in play (local dev machine vs. the CI runner). Padding the
 * tolerance to "cover" that reading was rejected as a weakened gate during review, correctly:
 * a bigger number is not evidence, it is a guess.
 *
 * The actual, unambiguous question a real user cares about is "can I scroll sideways and see
 * more content" - so this asks the browser to do exactly that: scroll as far right as it will
 * go, then check whether it actually moved. If there is nothing to scroll to, the browser
 * clamps back to (at most) a sub-pixel value regardless of what `scrollWidth` claims. This is
 * combined with a tightened (1px, not 10px) per-element bounding-rect check, so a real element
 * that visibly exceeds the viewport is still caught even in the (untested-in-practice) case
 * where the scroll probe itself is inconclusive.
 */
export async function checkHorizontalOverflow(page: Page): Promise<HorizontalOverflowResult> {
  return page.evaluate(async (tolerance) => {
    // Two DISTINCT signals, deliberately not conflated (found chasing a real German/960px CI-only
    // false positive on `.MuiBadge-root`, an `overflow: visible` + absolutely-positioned-child
    // shape - see this function's own header comment for the closely related, previously-fixed
    // Windows-vs-Ubuntu `scrollWidth`/`clientWidth` measurement quirk this is another instance of):
    //
    // - `positioned`: an element's OWN BOX (`getBoundingClientRect()`) actually breaches the
    //   viewport - this is real, user-visible overflow no matter what causes it.
    // - `internal`: an element's OWN CONTENT overflows its OWN box (`scrollWidth > clientWidth`)
    //   while the element's own box stays fully inside the viewport. This is NOT by itself
    //   evidence of a viewport breach - an `overflow: visible` container's absolutely-positioned
    //   child (exactly what MUI's `Badge` is) intentionally paints outside the parent's content
    //   box while both elements can remain entirely on-screen, and some Chromium builds report a
    //   nonzero `scrollWidth` delta for this shape that others don't, independent of anything
    //   actually being visually wrong.
    function widestOffender(): { positioned: string; internal: string } {
      const limit = document.documentElement.clientWidth;
      let worstPositioned = "";
      let worstRight = limit;
      let worstLeft = 0;
      // Every element whose OWN internal content overflows its OWN box (scrollWidth > its own
      // clientWidth). Unclipped overflow propagates upward, so an ancestor near the root will
      // almost always show this too once any descendant does - collected in document order
      // (parents before children) and reported as only the last few (deepest, most specific)
      // matches, not the whole propagated chain. Diagnostic only - see header comment above.
      const internalOverflow: string[] = [];
      // `html`/`body` themselves, not just their descendants: a mismatch between an element's
      // own position (getBoundingClientRect) and its own internal overflow (scrollWidth vs
      // clientWidth) can exist on `<body>` itself without any child individually breaching the
      // viewport - checked here too, not only the position-based scan below.
      const candidates: Element[] = [
        document.documentElement,
        document.body,
        ...document.querySelectorAll("body *"),
      ];
      for (const element of candidates) {
        const rect = element.getBoundingClientRect();
        const label = `${element.tagName.toLowerCase()}.${element.className.toString().slice(0, 60)}`;
        if (rect.right > worstRight + tolerance) {
          worstRight = rect.right;
          worstPositioned = `${label} right=${Math.round(rect.right)} limit=${limit}`;
        }
        if (rect.left < worstLeft - tolerance) {
          worstLeft = rect.left;
          worstPositioned = `${label} left=${Math.round(rect.left)} (extends before x=0)`;
        }
        // An element's own box can sit fully inside the viewport while its CONTENT still
        // overflows it (e.g. an `overflow: visible` flex/grid container whose children don't
        // individually breach the viewport either) - scrollWidth vs clientWidth on the element
        // itself catches that shape of bug, which position alone cannot. Kept as a diagnostic
        // (see `detail` below) - not, by itself, sufficient to fail this check (header comment).
        if (element instanceof HTMLElement && element.scrollWidth > element.clientWidth + tolerance) {
          internalOverflow.push(`${label}(scroll=${element.scrollWidth} own-client=${element.clientWidth})`);
        }
      }
      return {
        positioned: worstPositioned,
        internal: internalOverflow.slice(-5).join(" < "),
      };
    }

    const doc = document.documentElement;
    const scrollingEl = document.scrollingElement ?? doc;
    const metrics = {
      documentElementClientWidth: doc.clientWidth,
      documentElementScrollWidth: doc.scrollWidth,
      scrollingElementClientWidth: scrollingEl.clientWidth,
      scrollingElementScrollWidth: scrollingEl.scrollWidth,
      windowInnerWidth: window.innerWidth,
      visualViewportWidth: window.visualViewport ? Math.round(window.visualViewport.width) : null,
    };

    const originalScrollX = window.scrollX;
    const originalScrollY = window.scrollY;

    // The authoritative probe: ask the browser to scroll right as far as it possibly can, wait
    // for that to settle, then read back where it actually ended up.
    window.scrollTo({ left: 999_999, top: originalScrollY, behavior: "instant" });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const scrollXAfterProbe = window.scrollX;
    const scrollLeftAfterProbe = scrollingEl.scrollLeft;

    // Always restore exactly where the test found the page - this probe must never change what
    // the rest of the test observes, pass or fail.
    window.scrollTo({ left: originalScrollX, top: originalScrollY, behavior: "instant" });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const reallyScrollable = scrollXAfterProbe > tolerance || scrollLeftAfterProbe > tolerance;
    const { positioned, internal } = widestOffender();
    // The boolean gate follows its documented contract exactly: real user-reachable horizontal
    // scroll, OR a real element whose OWN BOX breaches the viewport. Internal-only overflow
    // (`internal` populated, `positioned` empty) is surfaced in `detail` for diagnosis but never
    // flips this to `true` on its own.
    const overflow = reallyScrollable || positioned !== "";

    const offenderSummary = [
      positioned && `positioned: ${positioned}`,
      internal && `internal-overflow chain (root..deepest, last 5, diagnostic only): ${internal}`,
    ]
      .filter(Boolean)
      .join(" || ");

    const detail =
      `documentElement(client=${metrics.documentElementClientWidth} scroll=${metrics.documentElementScrollWidth}) ` +
      `scrollingElement(client=${metrics.scrollingElementClientWidth} scroll=${metrics.scrollingElementScrollWidth}) ` +
      `windowInnerWidth=${metrics.windowInnerWidth} visualViewportWidth=${metrics.visualViewportWidth} ` +
      `scrollProbe(scrollX=${scrollXAfterProbe} scrollLeft=${scrollLeftAfterProbe} reallyScrollable=${reallyScrollable}) ` +
      `widestOffender=${offenderSummary || "(none)"}`;

    return { overflow, detail };
  }, GEOMETRIC_TOLERANCE_PX);
}
