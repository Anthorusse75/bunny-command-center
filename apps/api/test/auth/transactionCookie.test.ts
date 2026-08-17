import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  isTransactionExpired,
  OAUTH_TRANSACTION_MAX_AGE_MS,
  parseTransactionCookie,
  serializeTransactionCookie,
  type OAuthTransaction,
} from "../../src/auth/transactionCookie.js";

const KEY = randomBytes(32);

function sampleTransaction(overrides: Partial<OAuthTransaction> = {}): OAuthTransaction {
  return {
    state: "test-state-value",
    codeVerifier: "test-code-verifier-value",
    redirect: "/guilds/123",
    createdAtMs: Date.now(),
    ...overrides,
  };
}

describe("pre-auth OAuth transaction cookie (signed, tamper-evident)", () => {
  it("round-trips a transaction exactly", () => {
    const txn = sampleTransaction();
    const cookie = serializeTransactionCookie(txn, KEY);
    expect(parseTransactionCookie(cookie, KEY)).toEqual(txn);
  });

  it("rejects a tampered payload (state swapped for another value)", () => {
    const txn = sampleTransaction();
    const cookie = serializeTransactionCookie(txn, KEY);
    const [payload, signature] = cookie.split(".");
    const forgedTxn = sampleTransaction({ redirect: "https://evil.example.com" });
    const forgedPayload = Buffer.from(JSON.stringify(forgedTxn), "utf-8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const forgedCookie = `${forgedPayload}.${signature}`;
    expect(forgedCookie).not.toBe(cookie);
    expect(parseTransactionCookie(forgedCookie, KEY)).toBeNull();
    void payload;
  });

  it("rejects a cookie signed with a different key", () => {
    const txn = sampleTransaction();
    const cookie = serializeTransactionCookie(txn, KEY);
    const otherKey = randomBytes(32);
    expect(parseTransactionCookie(cookie, otherKey)).toBeNull();
  });

  it("fails closed (returns null, never throws) on malformed input", () => {
    expect(parseTransactionCookie(undefined, KEY)).toBeNull();
    expect(parseTransactionCookie("", KEY)).toBeNull();
    expect(parseTransactionCookie("not-a-valid-cookie", KEY)).toBeNull();
    expect(parseTransactionCookie("...", KEY)).toBeNull();
    expect(parseTransactionCookie("a.b.c.d.e", KEY)).toBeNull();
  });

  it("detects an expired transaction", () => {
    const staleTxn = sampleTransaction({ createdAtMs: Date.now() - OAUTH_TRANSACTION_MAX_AGE_MS - 1000 });
    expect(isTransactionExpired(staleTxn, OAUTH_TRANSACTION_MAX_AGE_MS)).toBe(true);
  });

  it("does not flag a fresh transaction as expired", () => {
    const freshTxn = sampleTransaction({ createdAtMs: Date.now() });
    expect(isTransactionExpired(freshTxn, OAUTH_TRANSACTION_MAX_AGE_MS)).toBe(false);
  });
});
