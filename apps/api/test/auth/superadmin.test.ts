/**
 * ADR-008 negative-test list: "no code path, including a direct crafted API
 * request with a forged/self-reported Discord ID, can pass Superadmin
 * authorization for any ID other than the configured one."
 */
import { describe, expect, it } from "vitest";
import { isSuperadmin } from "../../src/auth/superadmin.js";

const REAL = "365417631706251265"; // the documented production value (ADR-008) — never used as a live secret, it's a public Discord user ID already cited throughout DASHBOARD/ADR-008
const config = { superadmin: { discordUserId: REAL } };

describe("isSuperadmin — the ONE Superadmin comparison, exact string match only", () => {
  it("returns true for the exact configured ID", () => {
    expect(isSuperadmin(REAL, config)).toBe(true);
  });

  it("returns false for any other ID, including a near-miss differing only in the last digit", () => {
    expect(isSuperadmin("365417631706251266", config)).toBe(false);
  });

  it("returns false for an ID that is numerically equal once coerced but a different real Snowflake string", () => {
    // Neither of these is actually the configured value — this specifically
    // proves the comparison is a STRING compare, not something that could
    // ever be fooled by numeric-precision collapse.
    const forged = "365417631706251265" + "0"; // a different, longer, forged ID
    expect(isSuperadmin(forged, config)).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isSuperadmin("", config)).toBe(false);
  });

  it("is a pure function of its two arguments — never reads any ambient/global state", () => {
    const otherConfig = { superadmin: { discordUserId: "900000000000000001" } };
    expect(isSuperadmin(REAL, otherConfig)).toBe(false);
    expect(isSuperadmin("900000000000000001", otherConfig)).toBe(true);
  });
});
