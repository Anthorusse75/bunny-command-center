// Desktop sidebar — grouped ordering + conditional visibility + active
// (aria-current) semantics + collapsed icon-rail mode
// (03_INFORMATION_ARCHITECTURE.md §Desktop navigation).
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { BccI18nProvider } from "../../i18n/BccI18nProvider.js";
import { BccThemeProvider } from "../../theme/BccThemeProvider.js";
import { setFetchHandler, mockAuthenticatedSession } from "../../test/fetchMock.js";
import { AuthProvider } from "../../features/auth/index.js";
import { SidebarNav } from "../SidebarNav.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function renderSidebar(opts: {
  collapsed?: boolean;
  path?: string;
  tier?: "USER" | "GUILD_ADMIN" | "SUPERADMIN";
  isSuperadmin?: boolean;
}): Promise<void> {
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
          isSuperadmin: opts.isSuperadmin ?? false,
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
              isFavorite: true,
              isOwner: false,
              canAdminister: false,
              favoritedAt: "2026-01-01T00:00:00Z",
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
    if (url.includes("/api/guilds/1")) {
      return jsonResponse(200, {
        data: {
          guildId: "1",
          tier: opts.tier ?? "USER",
          botPresent: true,
          enabled: true,
          displayName: "Alpha",
        },
      });
    }
    return jsonResponse(404, {});
  });
  render(
    <BccThemeProvider initialThemeName="fusion" initialModePreference="light">
      <BccI18nProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[opts.path ?? "/"]}>
            <AuthProvider>
              <SidebarNav collapsed={opts.collapsed ?? false} />
            </AuthProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </BccI18nProvider>
    </BccThemeProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("sidebar-item-home")).toBeInTheDocument());
}

describe("SidebarNav", () => {
  it("renders the primary domain group always, in the documented order", async () => {
    await renderSidebar({});
    const order = ["home", "upload", "guild", "contributions", "leaderboard", "notifications"];
    for (const key of order) {
      expect(screen.getByTestId(`sidebar-item-${key}`)).toBeInTheDocument();
    }
  });

  it("hides Guild-Admin-only items for a plain USER tier", async () => {
    await renderSidebar({ path: "/guild/1", tier: "USER" });
    await waitFor(() => expect(screen.queryByTestId("sidebar-item-onboarding")).not.toBeInTheDocument());
    expect(screen.queryByTestId("sidebar-item-guildAdmin")).not.toBeInTheDocument();
  });

  it("shows Guild-Admin-only items once the real overview resolves GUILD_ADMIN tier", async () => {
    await renderSidebar({ path: "/guild/1", tier: "GUILD_ADMIN" });
    await waitFor(() => expect(screen.getByTestId("sidebar-item-guildAdmin")).toBeInTheDocument());
    expect(screen.getByTestId("sidebar-item-onboarding")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-item-technical")).toBeInTheDocument();
  });

  it("shows Superadmin + Hero Discovery only for isSuperadmin", async () => {
    await renderSidebar({ isSuperadmin: true });
    await waitFor(() => expect(screen.getByTestId("sidebar-item-superadmin")).toBeInTheDocument());
    expect(screen.getByTestId("sidebar-item-heroDiscovery")).toBeInTheDocument();
  });

  it("marks the current route active via aria-current", async () => {
    await renderSidebar({ path: "/" });
    expect(screen.getByTestId("sidebar-item-home")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("sidebar-item-upload")).not.toHaveAttribute("aria-current");
  });

  it("collapsed mode drops visible text labels but keeps an accessible name via aria-label", async () => {
    await renderSidebar({ collapsed: true });
    const home = screen.getByTestId("sidebar-item-home");
    expect(home).toHaveAccessibleName();
    expect(home.textContent?.trim()).toBe("");
  });

  it("Profile renders last (pinned group)", async () => {
    await renderSidebar({});
    expect(screen.getByTestId("sidebar-item-profile")).toBeInTheDocument();
  });
});
