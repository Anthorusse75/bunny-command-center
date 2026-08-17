import { describe, expect, it } from "vitest";
import { OAuthTransactionRegistry } from "../../src/auth/oauthTransactionRegistry.js";

describe("OAuthTransactionRegistry (server-side single-use / replay guard)", () => {
  it("allows the first consumption of a state", () => {
    const registry = new OAuthTransactionRegistry();
    expect(registry.tryConsume("state-a")).toBe(true);
  });

  it("rejects a second consumption of the same state (replay)", () => {
    const registry = new OAuthTransactionRegistry();
    expect(registry.tryConsume("state-a")).toBe(true);
    expect(registry.tryConsume("state-a")).toBe(false);
    expect(registry.tryConsume("state-a")).toBe(false);
  });

  it("treats different states independently", () => {
    const registry = new OAuthTransactionRegistry();
    expect(registry.tryConsume("state-a")).toBe(true);
    expect(registry.tryConsume("state-b")).toBe(true);
  });

  it("sweep removes only entries older than maxAgeMs", () => {
    const registry = new OAuthTransactionRegistry();
    registry.tryConsume("old-state");
    // Simulate the passage of time by sweeping with an explicit "now" far in the future
    // relative to the real Date.now() the entry was consumed at.
    registry.sweep(1000, Date.now() + 10_000);
    expect(registry.size).toBe(0);
  });

  it("sweep keeps recent entries", () => {
    const registry = new OAuthTransactionRegistry();
    registry.tryConsume("recent-state");
    registry.sweep(60_000, Date.now());
    expect(registry.size).toBe(1);
  });
});
