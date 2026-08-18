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

/**
 * Points GET /api/auth/session at a successful, authenticated response — the
 * shape apps/api/src/auth/routes.ts's GET /api/auth/session actually
 * returns. Step 06 addition: also mocks a default, deterministic (empty)
 * `GET /api/users/me/guilds` response, since `<App>` now always mounts the
 * real router (`navigation/routes.tsx`), and Home always calls
 * `useGuildList()` — without this, every test that authenticates would
 * otherwise hit the generic 404 fallback and render Home's zero-guild state
 * via an ERROR path rather than the real empty-list success path. Callers
 * that need a non-empty guild list call `setFetchHandler` themselves,
 * layering on top of (or replacing) this default.
 *
 * EXTERNAL REVIEW CORRECTION (Step 06, Copilot review pass, Finding 1): the
 * guild-list branch below used to match with `url.includes("/api/users/me/guilds")`
 * — a substring test that ALSO matches
 * `/api/users/me/guilds/:guildId/favorite` and
 * `/api/users/me/guilds/:guildId/home-visibility`, silently swallowing
 * those mutation requests and answering them with the guild-LIST response
 * shape instead of ever reaching a test's own mock (or the generic 404
 * fallback a test might be asserting against). Fixed to an exact path match
 * (stripped of any query string) plus a GET-only method check, so it can
 * only ever match the one real `GET /api/users/me/guilds` endpoint.
 */
export function mockAuthenticatedSession(
  user: Partial<AuthUser> = {},
  options: { isSuperadmin?: boolean } = {},
): void {
  const fullUser = { ...DEFAULT_TEST_USER, ...user };
  setFetchHandler((url, init) => {
    if (url.includes("/api/auth/session")) {
      return jsonResponse(200, {
        data: { user: fullUser, sessionId: "test-session-id", isSuperadmin: options.isSuperadmin ?? false },
      });
    }
    const path = url.split("?")[0];
    const method = (init?.method ?? "GET").toUpperCase();
    if (path === "/api/users/me/guilds" && method === "GET") {
      return jsonResponse(200, {
        data: {
          guilds: [],
          inviteEligibleGuilds: [],
          canInviteBunnyAnywhere: false,
          inviteUrl: "https://discord.com/oauth2/authorize?scope=bot",
        },
      });
    }
    return defaultHandler(url);
  });
}
