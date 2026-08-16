import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { generateCodeChallenge, generateCodeVerifier, generateState } from "../../src/auth/pkce.js";

describe("PKCE generation (RFC 7636)", () => {
  it("generates a code_verifier of sufficient length and charset", () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("generates a code_challenge that is the correct S256 hash of the verifier", () => {
    const verifier = generateCodeVerifier();
    const challenge = generateCodeChallenge(verifier);
    const expected = createHash("sha256")
      .update(verifier)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(challenge).toBe(expected);
  });

  it("generates unpredictable, unique verifiers/states across calls", () => {
    const verifiers = new Set(Array.from({ length: 50 }, () => generateCodeVerifier()));
    const states = new Set(Array.from({ length: 50 }, () => generateState()));
    expect(verifiers.size).toBe(50);
    expect(states.size).toBe(50);
  });

  it("state is never derived from / equal to a code_verifier generated alongside it", () => {
    const verifier = generateCodeVerifier();
    const state = generateState();
    expect(state).not.toBe(verifier);
  });
});
