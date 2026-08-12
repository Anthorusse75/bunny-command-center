// A controllable `window.matchMedia` for component tests.
//
// Needed for two reasons that both matter to this step's acceptance criteria:
//
//  1. jsdom does not implement media-query evaluation, so `useMediaQuery` would always take
//     its fallback and the breakpoint swap at 960px (02_design_system_i18n.md §ACCEPTANCE
//     CRITERIA) could not be tested at all. This mock evaluates real `min-width`/`max-width`
//     queries against a settable viewport width.
//  2. "Live `prefers-color-scheme` change handling" (same document) is only provable by
//     firing a real change on the media query MUI subscribed to. `setSystemColorScheme()`
//     below re-evaluates every live query and notifies its listeners exactly as a browser
//     would - including through the deprecated `addListener` API, which is the one MUI
//     actually uses (@mui/system/cssVars/useCurrentColorScheme.js:192) for iOS
//     compatibility. A mock that only supported `addEventListener` would pass while the real
//     subscription silently never fired.

interface Listener {
  (event: MediaQueryListEvent): void;
}

interface MockMediaQueryList {
  media: string;
  matches: boolean;
  onchange: Listener | null;
  addListener: (listener: Listener) => void;
  removeListener: (listener: Listener) => void;
  addEventListener: (type: string, listener: Listener) => void;
  removeEventListener: (type: string, listener: Listener) => void;
  dispatchEvent: (event: Event) => boolean;
}

interface MediaState {
  viewportWidth: number;
  prefersDark: boolean;
  prefersReducedMotion: boolean;
}

const DEFAULT_STATE: MediaState = {
  viewportWidth: 1280,
  prefersDark: false,
  prefersReducedMotion: false,
};

let state: MediaState = { ...DEFAULT_STATE };
const liveQueries = new Set<{ list: MockMediaQueryList; listeners: Set<Listener> }>();

function evaluate(media: string): boolean {
  const normalised = media.replace(/\s+/g, "").toLowerCase();
  if (normalised.includes("prefers-color-scheme:dark")) {
    return state.prefersDark;
  }
  if (normalised.includes("prefers-color-scheme:light")) {
    return !state.prefersDark;
  }
  if (normalised.includes("prefers-reduced-motion:reduce")) {
    return state.prefersReducedMotion;
  }
  let result = true;
  let matchedAnything = false;
  for (const match of normalised.matchAll(/min-width:([\d.]+)px/g)) {
    matchedAnything = true;
    result = result && state.viewportWidth >= Number.parseFloat(match[1]!);
  }
  for (const match of normalised.matchAll(/max-width:([\d.]+)px/g)) {
    matchedAnything = true;
    result = result && state.viewportWidth <= Number.parseFloat(match[1]!);
  }
  return matchedAnything ? result : false;
}

function notifyAll(): void {
  for (const entry of liveQueries) {
    const next = evaluate(entry.list.media);
    if (next === entry.list.matches) {
      continue;
    }
    entry.list.matches = next;
    const event = { matches: next, media: entry.list.media } as MediaQueryListEvent;
    entry.list.onchange?.(event);
    for (const listener of entry.listeners) {
      listener(event);
    }
  }
}

export function installMatchMediaMock(): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (media: string): MockMediaQueryList => {
      const listeners = new Set<Listener>();
      const list: MockMediaQueryList = {
        media,
        matches: evaluate(media),
        onchange: null,
        addListener: (listener) => listeners.add(listener),
        removeListener: (listener) => listeners.delete(listener),
        addEventListener: (_type, listener) => listeners.add(listener),
        removeEventListener: (_type, listener) => listeners.delete(listener),
        dispatchEvent: () => true,
      };
      liveQueries.add({ list, listeners });
      return list;
    },
  });
}

export function resetMatchMediaMock(): void {
  state = { ...DEFAULT_STATE };
  liveQueries.clear();
}

/** Sets the emulated viewport width used by `min-width`/`max-width` queries. */
export function setViewportWidth(width: number): void {
  state.viewportWidth = width;
  notifyAll();
}

/**
 * Emulates the user changing their OS light/dark setting *while the app is running* - the
 * exact scenario "SYSTEM must track `prefers-color-scheme` live (no reload needed)" describes.
 */
export function setSystemColorScheme(scheme: "light" | "dark"): void {
  state.prefersDark = scheme === "dark";
  notifyAll();
}

export function setPrefersReducedMotion(reduce: boolean): void {
  state.prefersReducedMotion = reduce;
  notifyAll();
}
