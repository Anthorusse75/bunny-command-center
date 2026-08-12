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
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "../i18n/index.js";
import { App } from "./App.js";
import { COLOR_SCHEME_ATTRIBUTE, THEME_ATTRIBUTE } from "../theme/mode.js";

describe("App", () => {
  // i18next is a module singleton, so a language switched inside one test would otherwise
  // silently change the language every later test in this file runs under.
  afterEach(async () => {
    await i18next.changeLanguage("en");
  });

  it("sets document.title from the app.title i18n key, not a hardcoded string", async () => {
    render(<App />);
    await waitFor(() => {
      expect(document.title).toBe(i18next.t("app.title"));
    });
  });

  it("renders translated copy from the catalogs (the i18n pipeline is wired end to end)", () => {
    render(<App />);
    // Not a literal: the same key, resolved through i18next, is what the DOM must contain.
    expect(screen.getByRole("heading", { level: 1, name: i18next.t("showcase.title") })).toBeVisible();
  });

  it("re-renders that copy in French when the language changes, with no reload", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("locale-option-fr"));
    await waitFor(() => {
      expect(document.documentElement.getAttribute("lang")).toBe("fr");
    });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      i18next.getFixedT("fr")("showcase.title"),
    );
  });

  it("mounts the theme engine, the toast region and the responsive shell together", () => {
    render(<App />);
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("fusion");
    expect(document.documentElement.getAttribute(COLOR_SCHEME_ATTRIBUTE)).toBe("light");
    expect(screen.getByTestId("app-shell")).toBeInTheDocument();
    expect(screen.getByTestId("toast-region")).toBeInTheDocument();
    expect(screen.getByTestId("main-content")).toBeInTheDocument();
  });

  it("renders without a single console error across the whole mount", () => {
    // 02_design_system_i18n.md §ACCEPTANCE CRITERIA: "All 9 theme x mode combinations render
    // without console errors". This covers the default combination at the integration level;
    // the other eight are covered per-combination in ../theme/__tests__ and in the browser
    // suite.
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      render(<App />);
    } finally {
      console.error = original;
    }
    expect(errors).toEqual([]);
  });
});
