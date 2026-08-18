// SCREENS/HOME.md §"No guild at all": "Test cases explicitly required: both
// the 'can invite' and 'cannot invite' sub-cases render correctly." Plus the
// has-a-usable-guild placeholder path (Home's ONE piece of real content
// this step ships — everything else stays the deliberate near-empty
// placeholder, see this step's own scope note).
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import i18next from "../../i18n/index.js";
import { BccI18nProvider } from "../../i18n/BccI18nProvider.js";
import { BccThemeProvider } from "../../theme/BccThemeProvider.js";
import { setFetchHandler } from "../../test/fetchMock.js";
import { HomeScreen } from "../HomeScreen.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderHome(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <BccThemeProvider initialThemeName="fusion" initialModePreference="light">
      <BccI18nProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/"]}>
            <HomeScreen />
          </MemoryRouter>
        </QueryClientProvider>
      </BccI18nProvider>
    </BccThemeProvider>,
  );
}

describe("HomeScreen — zero-guild marketing state (SCREENS/HOME.md)", () => {
  it("'can invite' sub-case: shows the real invite CTA linking to the Discord bot-invite URL", async () => {
    setFetchHandler((url) =>
      url.includes("/api/users/me/guilds")
        ? jsonResponse(200, {
            data: {
              guilds: [],
              inviteEligibleGuilds: [{ guildId: "1", name: "Some Guild" }],
              canInviteBunnyAnywhere: true,
              inviteUrl: "https://discord.com/oauth2/authorize?client_id=x&scope=bot",
            },
          })
        : jsonResponse(404, {}),
    );
    renderHome();
    await waitFor(() => expect(screen.getByTestId("zero-guild-state")).toBeInTheDocument());
    expect(screen.getByRole("heading", { level: 1, name: i18next.t("home.zeroGuild.title") })).toBeVisible();
    const cta = screen.getByTestId("invite-bunny-cta");
    expect(cta).toHaveAttribute("href", "https://discord.com/oauth2/authorize?client_id=x&scope=bot");
    expect(screen.queryByTestId("cannot-invite-message")).not.toBeInTheDocument();
  });

  it("'cannot invite' sub-case: shows the 'ask your admin' message, never a fake invite button", async () => {
    setFetchHandler((url) =>
      url.includes("/api/users/me/guilds")
        ? jsonResponse(200, {
            data: {
              guilds: [],
              inviteEligibleGuilds: [],
              canInviteBunnyAnywhere: false,
              inviteUrl: "https://discord.com/oauth2/authorize?scope=bot",
            },
          })
        : jsonResponse(404, {}),
    );
    renderHome();
    await waitFor(() => expect(screen.getByTestId("zero-guild-state")).toBeInTheDocument());
    expect(screen.getByTestId("cannot-invite-message")).toHaveTextContent(
      i18next.t("home.zeroGuild.cannotInvite"),
    );
    expect(screen.queryByTestId("invite-bunny-cta")).not.toBeInTheDocument();
  });

  it("never looks like an error page: renders the full marketing feature list, not a bare message", async () => {
    setFetchHandler((url) =>
      url.includes("/api/users/me/guilds")
        ? jsonResponse(200, {
            data: { guilds: [], inviteEligibleGuilds: [], canInviteBunnyAnywhere: false, inviteUrl: "x" },
          })
        : jsonResponse(404, {}),
    );
    renderHome();
    await waitFor(() => expect(screen.getByTestId("zero-guild-state")).toBeInTheDocument());
    expect(screen.getByText(i18next.t("home.zeroGuild.features.upload"))).toBeVisible();
    expect(screen.getByText(i18next.t("home.zeroGuild.features.ocr"))).toBeVisible();
    expect(screen.getByText(i18next.t("home.zeroGuild.features.premiumplus"))).toBeVisible();
    expect(screen.getByText(i18next.t("home.zeroGuild.features.leaderboards"))).toBeVisible();
  });

  it("with at least one usable guild, renders the near-empty placeholder, NOT the zero-guild marketing state", async () => {
    setFetchHandler((url) =>
      url.includes("/api/users/me/guilds")
        ? jsonResponse(200, {
            data: {
              guilds: [{ guildId: "1", name: "My Guild", botPresent: true, isFavorite: true }],
              inviteEligibleGuilds: [],
              canInviteBunnyAnywhere: false,
              inviteUrl: "x",
            },
          })
        : jsonResponse(404, {}),
    );
    renderHome();
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: i18next.t("home.placeholder.title") }),
      ).toBeVisible(),
    );
    expect(screen.queryByTestId("zero-guild-state")).not.toBeInTheDocument();
  });
});

describe("HomeScreen — Copilot review Finding 5: a failed guild-list request must never render as the zero-guild success state", () => {
  it("a 500 from GET /api/users/me/guilds renders the load-error state, never the zero-guild marketing CTA", async () => {
    setFetchHandler((url) =>
      url.includes("/api/users/me/guilds")
        ? jsonResponse(500, { error_code: "SERVER_ERROR", message_key: "errors.server", parameters: {} })
        : jsonResponse(404, {}),
    );
    renderHome();
    await waitFor(() => expect(screen.getByTestId("home-load-error")).toBeInTheDocument());
    expect(screen.getByRole("heading", { level: 1, name: i18next.t("home.loadError.title") })).toBeVisible();
    // Must NOT show the success-shaped zero-guild state — a real failure is
    // not "you have zero guilds, here's how to get Bunny".
    expect(screen.queryByTestId("zero-guild-state")).not.toBeInTheDocument();
    expect(screen.queryByTestId("invite-bunny-cta")).not.toBeInTheDocument();
    expect(screen.queryByTestId("cannot-invite-message")).not.toBeInTheDocument();
  });

  it("a genuinely successful empty list still renders the real zero-guild state (not misdiagnosed as an error)", async () => {
    setFetchHandler((url) =>
      url.includes("/api/users/me/guilds")
        ? jsonResponse(200, {
            data: { guilds: [], inviteEligibleGuilds: [], canInviteBunnyAnywhere: false, inviteUrl: "x" },
          })
        : jsonResponse(404, {}),
    );
    renderHome();
    await waitFor(() => expect(screen.getByTestId("zero-guild-state")).toBeInTheDocument());
    expect(screen.queryByTestId("home-load-error")).not.toBeInTheDocument();
  });

  it("the retry button re-issues the request, and a subsequent success renders the real content", async () => {
    let callCount = 0;
    setFetchHandler((url) => {
      if (!url.includes("/api/users/me/guilds")) return jsonResponse(404, {});
      callCount += 1;
      if (callCount === 1) {
        return jsonResponse(500, {
          error_code: "SERVER_ERROR",
          message_key: "errors.server",
          parameters: {},
        });
      }
      return jsonResponse(200, {
        data: { guilds: [], inviteEligibleGuilds: [], canInviteBunnyAnywhere: false, inviteUrl: "x" },
      });
    });
    renderHome();
    await waitFor(() => expect(screen.getByTestId("home-load-error")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByTestId("home-load-error-retry"));

    await waitFor(() => expect(screen.getByTestId("zero-guild-state")).toBeInTheDocument());
    expect(callCount).toBe(2);
  });
});
