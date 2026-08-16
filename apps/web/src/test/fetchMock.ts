/**
 * A minimal, controllable `fetch` stub for component tests that mount
 * `<AuthProvider>` (Step 04) — jsdom has no real network, and this repo's
 * convention (mirrors `eventSourceMock.ts` for `EventSource`) is a small,
 * test-only substitute installed once in `test/setup.ts`, never a per-test
 * ad hoc mock.
 *
 * Default behavior (installed fresh before every test): `GET
 * /api/auth/session` returns 401 (the honest "nobody is logged in yet"
 * state) — any test that needs the authenticated app surface calls
 * `mockAuthenticatedSession(...)` first.
 */
import type { AuthUser } from "../features/auth/AuthProvider.js";

type FetchHandler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function defaultHandler(url: string): Response {
  if (url.includes("/api/auth/session")) {
    return jsonResponse(401, {
      error_code: "UNAUTHENTICATED",
      message_key: "errors.auth.unauthenticated",
      parameters: {},
    });
  }
  return jsonResponse(404, { error_code: "NOT_FOUND", message_key: "errors.notFound", parameters: {} });
}

let currentHandler: FetchHandler = defaultHandler;

export function installFetchMock(): void {
  currentHandler = defaultHandler;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return Promise.resolve(currentHandler(url, init));
  };
}

export function setFetchHandler(handler: FetchHandler): void {
  currentHandler = handler;
}

export function resetFetchHandler(): void {
  currentHandler = defaultHandler;
}

const DEFAULT_TEST_USER: AuthUser = {
  id: 1,
  discordUserId: "123456789012345678",
  username: "TestUser",
  avatarHash: null,
  locale: "en",
  themeName: "fusion",
  themeMode: "system",
};

/** Points GET /api/auth/session at a successful, authenticated response — the shape apps/api/src/auth/routes.ts's GET /api/auth/session actually returns. */
export function mockAuthenticatedSession(user: Partial<AuthUser> = {}): void {
  const fullUser = { ...DEFAULT_TEST_USER, ...user };
  setFetchHandler((url) => {
    if (url.includes("/api/auth/session")) {
      return jsonResponse(200, { data: { user: fullUser, sessionId: "test-session-id" } });
    }
    return defaultHandler(url);
  });
}
