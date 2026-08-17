import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, apiJson, ApiError, onSessionExpired } from "../apiClient.js";
import { setFetchHandler } from "../../../test/fetchMock.js";

describe("apiClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends credentials: 'include' on every request (the httpOnly session cookie rides along automatically)", async () => {
    let observedInit: RequestInit | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn((_input, init?: RequestInit) => {
      observedInit = init;
      return Promise.resolve(new Response(JSON.stringify({ data: {} }), { status: 200 }));
    }) as typeof fetch;
    try {
      await apiFetch("/api/whatever");
      expect(observedInit?.credentials).toBe("include");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("adds the CSRF header on mutating methods (POST/PUT/PATCH/DELETE) but NOT on GET", async () => {
    const seenHeaders: Record<string, Headers> = {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn((_input, init?: RequestInit) => {
      seenHeaders[init?.method ?? "GET"] = new Headers(init?.headers);
      return Promise.resolve(new Response(JSON.stringify({ data: {} }), { status: 200 }));
    }) as typeof fetch;
    try {
      await apiFetch("/api/x", { method: "GET" });
      await apiFetch("/api/x", { method: "POST" });
      await apiFetch("/api/x", { method: "DELETE" });
      expect(seenHeaders.GET!.has("X-Requested-With")).toBe(false);
      expect(seenHeaders.POST!.get("X-Requested-With")).toBe("BunnyCommandCenter");
      expect(seenHeaders.DELETE!.get("X-Requested-With")).toBe("BunnyCommandCenter");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("apiJson unwraps the {data} success envelope", async () => {
    setFetchHandler(() => new Response(JSON.stringify({ data: { hello: "world" } }), { status: 200 }));
    const result = await apiJson<{ hello: string }>("/api/x");
    expect(result).toEqual({ hello: "world" });
  });

  it("apiJson throws ApiError with the error envelope on a non-2xx response", async () => {
    setFetchHandler(
      () =>
        new Response(
          JSON.stringify({ error_code: "SOMETHING", message_key: "errors.generic", parameters: {} }),
          { status: 400 },
        ),
    );
    await expect(apiJson("/api/x")).rejects.toBeInstanceOf(ApiError);
    await expect(apiJson("/api/x")).rejects.toMatchObject({ status: 400 });
  });

  it("a 401 response notifies every onSessionExpired subscriber", async () => {
    setFetchHandler(() => new Response(JSON.stringify({ error_code: "UNAUTHENTICATED" }), { status: 401 }));
    const listener = vi.fn();
    const unsubscribe = onSessionExpired(listener);
    try {
      await apiFetch("/api/protected");
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it("suppressSessionExpiredNotification skips the 401 notification (used only by the initial bootstrap check)", async () => {
    setFetchHandler(() => new Response(JSON.stringify({ error_code: "UNAUTHENTICATED" }), { status: 401 }));
    const listener = vi.fn();
    const unsubscribe = onSessionExpired(listener);
    try {
      await apiFetch("/api/auth/session", { suppressSessionExpiredNotification: true });
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});
