/**
 * `pickDedupWinner` - the tie-break DECISION rule behind the multi-tab toast
 * dedup mechanism (26_REALTIME_SSE_AND_SYNC.md §Multi-tab) - proven
 * deterministically here (pure function, no timing dependency at all).
 *
 * The plumbing AROUND it (`createDedupClaimer`/`claimEventForToast`, real
 * `BroadcastChannel` messaging between genuinely separate tabs) is real
 * cross-process/cross-context behavior that jsdom's own `BroadcastChannel`
 * implementation was found NOT to reproduce reliably within a single Vitest
 * process (a plain Node script outside Vitest/jsdom running the identical
 * protocol was 100% deterministic across many repeated runs - ruling out a
 * production-code bug and pointing squarely at the test environment). Rather
 * than assert on flaky jsdom timing, the real multi-instance proof is where
 * mission `31_TEST_STRATEGY.md` itself assigns it: "Multi-tab: Playwright
 * multi-context tests" - see apps/web/e2e/realtime.spec.ts, which drives two
 * genuinely separate real Chromium browser contexts and asserts only one
 * shows the toast for the same server-broadcast event.
 */
import { describe, expect, it } from "vitest";
import { pickDedupWinner } from "../multiTabDedup.js";

describe("pickDedupWinner (pure tie-break rule)", () => {
  it("the lexicographically smallest tab id wins", () => {
    expect(pickDedupWinner("b", new Set(["b", "a", "c"]))).toBe(false);
    expect(pickDedupWinner("a", new Set(["b", "a", "c"]))).toBe(true);
  });

  it("a solo tab (only itself in the set) always wins", () => {
    expect(pickDedupWinner("solo-tab", new Set(["solo-tab"]))).toBe(true);
  });

  it("is deterministic and order-independent regardless of Set insertion order", () => {
    const forward = new Set(["z", "m", "a"]);
    const backward = new Set(["a", "m", "z"]);
    expect(pickDedupWinner("a", forward)).toBe(pickDedupWinner("a", backward));
    expect(pickDedupWinner("a", forward)).toBe(true);
  });

  it("scales to many tabs - exactly one id in a large set ever wins", () => {
    const ids = Array.from({ length: 50 }, (_, i) => `tab-${String(i).padStart(3, "0")}`);
    const seen = new Set(ids);
    const winners = ids.filter((id) => pickDedupWinner(id, seen));
    expect(winners).toEqual(["tab-000"]);
  });

  it("two tabs racing for the same event never both win", () => {
    const seen = new Set(["tab-x", "tab-y"]);
    expect([pickDedupWinner("tab-x", seen), pickDedupWinner("tab-y", seen)].filter(Boolean)).toHaveLength(1);
  });
});
