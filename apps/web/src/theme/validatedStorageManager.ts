// A storage manager for MUI's ThemeProvider that refuses to trust localStorage.
//
// Why this exists (found by a failing test, not by inspection): MUI's ThemeProvider reads the
// mode preference from localStorage itself and uses the raw string as-is. Validating in
// `readStoredModePreference()` therefore only guarded OUR fallback - a hand-edited or stale
// value like `"sepia"` still reached MUI's state and left the app in a mode with no palette.
// This wrapper validates on read, discards anything invalid, and self-heals the stored value
// so the next read is clean.
//
// It also keeps the `subscribe` channel (MUI uses it for cross-tab sync via the `storage`
// event) validating, so another tab writing a bad value cannot break this one either.

import { isModePreference } from "./mode.js";
import { BCC_MODES, DEFAULT_MODE_PREFERENCE } from "./tokens/types.js";

type Handler = (value: string | null) => void;

interface StorageAccessor {
  get(defaultValue: unknown): unknown;
  set(value: unknown): void;
  subscribe(handler: Handler): () => void;
}

/** MUI stores the mode under one key and a colour-scheme name under two others. */
function isValidForKey(key: string, value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  if (key.endsWith("mode")) {
    return isModePreference(value);
  }
  return (BCC_MODES as readonly string[]).includes(value);
}

export function createValidatedStorageManager(): (options: {
  key: string;
  storageWindow?: Window | null | undefined;
}) => StorageAccessor {
  return ({ key, storageWindow }) => {
    const target = storageWindow ?? (typeof window === "undefined" ? null : window);
    return {
      get(defaultValue: unknown): unknown {
        if (!target) {
          return defaultValue;
        }
        let raw: string | null;
        try {
          raw = target.localStorage.getItem(key);
        } catch {
          return defaultValue;
        }
        if (raw === null) {
          return defaultValue;
        }
        if (isValidForKey(key, raw)) {
          return raw;
        }
        // Self-heal: drop the bad entry so it cannot keep resurfacing on every load.
        try {
          target.localStorage.removeItem(key);
        } catch {
          /* storage disabled */
        }
        return defaultValue ?? DEFAULT_MODE_PREFERENCE;
      },
      set(value: unknown): void {
        if (!target) {
          return;
        }
        try {
          if (value === null || value === undefined) {
            target.localStorage.removeItem(key);
          } else if (isValidForKey(key, value)) {
            target.localStorage.setItem(key, value as string);
          }
        } catch {
          /* storage disabled */
        }
      },
      subscribe(handler: Handler): () => void {
        if (!target) {
          return () => undefined;
        }
        const listener = (event: StorageEvent): void => {
          if (event.storageArea !== target.localStorage || event.key !== key) {
            return;
          }
          if (event.newValue === null) {
            handler(null);
            return;
          }
          if (isValidForKey(key, event.newValue)) {
            handler(event.newValue);
          }
        };
        target.addEventListener("storage", listener);
        return () => target.removeEventListener("storage", listener);
      },
    };
  };
}
