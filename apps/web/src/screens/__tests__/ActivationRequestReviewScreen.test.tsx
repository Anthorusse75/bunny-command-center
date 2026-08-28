// Step 10 external-review Phase 2, Section 3 —
// `/admin/platform/guilds/:guildId/review/:requestId`. Real route tree
// (`SuperadminRouteGuard` + the screen), real `fetch` mock (this repo's
// `fetchMock.js` convention), no react-query/network mocking library —
// matches `RequireGuildAdmin.test.tsx`'s established approach for a
// guarded, data-fetching route.
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import i18next from "../../i18n/index.js";
import { BccI18nProvider } from "../../i18n/BccI18nProvider.js";
import { BccThemeProvider } from "../../theme/BccThemeProvider.js";
import { ToastProvider } from "../../design-system/index.js";
import { AuthProvider } from "../../features/auth/index.js";
import { setFetchHandler } from "../../test/fetchMock.js";
import { SuperadminRouteGuard } from "../../navigation/SuperadminRouteGuard.js";
import { ActivationRequestReviewScreen } from "../ActivationRequestReviewScreen.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const REQUEST_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const GUILD_ID = "600000000000000001";

function detailBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    data: {
      requestId: REQUEST_ID,
      guildId: GUILD_ID,
      submittedConfigVersionId: 42,
      requestedBy: "700000000000000001",
      requestedAt: "2026-08-01T00:00:00.000Z",
      state: "PENDING",
      reviewedBy: null,
      reviewedAt: null,
      decisionReason: null,
      configSnapshot: {
        incomingChannelId: "500000000000000001",
        heroChannelId: "500000000000000002",
        communityChannelId: null,
        quotas: { gcHero: 912, gcTitan: 380, hol: 600, hero: 1200, titan: 600 },
      },
      ...overrides,
    },
  };
}

function renderScreen(
  handler: (url: string, init: RequestInit | undefined) => Response,
  path = `/admin/platform/guilds/${GUILD_ID}/review/${REQUEST_ID}`,
): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  setFetchHandler((url, init) => {
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
          isSuperadmin: true,
        },
      });
    }
    return handler(url, init);
  });
  render(
    <BccThemeProvider initialThemeName="fusion" initialModePreference="light">
      <BccI18nProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[path]}>
            <AuthProvider>
              <ToastProvider>
                <Routes>
                  <Route
                    path="/admin/platform/guilds/:guildId/review/:requestId"
                    element={
                      <SuperadminRouteGuard>
                        <ActivationRequestReviewScreen />
                      </SuperadminRouteGuard>
                    }
                  />
                </Routes>
              </ToastProvider>
            </AuthProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </BccI18nProvider>
    </BccThemeProvider>,
  );
}

