import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Button from "@mui/material/Button";
import i18next from "../../i18n/index.js";
import { BccI18nProvider } from "../../i18n/BccI18nProvider.js";
import { BccThemeProvider } from "../../theme/BccThemeProvider.js";
import { setViewportWidth } from "../../test/matchMedia.js";
import { MAX_VISIBLE_TOASTS, TOAST_AUTO_DISMISS_MS, ToastProvider, useToast } from "../ToastProvider.js";

/** A real trigger, so the toast is raised the way a screen raises it. */
function Trigger(): React.JSX.Element {
  const { showToast, visibleCount, queuedCount } = useToast();
  return (
    <div>
      <Button
        data-testid="raise-info"
        onClick={() => showToast({ tone: "info", messageKey: "showcase.toasts.sampleInfo" })}
      >
        info
      </Button>
      <Button
        data-testid="raise-error"
        onClick={() => showToast({ tone: "error", messageKey: "showcase.toasts.sampleError" })}
      >
        error
      </Button>
      <Button
        data-testid="raise-success"
        onClick={() => showToast({ tone: "success", messageKey: "showcase.toasts.sampleSuccess" })}
      >
        success
      </Button>
      <span data-testid="counts" data-visible={String(visibleCount)} data-queued={String(queuedCount)} />
    </div>
  );
}

function renderToasts(): void {
  render(
    <BccThemeProvider initialThemeName="fusion" initialModePreference="light">
      <BccI18nProvider>
        <ToastProvider>
          <Trigger />
        </ToastProvider>
      </BccI18nProvider>
    </BccThemeProvider>,
  );
}

function counts(): { visible: number; queued: number } {
  const element = screen.getByTestId("counts");
  return {
    visible: Number(element.dataset["visible"]),
    queued: Number(element.dataset["queued"]),
  };
}

describe("Toast", () => {
  it("renders the translated message, not a key", async () => {
    const user = userEvent.setup();
    renderToasts();
    await user.click(screen.getByTestId("raise-info"));
    expect(screen.getByRole("status")).toHaveTextContent(i18next.t("showcase.toasts.sampleInfo"));
    expect(screen.getByRole("status").textContent).not.toContain("showcase.");
  });

  it("queues beyond three visible instead of stacking infinitely", async () => {
    const user = userEvent.setup();
    renderToasts();
    // Errors are persistent, so nothing self-dismisses mid-assertion.
    for (let index = 0; index < 5; index += 1) {
      await user.click(screen.getByTestId("raise-error"));
    }
    expect(counts()).toEqual({ visible: MAX_VISIBLE_TOASTS, queued: 2 });
    expect(screen.getAllByTestId("toast")).toHaveLength(MAX_VISIBLE_TOASTS);
  });

  it("promotes a queued toast when a visible one is dismissed", async () => {
    const user = userEvent.setup();
    renderToasts();
    for (let index = 0; index < 4; index += 1) {
      await user.click(screen.getByTestId("raise-error"));
    }
    expect(counts()).toEqual({ visible: 3, queued: 1 });

    await user.click(screen.getAllByRole("button", { name: i18next.t("a11y.closeNotification") })[0]!);

    await waitFor(() => {
      expect(counts()).toEqual({ visible: 3, queued: 0 });
    });
  });

  it("announces informational toasts politely and errors assertively", async () => {
    const user = userEvent.setup();
    renderToasts();
    await user.click(screen.getByTestId("raise-info"));
    await user.click(screen.getByTestId("raise-error"));

    const polite = screen.getByRole("status");
    expect(polite).toHaveAttribute("aria-live", "polite");
    const assertive = screen.getByRole("alert");
    expect(assertive).toHaveAttribute("aria-live", "assertive");
  });

  it("labels the toast container as a landmark region", async () => {
    const user = userEvent.setup();
    renderToasts();
    await user.click(screen.getByTestId("raise-info"));
    expect(screen.getByRole("region", { name: i18next.t("a11y.notificationRegion") })).toBeInTheDocument();
  });

  it("gives every toast a keyboard-reachable dismiss button with an accessible name", async () => {
    const user = userEvent.setup();
    renderToasts();
    await user.click(screen.getByTestId("raise-info"));
    const close = screen.getByRole("button", { name: i18next.t("a11y.closeNotification") });
    close.focus();
    expect(close).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(screen.queryByTestId("toast")).not.toBeInTheDocument();
    });
  });

  it("places itself bottom-centre on mobile and top-right on desktop", async () => {
    const user = userEvent.setup();
    setViewportWidth(390); // iPhone-class width
    renderToasts();
    await user.click(screen.getByTestId("raise-info"));
    expect(screen.getByTestId("toast-region")).toHaveAttribute("data-placement", "mobile-bottom-center");

    // Same component tree, wider viewport - the placement must follow the breakpoint.
    act(() => {
      setViewportWidth(1280);
    });
    await waitFor(() => {
      expect(screen.getByTestId("toast-region")).toHaveAttribute("data-placement", "desktop-top-right");
    });
  });

  describe("dismissal timing", () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("auto-dismisses an informational toast after 5s", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderToasts();
      await user.click(screen.getByTestId("raise-info"));
      expect(screen.getByTestId("toast")).toHaveAttribute("data-persistent", "false");

      act(() => {
        vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS - 100);
      });
      expect(screen.queryByTestId("toast")).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(200);
      });
      await waitFor(() => {
        expect(screen.queryByTestId("toast")).not.toBeInTheDocument();
      });
    });

    it("keeps an error toast until the user dismisses it", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderToasts();
      await user.click(screen.getByTestId("raise-error"));
      expect(screen.getByTestId("toast")).toHaveAttribute("data-persistent", "true");

      act(() => {
        vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS * 4);
      });
      expect(screen.getByTestId("toast")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: i18next.t("a11y.closeNotification") }));
      await waitFor(() => {
        expect(screen.queryByTestId("toast")).not.toBeInTheDocument();
      });
    });

    it("lets a caller override the tone's default persistence in either direction", async () => {
      function CustomTrigger(): React.JSX.Element {
        const { showToast } = useToast();
        return (
          <Button
            data-testid="raise-sticky-info"
            onClick={() =>
              showToast({ tone: "info", messageKey: "showcase.toasts.sampleInfo", persistent: true })
            }
          >
            sticky
          </Button>
        );
      }
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(
        <BccThemeProvider initialThemeName="fusion" initialModePreference="light">
          <BccI18nProvider>
            <ToastProvider>
              <CustomTrigger />
            </ToastProvider>
          </BccI18nProvider>
        </BccThemeProvider>,
      );
      await user.click(screen.getByTestId("raise-sticky-info"));
      act(() => {
        vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS * 2);
      });
      expect(screen.getByTestId("toast")).toBeInTheDocument();
    });
  });
});
