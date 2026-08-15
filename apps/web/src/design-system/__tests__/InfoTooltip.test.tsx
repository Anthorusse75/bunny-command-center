// The tooltip's whole reason for existing is that hover must never gate the information.
// These tests therefore drive it three ways - pointer, keyboard, touch - and assert the same
// content is reachable each time, at both breakpoints.

import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "../../i18n/index.js";
import { BccI18nProvider } from "../../i18n/BccI18nProvider.js";
import { BccThemeProvider } from "../../theme/BccThemeProvider.js";
import { setViewportWidth } from "../../test/matchMedia.js";
import { InfoTooltip } from "../InfoTooltip.js";

function renderTooltip(): void {
  render(
    <BccThemeProvider initialThemeName="fusion" initialModePreference="light">
      <BccI18nProvider>
        <InfoTooltip contentKey="showcase.tooltips.help" />
      </BccI18nProvider>
    </BccThemeProvider>,
  );
}

const HELP_TEXT = (): string => i18next.t("showcase.tooltips.help");

describe("InfoTooltip — desktop (>= 960px)", () => {
  it("reveals help on hover", async () => {
    const user = userEvent.setup();
    setViewportWidth(1280);
    renderTooltip();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    await user.hover(screen.getByTestId("info-tooltip-trigger"));
    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toHaveTextContent(HELP_TEXT());
    });

    await user.unhover(screen.getByTestId("info-tooltip-trigger"));
    await waitFor(() => {
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });
  });

  it("reveals the same help on keyboard focus alone (hover is not required)", async () => {
    const user = userEvent.setup();
    setViewportWidth(1280);
    renderTooltip();

    await user.tab();
    expect(screen.getByTestId("info-tooltip-trigger")).toHaveFocus();
    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toHaveTextContent(HELP_TEXT());
    });
  });

  it("links the help to its trigger with aria-describedby while open", async () => {
    const user = userEvent.setup();
    setViewportWidth(1280);
    renderTooltip();
    const trigger = screen.getByTestId("info-tooltip-trigger");
    expect(trigger).not.toHaveAttribute("aria-describedby");

    await user.hover(trigger);
    await waitFor(() => {
      const describedBy = trigger.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      expect(screen.getByRole("tooltip").id).toBe(describedBy);
    });
  });
});

describe("InfoTooltip — mobile (< 960px)", () => {
  it("reveals help on tap, with no hover involved", async () => {
    const user = userEvent.setup();
    setViewportWidth(390);
    renderTooltip();

    // A pointer hover must NOT be what reveals it on a touch layout...
    await user.hover(screen.getByTestId("info-tooltip-trigger"));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    // ...a tap must.
    await user.click(screen.getByTestId("info-tooltip-trigger"));
    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toHaveTextContent(HELP_TEXT());
    });
  });

  it("is operable by keyboard on the mobile layout too", async () => {
    const user = userEvent.setup();
    setViewportWidth(390);
    renderTooltip();

    await user.tab();
    expect(screen.getByTestId("info-tooltip-trigger")).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toHaveTextContent(HELP_TEXT());
    });
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    setViewportWidth(390);
    renderTooltip();
    const trigger = screen.getByTestId("info-tooltip-trigger");

    await user.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toBeInTheDocument();
    });

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();
  });
});

describe("InfoTooltip — accessible naming and state", () => {
  it("names the trigger from the a11y namespace and reports its expanded state", async () => {
    const user = userEvent.setup();
    setViewportWidth(390);
    renderTooltip();
    const trigger = screen.getByRole("button", { name: i18next.t("a11y.moreInformation") });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    await waitFor(() => {
      expect(trigger).toHaveAttribute("aria-expanded", "true");
    });
  });

  it("is a real button, so every input method the platform offers reaches it", () => {
    setViewportWidth(390);
    renderTooltip();
    expect(screen.getByTestId("info-tooltip-trigger").tagName).toBe("BUTTON");
  });
});
