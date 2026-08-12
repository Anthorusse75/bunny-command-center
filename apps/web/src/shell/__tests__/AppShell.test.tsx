// The breakpoint-swap mechanism, proven rather than assumed.
//
// 02_design_system_i18n.md §ACCEPTANCE CRITERIA: "the shell correctly swaps bottom-nav/sidebar
// at the 960px breakpoint". Every boundary case around 960 is asserted, plus the 600px band
// that 21_MOBILE_UX.md §Tablet-specific decisions assigns to the mobile pattern.

import { describe, expect, it } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "../../i18n/index.js";
import { BccI18nProvider } from "../../i18n/BccI18nProvider.js";
import { BccThemeProvider } from "../../theme/BccThemeProvider.js";
import { setViewportWidth } from "../../test/matchMedia.js";
import { AppShell, SIDEBAR_STORAGE_KEY } from "../AppShell.js";

function renderShell(): void {
  render(
    <BccThemeProvider initialThemeName="fusion" initialModePreference="light">
      <BccI18nProvider>
        <AppShell>
          <p>content</p>
        </AppShell>
      </BccI18nProvider>
    </BccThemeProvider>,
  );
}

describe("AppShell — breakpoint swap", () => {
  it.each([
    [320, "mobile"],
    [375, "mobile"],
    [599, "mobile"],
    [600, "mobile"],
    [959, "mobile"],
    [960, "desktop"],
    [1280, "desktop"],
    [1920, "desktop"],
  ])("at %ipx the layout is %s", (width, expected) => {
    setViewportWidth(width);
    renderShell();
    expect(screen.getByTestId("app-shell")).toHaveAttribute("data-layout", expected);
    if (expected === "desktop") {
      expect(screen.getByTestId("sidebar")).toBeInTheDocument();
      expect(screen.queryByTestId("bottom-nav")).not.toBeInTheDocument();
    } else {
      expect(screen.getByTestId("bottom-nav")).toBeInTheDocument();
      expect(screen.queryByTestId("sidebar")).not.toBeInTheDocument();
    }
  });

  it("swaps live when the viewport crosses 960px, from one component tree", async () => {
    setViewportWidth(1280);
    renderShell();
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();

    act(() => {
      setViewportWidth(600);
    });
    await waitFor(() => {
      expect(screen.getByTestId("bottom-nav")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("sidebar")).not.toBeInTheDocument();

    act(() => {
      setViewportWidth(1024);
    });
    await waitFor(() => {
      expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    });
  });
});

describe("AppShell — navigation chrome is present but empty (Step 06 fills it)", () => {
  it("exposes a labelled navigation landmark on both layouts", () => {
    setViewportWidth(390);
    renderShell();
    expect(screen.getByRole("navigation", { name: i18next.t("a11y.bottomNavigation") })).toBeInTheDocument();
  });

  it("has no navigation items yet", () => {
    setViewportWidth(390);
    renderShell();
    expect(screen.getByTestId("bottom-nav-items").children).toHaveLength(0);
    act(() => {
      setViewportWidth(1280);
    });
    expect(screen.getByTestId("sidebar-items").children).toHaveLength(0);
  });
});

describe("AppShell — collapsible sidebar", () => {
  it("collapses and expands from the keyboard, with an accessible name that changes", async () => {
    const user = userEvent.setup();
    setViewportWidth(1280);
    renderShell();

    const sidebar = screen.getByTestId("sidebar");
    expect(sidebar).toHaveAttribute("data-collapsed", "false");

    const toggle = screen.getByRole("button", { name: i18next.t("a11y.sidebar.collapse") });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    toggle.focus();
    expect(toggle).toHaveFocus();
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "true");
    });
    const expandToggle = screen.getByRole("button", { name: i18next.t("a11y.sidebar.expand") });
    expect(expandToggle).toHaveAttribute("aria-expanded", "false");

    await user.click(expandToggle);
    await waitFor(() => {
      expect(screen.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "false");
    });
  });

  it("persists the collapsed state (22_DESKTOP_UX.md: sidebar state persists per user)", async () => {
    const user = userEvent.setup();
    setViewportWidth(1280);
    renderShell();
    await user.click(screen.getByTestId("sidebar-toggle"));
    await waitFor(() => {
      expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("true");
    });
  });

  it("restores a previously collapsed sidebar on the next visit", () => {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, "true");
    setViewportWidth(1280);
    renderShell();
    expect(screen.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "true");
  });
});

describe("AppShell — accessibility scaffolding", () => {
  it("offers a skip link as the first tab stop, pointing at the main landmark", async () => {
    const user = userEvent.setup();
    setViewportWidth(1280);
    renderShell();

    await user.tab();
    const skip = screen.getByTestId("skip-link");
    expect(skip).toHaveFocus();
    expect(skip).toHaveAttribute("href", "#bcc-main-content");
    expect(skip).toHaveTextContent(i18next.t("a11y.skipToContent"));
    expect(screen.getByTestId("main-content")).toHaveAttribute("id", "bcc-main-content");
  });

  it("renders exactly one main landmark, programmatically focusable for route changes", () => {
    setViewportWidth(1280);
    renderShell();
    const main = screen.getByRole("main");
    expect(main).toBe(screen.getByTestId("main-content"));
    expect(main).toHaveAttribute("tabindex", "-1");
  });
});
