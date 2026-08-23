// External-review item 1: mobile "More" sheet's notifications row now
// carries the real unread badge (previously a documented gap — see this
// step's original HANDOVER — "the mobile 'More' sheet's notifications row
// does not yet carry its own badge"). Mirrors SidebarNav.test.tsx's own
// badge coverage for the desktop equivalent.
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { BccI18nProvider } from "../../i18n/BccI18nProvider.js";
import { BccThemeProvider } from "../../theme/BccThemeProvider.js";
import { setFetchHandler, mockAuthenticatedSession } from "../../test/fetchMock.js";
import { AuthProvider } from "../../features/auth/index.js";
import { BottomNav } from "../BottomNav.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function renderBottomNavAndOpenMore(unreadCount: number): Promise<void> {
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
        data: { guilds: [], inviteEligibleGuilds: [], canInviteBunnyAnywhere: false, inviteUrl: "x" },
      });
    }
    if (url.includes("/api/notifications")) {
      return jsonResponse(200, { data: { items: [], nextCursor: null, unreadCount } });
    }
    return jsonResponse(404, {});
  });
  render(
    <BccThemeProvider initialThemeName="fusion" initialModePreference="light">
      <BccI18nProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/"]}>
            <AuthProvider>
              <BottomNav />
            </AuthProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </BccI18nProvider>
    </BccThemeProvider>,
  );
  const user = userEvent.setup();
  await waitFor(() => expect(screen.getByTestId("bottom-nav-more")).toBeInTheDocument());
  await user.click(screen.getByTestId("bottom-nav-more"));
  await waitFor(() => expect(screen.getByTestId("more-sheet")).toBeInTheDocument());
}

describe("MoreSheet — mobile notifications row unread badge (external-review item 1)", () => {
  it("shows the real unread count from GET /api/notifications on the notifications row", async () => {
    await renderBottomNavAndOpenMore(3);
    await waitFor(() => expect(screen.getByLabelText(/3 unread notifications/)).toBeInTheDocument());
  });

  it("renders no VISIBLE badge dot when unread count is genuinely zero (MUI's own badgeContent={0} behavior — the accessible label itself still correctly reports zero)", async () => {
    await renderBottomNavAndOpenMore(0);
    const badgeRoot = await screen.findByLabelText(/0 unread notifications/);
    const badgeDot = badgeRoot.querySelector(".MuiBadge-badge");
    expect(badgeDot).not.toBeNull();
    expect(badgeDot).toHaveClass("MuiBadge-invisible");
  });
});
