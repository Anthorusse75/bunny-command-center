import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { AuthProvider, useAuth } from "../AuthProvider.js";
import { apiFetch } from "../apiClient.js";
import { mockAuthenticatedSession, setFetchHandler } from "../../../test/fetchMock.js";

function Probe(): React.JSX.Element {
  const { status, user, sessionExpired } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="username">{user?.username ?? ""}</span>
      <span data-testid="expired">{sessionExpired ? "true" : "false"}</span>
    </div>
  );
}

describe("AuthProvider", () => {
  it("starts in 'loading', then resolves to 'unauthenticated' when the session check 401s (the honest default)", async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    expect(screen.getByTestId("status")).toHaveTextContent("loading");
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("unauthenticated"));
  });

  it("resolves to 'authenticated' with the real user payload when the session check succeeds", async () => {
    mockAuthenticatedSession({ username: "AliceOnDiscord" });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));
    expect(screen.getByTestId("username")).toHaveTextContent("AliceOnDiscord");
  });

  it("never treats the initial 401 bootstrap check itself as a 'session expired' event", async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("unauthenticated"));
    expect(screen.getByTestId("expired")).toHaveTextContent("false");
  });

  it("a LATER 401 from any other API call flips sessionExpired — the shared global interceptor (SCREENS/AUTH.md)", async () => {
    mockAuthenticatedSession();
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));

    setFetchHandler((url) => {
      if (url.includes("/api/auth/session")) {
        return new Response(JSON.stringify({ data: { user: {}, sessionId: "x" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ error_code: "UNAUTHENTICATED" }), { status: 401 });
    });
    await act(async () => {
      await apiFetch("/api/some/other/protected/route");
    });

    await waitFor(() => expect(screen.getByTestId("expired")).toHaveTextContent("true"));
  });

  it("useAuth throws outside an AuthProvider (fails loud, never a silent undefined context)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/useAuth must be used inside/);
    spy.mockRestore();
  });
});
