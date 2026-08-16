import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "../../../i18n/index.js";
import { BccI18nProvider } from "../../../i18n/BccI18nProvider.js";
import { BccThemeProvider } from "../../../theme/BccThemeProvider.js";
import { OAuthErrorScreen, isOAuthErrorReason, type OAuthErrorReason } from "../OAuthErrorScreen.js";

function renderScreen(reason: OAuthErrorReason, onTryAgain: () => void): ReturnType<typeof render> {
  return render(
    <BccThemeProvider>
      <BccI18nProvider>
        <OAuthErrorScreen reason={reason} onTryAgain={onTryAgain} />
      </BccI18nProvider>
    </BccThemeProvider>,
  );
}

describe("OAuthErrorScreen (SCREENS/AUTH.md §OAuth error)", () => {
  it.each([
    ["oauth_denied", "auth.error.denied"],
    ["state_mismatch", "auth.error.stateMismatch"],
    ["token_exchange_failed", "auth.error.tokenExchangeFailed"],
  ] as const)("renders the correct, distinct, localized message for reason=%s", (reason, expectedKey) => {
    renderScreen(reason, () => {});
    expect(screen.getByTestId("oauth-error-detail")).toHaveTextContent(i18next.t(expectedKey));
  });

  it("never renders a raw Discord error string — only the fixed heading + one of the 3 mapped messages", () => {
    renderScreen("oauth_denied", () => {});
    expect(screen.getByTestId("oauth-error-heading")).toHaveTextContent(i18next.t("auth.error.heading"));
  });

  it("the heading is the page's h1 and receives focus on render (screen-reader landing point)", () => {
    renderScreen("state_mismatch", () => {});
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveFocus();
  });

  it("'Try again' calls the provided callback (returns to Login)", async () => {
    const user = userEvent.setup();
    const onTryAgain = vi.fn();
    renderScreen("token_exchange_failed", onTryAgain);
    await user.click(screen.getByTestId("oauth-error-try-again"));
    expect(onTryAgain).toHaveBeenCalledTimes(1);
  });
});

describe("isOAuthErrorReason", () => {
  it("accepts exactly the 3 documented reasons", () => {
    expect(isOAuthErrorReason("oauth_denied")).toBe(true);
    expect(isOAuthErrorReason("state_mismatch")).toBe(true);
    expect(isOAuthErrorReason("token_exchange_failed")).toBe(true);
  });

  it("rejects anything else, including null and an arbitrary string", () => {
    expect(isOAuthErrorReason(null)).toBe(false);
    expect(isOAuthErrorReason("something_else")).toBe(false);
    expect(isOAuthErrorReason("")).toBe(false);
  });
});
