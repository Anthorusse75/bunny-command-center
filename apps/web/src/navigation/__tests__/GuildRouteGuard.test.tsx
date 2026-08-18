// The real production authorization gate for every `/guild/:guildId/*`
// route (this step's "F. REAL ROUTING / DEEP LINKS" mandate: "direct/deep
// navigation to a guild route must run normal server-side authorization").
// Every branch here corresponds directly to `GET /api/guilds/:guildId`'s
// real, `requireTier`-guarded response shapes (apps/api/src/guilds/routes.ts).
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import i18next from "../../i18n/index.js";
import { BccI18nProvider } from "../../i18n/BccI18nProvider.js";
import { BccThemeProvider } from "../../theme/BccThemeProvider.js";
import { setFetchHandler } from "../../test/fetchMock.js";
import { GuildRouteGuard, useGuildOverviewContext } from "../GuildRouteGuard.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function ProtectedContent(): React.JSX.Element {
  const overview = useGuildOverviewContext();
  return <div data-testid="protected-content">{overview.tier}</div>;
}

function renderGuarded(path: string): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <BccThemeProvider initialThemeName="fusion" initialModePreference="light">
      <BccI18nProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route
                path="/guild/:guildId"
                element={
                  <GuildRouteGuard>
                    <ProtectedContent />
                  </GuildRouteGuard>
                }
              />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </BccI18nProvider>
    </BccThemeProvider>,
  );
}

describe("GuildRouteGuard", () => {
  it("shows a loading state before the real authorization call resolves", () => {
    setFetchHandler(() => new Promise(() => {})); // never resolves
    renderGuarded("/guild/111");
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByTestId("protected-content")).not.toBeInTheDocument();
  });

  it("on 200 (real membership + tier confirmed), renders the guarded children with the server-resolved tier", async () => {
    setFetchHandler((url) =>
      url.includes("/api/guilds/111")
        ? jsonResponse(200, {
            data: { guildId: "111", tier: "GUILD_ADMIN", botPresent: true, enabled: true, displayName: "G" },
          })
        : jsonResponse(404, {}),
    );
    renderGuarded("/guild/111");
    await waitFor(() => expect(screen.getByTestId("protected-content")).toHaveTextContent("GUILD_ADMIN"));
  });

  it("on 404 (not a member — assertGuildMembership's real convention), renders the 'no longer accessible' state, never the guarded content", async () => {
    setFetchHandler((url) =>
      url.includes("/api/guilds/111")
        ? jsonResponse(404, {
            error_code: "GUILD_NOT_FOUND",
            message_key: "errors.guilds.notFound",
            parameters: {},
          })
        : jsonResponse(404, {}),
    );
    renderGuarded("/guild/111");
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: i18next.t("errors.guildNotAccessible.title") }),
      ).toBeVisible(),
    );
    expect(screen.queryByTestId("protected-content")).not.toBeInTheDocument();
    // Never a raw/generic 404 or 403 wording (03_INFORMATION_ARCHITECTURE.md:
    // "redirects to a 'no longer accessible' state, never a raw 403").
    expect(screen.queryByText(i18next.t("errors.notFoundPage.title"))).not.toBeInTheDocument();
    expect(screen.queryByText(i18next.t("errors.forbiddenGuild.title"))).not.toBeInTheDocument();
  });

  it("on 403 (membership confirmed, tier denied), renders the distinct Forbidden state", async () => {
    setFetchHandler((url) =>
      url.includes("/api/guilds/111")
        ? jsonResponse(403, {
            error_code: "FORBIDDEN",
            message_key: "errors.auth.insufficientPermissions",
            parameters: {},
          })
        : jsonResponse(404, {}),
    );
    renderGuarded("/guild/111");
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: i18next.t("errors.forbiddenGuild.title") }),
      ).toBeVisible(),
    );
    expect(screen.queryByTestId("protected-content")).not.toBeInTheDocument();
  });

  it("re-authorizes independently for a DIFFERENT guildId — never trusts a previously-authorized guild's decision (cross-guild IDOR at the UI layer)", async () => {
    setFetchHandler((url) => {
      if (url.includes("/api/guilds/111")) {
        return jsonResponse(200, {
          data: { guildId: "111", tier: "USER", botPresent: true, enabled: true, displayName: "A" },
        });
      }
      if (url.includes("/api/guilds/222")) {
        return jsonResponse(404, {
          error_code: "GUILD_NOT_FOUND",
          message_key: "errors.guilds.notFound",
          parameters: {},
        });
      }
      return jsonResponse(404, {});
    });
    renderGuarded("/guild/222");
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: i18next.t("errors.guildNotAccessible.title") }),
      ).toBeVisible(),
    );
  });
});
