import { describe, expect, it } from "vitest";
import { isSafeInternalRedirectPath } from "../../src/auth/redirectSafety.js";

describe("open-redirect / deep-link target validation (27_SECURITY.md §Open redirect)", () => {
  it("accepts ordinary internal paths", () => {
    expect(isSafeInternalRedirectPath("/")).toBe(true);
    expect(isSafeInternalRedirectPath("/guilds/123")).toBe(true);
    expect(isSafeInternalRedirectPath("/home?tab=notifications")).toBe(true);
  });

  it("rejects protocol-relative URLs (//evil.com)", () => {
    expect(isSafeInternalRedirectPath("//evil.example.com")).toBe(false);
    expect(isSafeInternalRedirectPath("///evil.example.com")).toBe(false);
  });

  it("rejects absolute URLs with a scheme", () => {
    expect(isSafeInternalRedirectPath("https://evil.example.com")).toBe(false);
    expect(isSafeInternalRedirectPath("http://evil.example.com")).toBe(false);
    expect(isSafeInternalRedirectPath("javascript:alert(1)")).toBe(false);
  });

  it("rejects backslash-based browser-normalization tricks", () => {
    expect(isSafeInternalRedirectPath("/\\evil.example.com")).toBe(false);
  });

  it("rejects a leading-slash value that still embeds a scheme (/https://evil.com)", () => {
    expect(isSafeInternalRedirectPath("/https://evil.example.com")).toBe(false);
  });

  it("rejects empty, missing, and non-leading-slash values", () => {
    expect(isSafeInternalRedirectPath("")).toBe(false);
    expect(isSafeInternalRedirectPath(undefined)).toBe(false);
    expect(isSafeInternalRedirectPath(null)).toBe(false);
    expect(isSafeInternalRedirectPath("relative/path")).toBe(false);
  });

  it("rejects control characters embedded in the path", () => {
    expect(isSafeInternalRedirectPath("/foo\nbar")).toBe(false);
    expect(isSafeInternalRedirectPath("/foo\0bar")).toBe(false);
  });

  it("rejects an excessively long value", () => {
    expect(isSafeInternalRedirectPath("/" + "a".repeat(600))).toBe(false);
  });
});
