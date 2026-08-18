// EXTERNAL REVIEW FINDING 1 (BLOCKING) — `<RequireGuildAdmin>` is the guard
// that closes the gap where an ordinary USER-tier member could reach the
// Guild-Admin-only placeholder routes (onboarding/admin/technical) by
// direct URL. Every branch here corresponds to `GuildRouteGuard.test.tsx`'s
// same real, `requireTier`-guarded `GET /api/guilds/:guildId` response
// shapes — this file only adds the ADMIN-vs-USER distinction on top.
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import i18next from "../../i18n/index.js";
import { BccI18nProvider } from "../../i18n/BccI18nProvider.js";
import { BccThemeProvider } from "../../theme/BccThemeProvider.js";
import { setFetchHandler } from "../../test/fetchMock.js";
import { GuildRouteGuard } from "../GuildRouteGuard.js";
import { RequireGuildAdmin } from "../RequireGuildAdmin.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function overviewResponse(guildId: string, tier: string): Response {
  return jsonResponse(200, { data: { guildId, tier, botPresent: true, enabled: true, displayName: "G" } });
}

function AdminOnlyContent(): React.JSX.Element {
  return <div data-testid="admin-only-content">admin content</div>;
}

function renderAdminRoute(path: string): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <BccThemeProvider initialThemeName="fusion" initialModePreference="light">
      <BccI18nProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route
                path="/guild/:guildId/admin"
                element={
                  <GuildRouteGuard>
                    <RequireGuildAdmin>
                      <AdminOnlyContent />
                    </RequireGuildAdmin>
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

describe("RequireGuildAdmin", () => {
  it("USER tier -> Forbidden screen, never the guarded admin content", async () => {
    setFetchHandler((url) =>
      url.includes("/api/guilds/111") ? overviewResponse("111", "USER") : jsonResponse(404, {}),
    );
    renderAdminRoute("/guild/111/admin");
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: i18next.t("errors.forbiddenGuild.title") }),
      ).toBeVisible(),
    );
    expect(screen.queryByTestId("admin-only-content")).not.toBeInTheDocument();
  });

  it("GUILD_ADMIN tier -> renders the guarded admin content", async () => {
    setFetchHandler((url) =>
      url.includes("/api/guilds/111") ? overviewResponse("111", "GUILD_ADMIN") : jsonResponse(404, {}),
    );
    renderAdminRoute("/guild/111/admin");
    await waitFor(() => expect(screen.getByTestId("admin-only-content")).toBeInTheDocument());
  });

  it("SUPERADMIN tier -> renders the guarded admin content (same check, no separate Superadmin carve-out needed)", async () => {
    setFetchHandler((url) =>
      url.includes("/api/guilds/111") ? overviewResponse("111", "SUPERADMIN") : jsonResponse(404, {}),
    );
    renderAdminRoute("/guild/111/admin");
    await waitFor(() => expect(screen.getByTestId("admin-only-content")).toBeInTheDocument());
  });

  it("an admin of guild A does not carry that admin access into guild B — switching guildId re-resolves a fresh, independent tier", async () => {
    setFetchHandler((url) => {
      if (url.includes("/api/guilds/111")) return overviewResponse("111", "GUILD_ADMIN");
      if (url.includes("/api/guilds/222")) return overviewResponse("222", "USER");
      return jsonResponse(404, {});
    });
    // Direct navigation to B's admin route — never trusts a prior guild's
    // authorization result (this is the deep-link case; the live
    // guild-switch case is covered by e2e/multi-guild.spec.ts's real
    // browser regression test).
    renderAdminRoute("/guild/222/admin");
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: i18next.t("errors.forbiddenGuild.title") }),
      ).toBeVisible(),
    );
    expect(screen.queryByTestId("admin-only-content")).not.toBeInTheDocument();
  });
});
