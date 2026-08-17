import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "../../../i18n/index.js";
import { BccI18nProvider } from "../../../i18n/BccI18nProvider.js";
import { BccThemeProvider } from "../../../theme/BccThemeProvider.js";
import { LoginScreen } from "../LoginScreen.js";
import { AuthProvider } from "../AuthProvider.js";

async function renderLogin(): Promise<ReturnType<typeof render>> {
  const result = render(
    <BccThemeProvider>
      <BccI18nProvider>
        <AuthProvider>
          <LoginScreen />
        </AuthProvider>
      </BccI18nProvider>
    </BccThemeProvider>,
  );
  // Flushes AuthProvider's own initial session-bootstrap fetch (irrelevant
  // to LoginScreen's own rendering, but its state update must still settle
  // inside act() before the test proceeds — this repo's test/setup.ts fails
  // any test that leaves a "not wrapped in act(...)" warning uncaught).
  await act(async () => {
    await Promise.resolve();
  });
  return result;
}

// Captured before ANY test ever stubs `window.location` — the one stable
// reference a later regression test can compare against to prove real
// restoration happened, not just that `afterEach` ran without throwing.
// Never CALLED, only compared by reference, so the usual "this" concern
// `unbound-method` warns about doesn't apply here.
// eslint-disable-next-line @typescript-eslint/unbound-method -- reference equality only, never invoked
const ORIGINAL_LOCATION_ASSIGN = window.location.assign;

/**
 * jsdom's `window.location.assign` is non-configurable in this repo's
 * installed jsdom version (`vi.spyOn` throws "Cannot redefine property"), so
 * the whole `location` object is swapped for a plain, writable stand-in for
 * the duration of one test — mirrors the standard jsdom-navigation testing
 * workaround.
 *
 * Copilot review finding 2 (Step 04 review pass): correctly caught that this
 * `Object.defineProperty` replacement was NOT actually being restored —
 * `afterEach`'s `vi.unstubAllGlobals()` only reverts Vitest's OWN
 * `vi.stubGlobal`-tracked stubs, never a direct `defineProperty` call like
 * this one, so `window.location` stayed permanently replaced by the plain
 * stand-in for every test that ran after the first one to call this
 * function. Fixed by capturing the real property descriptor before
 * replacing it and restoring that EXACT descriptor in `afterEach` below.
 */
let originalLocationDescriptor: PropertyDescriptor | undefined;

function stubLocationAssign(): ReturnType<typeof vi.fn> {
  const assignSpy = vi.fn();
  originalLocationDescriptor = Object.getOwnPropertyDescriptor(window, "location");
  const original = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...original, assign: assignSpy },
  });
  return assignSpy;
}

describe("LoginScreen (SCREENS/AUTH.md §Login)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalLocationDescriptor) {
      Object.defineProperty(window, "location", originalLocationDescriptor);
      originalLocationDescriptor = undefined;
    }
  });

  it("renders the translated title, tagline and CTA — never a hardcoded string", async () => {
    await renderLogin();
    await screen.findByTestId("login-cta");
    expect(screen.getByText(i18next.t("auth.login.title"))).toBeVisible();
    expect(screen.getByText(i18next.t("auth.login.tagline"))).toBeVisible();
    expect(screen.getByTestId("login-cta")).toHaveTextContent(i18next.t("auth.login.cta"));
  });

  it("the CTA is a real, keyboard-operable <button>", async () => {
    await renderLogin();
    const cta = await screen.findByTestId("login-cta");
    expect(cta.tagName).toBe("BUTTON");
  });

  it("clicking the CTA navigates to GET /api/auth/login (a real navigation, not an XHR)", async () => {
    const assignSpy = stubLocationAssign();
    const user = userEvent.setup();
    await renderLogin();
    const cta = await screen.findByTestId("login-cta");
    await user.click(cta);
    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy.mock.calls[0]![0]).toMatch(/^\/api\/auth\/login\?redirect=/);
  });

  it("disables the CTA after click, to prevent a double-click double-navigation", async () => {
    stubLocationAssign();
    const user = userEvent.setup();
    await renderLogin();
    const cta = await screen.findByTestId("login-cta");
    await user.click(cta);
    expect(cta).toBeDisabled();
  });

  it("includes a keyboard-operable language picker", async () => {
    await renderLogin();
    await screen.findByTestId("login-cta");
    expect(screen.getByTestId("locale-selector")).toBeInTheDocument();
    expect(screen.getByTestId("locale-option-fr")).toBeInTheDocument();
    expect(screen.getByTestId("locale-option-de")).toBeInTheDocument();
  });

  // Placed AFTER the two `stubLocationAssign()` tests above so it only
  // proves something if their own `afterEach` genuinely restored the real
  // `window.location` — asserts against the ORIGINAL function reference
  // captured at module load time, before any test ever stubbed it, not
  // merely that `window.location.assign` is "some function" again.
  it("window.location.assign is genuinely restored to the real jsdom implementation after a test that stubbed it — never left as the stand-in spy", () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- reference equality only, never invoked
    expect(window.location.assign).toBe(ORIGINAL_LOCATION_ASSIGN);
  });
});
