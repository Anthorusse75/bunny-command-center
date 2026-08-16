import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { generateSessionToken, hashSessionToken } from "../../src/auth/sessionToken.js";

describe("opaque session tokens (ADR-020: 256-bit, hashed at rest)", () => {
  it("generates tokens with at least 256 bits of entropy (32 raw bytes, base64url-encoded)", () => {
    const token = generateSessionToken();
    // base64url of 32 bytes is 43 chars (no padding).
    expect(token.length).toBe(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("generates unique tokens across many calls", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateSessionToken()));
    expect(tokens.size).toBe(200);
  });

  it("hashing is deterministic (same input -> same hash, for lookup by presented token)", () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
  });

  it("hash matches a plain SHA-256 hex digest", () => {
    const token = "fixed-test-token-value";
    const expected = createHash("sha256").update(token, "utf-8").digest("hex");
    expect(hashSessionToken(token)).toBe(expected);
  });

  it("different tokens hash to different values", () => {
    const a = hashSessionToken(generateSessionToken());
    const b = hashSessionToken(generateSessionToken());
    expect(a).not.toBe(b);
  });
});
