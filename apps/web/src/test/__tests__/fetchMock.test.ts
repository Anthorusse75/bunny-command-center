// EXTERNAL REVIEW FINDING 1 (Copilot review pass) — `mockAuthenticatedSession`'s
// guild-list branch used to match ANY url containing "/api/users/me/guilds"
// via `.includes(...)`, which also matches the two mutation routes
// (`.../favorite`, `.../home-visibility`) and silently swallowed them with
// the guild-LIST response shape. This file proves the fix directly against
// the real `fetch` stub, independent of any component.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFetchMock, mockAuthenticatedSession, resetFetchHandler } from "../fetchMock.js";

describe("mockAuthenticatedSession — exact-match guild-list mock (Finding 1)", () => {
  beforeEach(() => {
    installFetchMock();
    mockAuthenticatedSession();
  });
  afterEach(() => {
    resetFetchHandler();
  });

  it("GET /api/users/me/guilds is mocked with the real guild-list response shape", async () => {
    const res = await fetch("/api/users/me/guilds");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { guilds: unknown[] } };
    expect(body.data.guilds).toEqual([]);
  });

  it("POST /api/users/me/guilds/:guildId/favorite is NOT swallowed by the guild-list mock", async () => {
    const res = await fetch("/api/users/me/guilds/111111111111111111/favorite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isFavorite: true }),
    });
    // Falls through to the generic 404 fallback, NOT the guild-list 200
    // shape — proves the mutation request reached past the list matcher.
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error_code: string };
    expect(body.error_code).toBe("NOT_FOUND");
  });

  it("PATCH /api/users/me/guilds/:guildId/home-visibility is NOT swallowed by the guild-list mock", async () => {
    const res = await fetch("/api/users/me/guilds/111111111111111111/home-visibility", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ homeVisible: true }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error_code: string };
    expect(body.error_code).toBe("NOT_FOUND");
  });

  it("a test's own setFetchHandler for the mutation routes is reachable (proves layering still works after the fix)", async () => {
    const { setFetchHandler } = await import("../fetchMock.js");
    setFetchHandler((url, init) => {
      if (url.includes("/api/auth/session")) {
        return new Response(JSON.stringify({ data: { user: {}, sessionId: "x", isSuperadmin: false } }), {
          status: 200,
        });
      }
      if (url === "/api/users/me/guilds/111111111111111111/favorite" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            data: {
              guildId: "111111111111111111",
              isFavorite: true,
              favoritedAt: null,
              homeVisible: false,
              lastUsedAt: null,
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    const res = await fetch("/api/users/me/guilds/111111111111111111/favorite", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { isFavorite: boolean } };
    expect(body.data.isFavorite).toBe(true);
  });
});
