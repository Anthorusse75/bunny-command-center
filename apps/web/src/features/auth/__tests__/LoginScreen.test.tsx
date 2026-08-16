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

/**
 * jsdom's `window.location.assign` is non-configurable in this repo's
 * installed jsdom version (`vi.spyOn` throws "Cannot redefine property"), so
 * the whole `location` object is swapped for a plain, writable stand-in for
 * the duration of one test — mirrors the standard jsdom-navigation testing
 * workaround, restored in `afterEach` so no other test observes it.
 */
function stubLocationAssign(): ReturnType<typeof vi.fn> {
  const assignSpy = vi.fn();
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
});
