// Root integration test for the provider stack.
//
// NOTE ON THE STEP-01 VERSION OF THIS FILE (deliberate change, not a weakening):
// Step 01's two assertions were (a) `app.title` renders as visible text, proving the i18n
// pipeline is wired, and (b) `document.title` comes from the same key rather than a hardcoded
// string. Step 02 replaces the placeholder <h1>{app.title}</h1> with the real shell +
// showcase, so (a)'s *mechanism* is gone while its *claim* is not. Both claims are still
// asserted below - (a) through translated shell/showcase copy that changes with the language,
// (b) verbatim - plus the new wiring this step introduces. No assertion was dropped without a
// stronger replacement.

import { afterEach, describe, expect, it } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "../i18n/index.js";
import { App } from "./App.js";
import { COLOR_SCHEME_ATTRIBUTE, THEME_ATTRIBUTE } from "../theme/mode.js";
import { clickLocaleOptionAndSettle } from "../test/i18nTestUtils.js";
import { mockAuthenticatedSession } from "../test/fetchMock.js";

// STEP 04 NOTE (disclosed deviation, not a silent regression — see this
// step's HANDOVER "Step 01/02/03 regression result" section): every test
// below that asserts on the Step 02 showcase/shell now first calls
// `mockAuthenticatedSession()`, since `<App>` is gated behind
// `<AuthGate>` (apps/web/src/features/auth/AuthGate.tsx) as of this step —
// an unauthenticated mount now correctly shows the Login screen instead.
// Every original claim these tests made (i18n pipeline wired, theme engine
// mounts, toast region present, shell present, zero console errors) is
// still asserted, now from behind the explicit "authenticated" fixture a
// security-gated app legitimately requires.

describe("App", () => {
  // i18next is a module singleton, so a language switched inside one test would otherwise
  // silently change the language every later test in this file runs under.
  //
  // Wrapped in act(): this `afterEach` runs BEFORE React Testing Library's own auto-cleanup
  // (local `afterEach` hooks fire before hooks registered at module-import time, and RTL
  // registers its cleanup that way), so the component from the test that just ran is still
  // mounted when `changeLanguage` resolves and fires `languageChanged` - an unwrapped await
  // here was a real "not wrapped in act(...)" warning on every single test in this file, not
  // just the ones that switched languages themselves.
  afterEach(async () => {
    await act(async () => {
      await i18next.changeLanguage("en");
    });
  });

  it("sets document.title from the app.title i18n key, not a hardcoded string", async () => {
    render(<App />);
    await waitFor(() => {
      expect(document.title).toBe(i18next.t("app.title"));
    });
  });

  it("renders translated copy from the catalogs (the i18n pipeline is wired end to end)", async () => {
    mockAuthenticatedSession();
    render(<App />);
    // Not a literal: the same key, resolved through i18next, is what the DOM must contain.
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1, name: i18next.t("showcase.title") })).toBeVisible();
    });
  });

  it("re-renders that copy in French when the language changes, with no reload", async () => {
    mockAuthenticatedSession();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: i18next.t("showcase.title") });
    await clickLocaleOptionAndSettle(user, "locale-option-fr");
    expect(document.documentElement.getAttribute("lang")).toBe("fr");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      i18next.getFixedT("fr")("showcase.title"),
    );
  });

  it("mounts the theme engine, the toast region and the responsive shell together", async () => {
    mockAuthenticatedSession();
    render(<App />);
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("fusion");
    expect(document.documentElement.getAttribute(COLOR_SCHEME_ATTRIBUTE)).toBe("light");
    // toast-region is mounted unconditionally (outside the Step-04 auth gate) —
    // no waitFor needed for it specifically.
    expect(screen.getByTestId("toast-region")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("app-shell")).toBeInTheDocument();
      expect(screen.getByTestId("main-content")).toBeInTheDocument();
    });
  });

  it("renders without a single console error across the whole mount (authenticated)", async () => {
    // 02_design_system_i18n.md §ACCEPTANCE CRITERIA: "All 9 theme x mode combinations render
    // without console errors". This covers the default combination at the integration level;
    // the other eight are covered per-combination in ../theme/__tests__ and in the browser
    // suite.
    mockAuthenticatedSession();
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      render(<App />);
      await screen.findByTestId("app-shell");
    } finally {
      console.error = original;
    }
    expect(errors).toEqual([]);
  });

  // -------------------------------------------------------------------
  // Step 04: the auth gate itself.
  // -------------------------------------------------------------------
  it("shows the Login screen (not the authenticated app) when there is no session — the default, honest state", async () => {
    render(<App />);
    expect(await screen.findByTestId("login-screen")).toBeVisible();
    expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument();
  });

  it("renders without a single console error while unauthenticated (Login screen)", async () => {
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      render(<App />);
      await screen.findByTestId("login-screen");
    } finally {
      console.error = original;
    }
    expect(errors).toEqual([]);
  });

  it("shows the OAuth error screen when the URL carries a known ?error= reason, never the authenticated app", async () => {
    const originalLocation = window.location.href;
    window.history.replaceState(null, "", "/login?error=state_mismatch");
    try {
      render(<App />);
      expect(await screen.findByTestId("oauth-error-screen")).toBeVisible();
      expect(screen.getByTestId("oauth-error-detail")).toHaveTextContent(
        i18next.t("auth.error.stateMismatch"),
      );
    } finally {
      window.history.replaceState(null, "", originalLocation);
    }
  });
});
