import { describe, expect, it } from "vitest";
import { bindBigIntUnsigned } from "../../src/db/bigIntParam.js";

describe("bindBigIntUnsigned — never runs a Snowflake through Number()", () => {
  it("returns the exact string unchanged (typed as number only for Kysely's benefit)", () => {
    const huge = "9223372036854775807"; // past Number.MAX_SAFE_INTEGER
    const bound = bindBigIntUnsigned(huge);
    // The runtime value is still the exact string — proven by comparing
    // against a value Number() WOULD have collided it with.
    expect(String(bound)).toBe(huge);
    expect(bound).not.toBe(Number(huge));
  });

  it("throws for a non-digit-string input rather than silently truncating", () => {
    expect(() => bindBigIntUnsigned("not-a-number")).toThrow();
    expect(() => bindBigIntUnsigned("-5")).toThrow();
    expect(() => bindBigIntUnsigned("5.5")).toThrow();
  });

  it("range: accepts exactly BIGINT UNSIGNED's max, rejects one past it (BigInt comparison, never Number())", () => {
    const max = "18446744073709551615"; // 2^64-1
    const overMax = "18446744073709551616";
    expect(String(bindBigIntUnsigned(max))).toBe(max);
    expect(() => bindBigIntUnsigned(overMax)).toThrow();
  });
});
