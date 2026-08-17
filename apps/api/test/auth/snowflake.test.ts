import { describe, expect, it } from "vitest";
import { isSyntacticallyValidSnowflake, snowflakeEquals } from "../../src/auth/snowflake.js";

describe("isSyntacticallyValidSnowflake", () => {
  it("accepts real-shaped Discord snowflakes (17-19 digits)", () => {
    expect(isSyntacticallyValidSnowflake("365417631706251265")).toBe(true);
    expect(isSyntacticallyValidSnowflake("700000000001")).toBe(false); // only 12 digits — below the 15-digit floor
  });

  it("rejects non-digit strings", () => {
    expect(isSyntacticallyValidSnowflake("not-a-snowflake")).toBe(false);
    expect(isSyntacticallyValidSnowflake("")).toBe(false);
    expect(isSyntacticallyValidSnowflake("12345.0")).toBe(false);
    expect(isSyntacticallyValidSnowflake("+365417631706251265")).toBe(false);
    expect(isSyntacticallyValidSnowflake("-365417631706251265")).toBe(false);
  });

  it("rejects a value too short to plausibly be a real snowflake", () => {
    expect(isSyntacticallyValidSnowflake("12345")).toBe(false);
  });

  it("rejects a value far too long to be a real 64-bit snowflake", () => {
    expect(isSyntacticallyValidSnowflake("1".repeat(40))).toBe(false);
  });
});

describe("snowflakeEquals — exact string identity, never numeric coercion", () => {
  it("two IDs differing only past Number.MAX_SAFE_INTEGER's precision stay distinct", () => {
    // These two 19-digit values are DIFFERENT strings that would silently
    // become the SAME JS number if ever coerced through Number(...) —
    // Number.MAX_SAFE_INTEGER is 2^53-1 (16 digits); both of these are 19.
    const a = "99999999999999999";
    const b = "99999999999999998";
    expect(a).not.toBe(b);
    expect(snowflakeEquals(a, b)).toBe(false);
    // Sanity-check the premise: naive numeric coercion WOULD collide these.
    expect(Number(a)).toBe(Number(b));
  });

  it("identical strings are equal", () => {
    expect(snowflakeEquals("365417631706251265", "365417631706251265")).toBe(true);
  });

  it("a value differing only in a leading zero is a genuinely different string, never equal", () => {
    expect(snowflakeEquals("0365417631706251265", "365417631706251265")).toBe(false);
  });
});