describe("ActivationRequestReviewScreen", () => {
  it("PENDING request: shows the frozen snapshot, live-scope note, and all 3 decision actions", async () => {
    renderScreen((url) =>
      url.includes(`/api/admin/activation-requests/${REQUEST_ID}`)
        ? jsonResponse(200, detailBody())
        : jsonResponse(404, {}),
    );

    await waitFor(() => expect(screen.getByText("500000000000000001")).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: i18next.t("superadmin.review.title") })).toBeInTheDocument();
    expect(screen.getByText("500000000000000002")).toBeInTheDocument();
    expect(screen.getByText(i18next.t("superadmin.review.liveScope.title"))).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: i18next.t("superadmin.review.actions.approve") }),
    ).toBeEnabled();
    expect(screen.getByTestId("reject-reason")).toBeInTheDocument();
    expect(screen.getByTestId("request-changes-reason")).toBeInTheDocument();
  });

  it("guildId route param mismatch against the server response shows an error, never the snapshot", async () => {
    renderScreen((url) =>
      url.includes(`/api/admin/activation-requests/${REQUEST_ID}`)
        ? jsonResponse(200, detailBody({ guildId: "999999999999999999" }))
        : jsonResponse(404, {}),
    );

    await waitFor(() => expect(screen.getByTestId("guild-mismatch-error")).toBeInTheDocument());
    expect(
      screen.queryByRole("button", { name: i18next.t("superadmin.review.actions.approve") }),
    ).not.toBeInTheDocument();
  });

  it("already-decided (APPROVED) request shows the decision, never the action buttons", async () => {
    renderScreen((url) =>
      url.includes(`/api/admin/activation-requests/${REQUEST_ID}`)
        ? jsonResponse(
            200,
            detailBody({
              state: "APPROVED",
              reviewedBy: "700000000000000002",
              reviewedAt: "2026-08-02T00:00:00.000Z",
            }),
          )
        : jsonResponse(404, {}),
    );

    await waitFor(() => expect(screen.getByTestId("already-decided")).toBeInTheDocument());
    expect(
      screen.queryByRole("button", { name: i18next.t("superadmin.review.actions.approve") }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("reject-reason")).not.toBeInTheDocument();
  });

  it("Reject requires a non-empty reason before the button is enabled, then posts it and shows the decided state", async () => {
    let rejectCalled: unknown = null;
    let currentState = "PENDING";
    renderScreen((url, init) => {
      if (url.includes(`/api/admin/activation-requests/${REQUEST_ID}/reject`)) {
        rejectCalled = init?.body ? JSON.parse(init.body as string) : null;
        currentState = "REJECTED";
        return jsonResponse(200, { data: { requestId: REQUEST_ID, lifecycleState: null } });
      }
      if (url.includes(`/api/admin/activation-requests/${REQUEST_ID}`)) {
        return jsonResponse(
          200,
          detailBody({
            state: currentState,
            reviewedBy: currentState === "REJECTED" ? "700000000000000002" : null,
            decisionReason: currentState === "REJECTED" ? "Not enough info" : null,
          }),
        );
      }
      return jsonResponse(404, {});
    });

    await waitFor(() => expect(screen.getByTestId("reject-submit")).toBeInTheDocument());
    const rejectButton = screen.getByTestId("reject-submit");
    expect(rejectButton).toBeDisabled();

    const user = userEvent.setup();
    const reasonField = screen.getByTestId("reject-reason").querySelector("textarea")!;
    await user.type(reasonField, "Not enough info");
    expect(rejectButton).toBeEnabled();

    await user.click(rejectButton);

    await waitFor(() => expect(rejectCalled).toEqual({ reason: "Not enough info" }));
    await waitFor(() => expect(screen.getByTestId("already-decided")).toBeInTheDocument());
  });

  it("Approve posts with no body and moves the screen to the already-decided state", async () => {
    let approveCalled = false;
    let currentState = "PENDING";
    renderScreen((url) => {
      if (url.includes(`/api/admin/activation-requests/${REQUEST_ID}/approve`)) {
        approveCalled = true;
        currentState = "APPROVED";
        return jsonResponse(200, { data: { requestId: REQUEST_ID, lifecycleState: "ACTIVE" } });
      }
      if (url.includes(`/api/admin/activation-requests/${REQUEST_ID}`)) {
        return jsonResponse(200, detailBody({ state: currentState }));
      }
      return jsonResponse(404, {});
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: i18next.t("superadmin.review.actions.approve") }),
      ).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: i18next.t("superadmin.review.actions.approve") }));

    await waitFor(() => expect(approveCalled).toBe(true));
    await waitFor(() => expect(screen.getByTestId("already-decided")).toBeInTheDocument());
  });

  it("network/server error on the detail fetch shows an error state, not a blank screen", async () => {
    renderScreen((url) =>
      url.includes(`/api/admin/activation-requests/${REQUEST_ID}`)
        ? jsonResponse(500, { error_code: "INTERNAL", message_key: "errors.server", parameters: {} })
        : jsonResponse(404, {}),
    );

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(i18next.t("errors.server")));
  });
});
