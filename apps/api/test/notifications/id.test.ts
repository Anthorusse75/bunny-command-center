import { describe, expect, it } from "vitest";
import { generateNotificationId, isSyntacticallyValidNotificationId } from "../../src/notifications/id.js";

describe("generateNotificationId", () => {
  it("produces a 26-character Crockford-Base32 ULID shape", () => {
    const id = generateNotificationId();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(isSyntacticallyValidNotificationId(id)).toBe(true);
  });

  it("is time-sortable — a later timestamp always sorts after an earlier one, ties broken by random suffix", () => {
    const a = generateNotificationId(1_000_000);
    const b = generateNotificationId(2_000_000);
    expect(a < b).toBe(true);
  });

  it("two ids generated at the same instant are distinct (random suffix)", () => {
    const now = Date.now();
    const a = generateNotificationId(now);
    const b = generateNotificationId(now);
    expect(a).not.toBe(b);
    // Still equal on their shared timestamp prefix.
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
  });

  it("isSyntacticallyValidNotificationId rejects garbage", () => {
    expect(isSyntacticallyValidNotificationId("too-short")).toBe(false);
    expect(isSyntacticallyValidNotificationId("I".repeat(26))).toBe(false); // 'I' is excluded from Crockford Base32
    expect(isSyntacticallyValidNotificationId("L".repeat(26))).toBe(false); // 'L' is excluded too
    expect(isSyntacticallyValidNotificationId("O".repeat(26))).toBe(false); // 'O' is excluded too
    expect(isSyntacticallyValidNotificationId("a".repeat(26))).toBe(false); // lowercase never accepted
  });

  it("isSyntacticallyValidNotificationId REJECTS 'U' (a PR review comment incorrectly claimed the pattern `[0-9A-HJKMNP-TV-Z]` admits 'U'; it does not — the class is 0-9, A-H, J, K, M, N, P-T (P,Q,R,S,T), V-Z (V,W,X,Y,Z), and U falls in neither the P-T nor V-Z sub-range, so it is excluded exactly like the Crockford spec requires)", () => {
    expect(isSyntacticallyValidNotificationId("U".repeat(26))).toBe(false);
    // A candidate that is otherwise perfectly valid except for one 'U'.
    const validPrefix = "0123456789ABCDEFGHJKMNPQR"; // 25 valid Crockford chars
    expect(isSyntacticallyValidNotificationId(validPrefix + "U")).toBe(false);
    expect(isSyntacticallyValidNotificationId(validPrefix + "S")).toBe(true); // control: same prefix, valid last char
  });
});
