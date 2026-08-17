// Mobile bottom nav — D-018's fixed ≤5-destination cap
// (03_INFORMATION_ARCHITECTURE.md), rendered for real (not just the
// navConfig-level count already covered in navConfig.test.ts).
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import i18next from "../../i18n/index.js";
import { BccI18nProvider } from "../../i18n/BccI18nProvider.js";
import { BccThemeProvider } from "../../theme/BccThemeProvider.js";
import { setFetchHandler, mockAuthenticatedSession } from "../../test/fetchMock.js";
import { AuthProvider } from "../../features/auth/index.js";
import { BottomNav } from "../BottomNav.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function renderBottomNav(initialPath = "/"): Promise<void> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockAuthenticatedSession();
  setFetchHandler((url) => {
    if (url.includes("/api/auth/session")) {
      return jsonResponse(200, {
        data: {
          user: {
            id: 1,
            discordUserId: "1",
            username: "U",
            avatarHash: null,
            locale: "en",
            themeName: "fusion",
            themeMode: "system",
          },
          sessionId: "s",
          isSuperadmin: false,
        },
      });
    }
    if (url.includes("/api/users/me/guilds")) {
      return jsonResponse(200, {
        data: {
          guilds: [
            {
              guildId: "1",
              name: "Alpha",
              botPresent: true,
              isFavorite: false,
              isOwner: false,
              canAdminister: false,
              favoritedAt: null,
              homeVisible: true,
              lastUsedAt: null,
              icon: null,
              enabled: true,
            },
          ],
          inviteEligibleGuilds: [],
          canInviteBunnyAnywhere: false,
          inviteUrl: "x",
        },
      });
    }
    return jsonResponse(404, {});
  });
  render(
    <BccThemeProvider initialThemeName="fusion" initialModePreference="light">
      <BccI18nProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[initialPath]}>
            <AuthProvider>
              <BottomNav />
            </AuthProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </BccI18nProvider>
    </BccThemeProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("bottom-nav-home")).toBeInTheDocument());
}

describe("BottomNav — the fixed 5-destination mobile nav", () => {
  it("renders exactly 5 destinations: Home, Upload, Guild, Leaderboard, More", async () => {
    await renderBottomNav();
    expect(screen.getByTestId("bottom-nav-home")).toBeInTheDocument();
    expect(screen.getByTestId("bottom-nav-upload")).toBeInTheDocument();
    expect(screen.getByTestId("bottom-nav-guild")).toBeInTheDocument();
    expect(screen.getByTestId("bottom-nav-leaderboard")).toBeInTheDocument();
    expect(screen.getByTestId("bottom-nav-more")).toBeInTheDocument();
    // Nothing else — a literal count proves "more" never grows past 5 total.
    const nav = screen.getByTestId("bottom-nav-home").parentElement!;
    expect(nav.querySelectorAll("[data-testid^='bottom-nav-']")).toHaveLength(5);
  });

  it("Home is marked active (aria-current) when on '/'", async () => {
    await renderBottomNav("/");
    expect(screen.getByTestId("bottom-nav-home")).toHaveAttribute("aria-current", "page");
  });

  it("tapping 'More' opens the More sheet with the remaining destinations", async () => {
    const user = userEvent.setup();
    await renderBottomNav();
    await user.click(screen.getByTestId("bottom-nav-more"));
    await waitFor(() => expect(screen.getByTestId("more-sheet")).toBeInTheDocument());
    expect(screen.getByTestId("more-item-contributions")).toBeInTheDocument();
    expect(screen.getByTestId("more-item-notifications")).toBeInTheDocument();
    expect(screen.getByTestId("more-item-profile")).toBeInTheDocument();
    // "More" never surfaces destinations not visible for this context
    // (this step's explicit rule: "not become an excuse to dump
    // inaccessible desktop-only actions") — no admin-only items without a
    // resolved GUILD_ADMIN/Superadmin context.
    expect(screen.queryByTestId("more-item-superadmin")).not.toBeInTheDocument();
  });

  it("tapping 'Guild' while NOT on a guild-scoped screen navigates directly to the resolved guild", async () => {
    const user = userEvent.setup();
    await renderBottomNav("/");
    await user.click(screen.getByTestId("bottom-nav-guild"));
    // Navigating away unmounts BottomNav's own tree in a real router, but
    // here BottomNav is rendered standalone — the picker sheet must NOT
    // have opened for this case (opening only when already on a guild
    // route), proven by its absence.
    expect(screen.queryByTestId("guild-picker-sheet")).not.toBeInTheDocument();
  });

  it("tapping 'Guild' while ALREADY on a guild-scoped screen opens the picker sheet instead of re-navigating", async () => {
    const user = userEvent.setup();
    await renderBottomNav("/guild/1/leaderboard");
    await user.click(screen.getByTestId("bottom-nav-guild"));
    await waitFor(() => expect(screen.getByTestId("guild-picker-sheet")).toBeVisible());
    expect(screen.getByRole("dialog", { name: i18next.t("guild.switcher.title") })).toBeInTheDocument();
  });
});
