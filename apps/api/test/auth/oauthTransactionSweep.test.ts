/**
 * Lifecycle proof for `startOAuthTransactionSweep` (Copilot review finding,
 * Step 04 review pass: `OAuthTransactionRegistry.sweep()` was documented as
 * running periodically but never actually wired up anywhere). Uses fake
 * timers (mirrors this project's `runOnceForTests()` manual-trigger
 * convention already used for the SSE poller/session sweep, but exercised
 * here via the timer itself since this module's whole job IS the timer).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { OAuthTransactionRegistry } from "../../src/auth/oauthTransactionRegistry.js";
import { startOAuthTransactionSweep } from "../../src/auth/oauthTransactionSweep.js";

function fakeLogger(): FastifyBaseLogger {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger;
}

describe("startOAuthTransactionSweep (lifecycle)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("C. SWEEP LIFECYCLE ACTUALLY RUNS: the timer fires on its own schedule and removes a stale entry, with no manual trigger", () => {
    const registry = new OAuthTransactionRegistry();
    registry.tryConsume("stale-state");
    const handle = startOAuthTransactionSweep({
      registry,
      logger: fakeLogger(),
      intervalMs: 1000,
      maxAgeMs: 500,
    });

    // The first real tick fires at t=1000ms - by then the entry (consumed
    // at t=0) is already older than maxAgeMs (500ms).
    vi.advanceTimersByTime(1000);
    expect(registry.size).toBe(0);

    handle.stop();
  });

  it("A. RECENTLY CONSUMED STATE REMAINS REJECTED: several real sweep ticks that fire before an entry is stale never evict it, and it still blocks a replay", () => {
    const registry = new OAuthTransactionRegistry();
    registry.tryConsume("recent-state");
    const handle = startOAuthTransactionSweep({
      registry,
      logger: fakeLogger(),
      intervalMs: 100,
      maxAgeMs: 10_000, // far longer than the interval below
    });

    vi.advanceTimersByTime(300); // 3 real sweep ticks fire
    expect(registry.size).toBe(1);
    expect(registry.tryConsume("recent-state")).toBe(false); // replay still rejected

    handle.stop();
  });

  it("D. SHUTDOWN STOPS IT / NO TIMER LEAK: stop() halts the timer — no further sweep ticks fire afterward, even well past several would-be intervals", () => {
    const registry = new OAuthTransactionRegistry();
    registry.tryConsume("state-a");
    const handle = startOAuthTransactionSweep({
      registry,
      logger: fakeLogger(),
      intervalMs: 100,
      maxAgeMs: 50,
    });

    handle.stop();
    vi.advanceTimersByTime(10_000); // many would-be ticks, if the timer were still alive
    expect(registry.size).toBe(1); // untouched
  });

  it("runOnceForTests() sweeps synchronously without waiting for the real interval to elapse", () => {
    const registry = new OAuthTransactionRegistry();
    registry.tryConsume("state-a");
    const handle = startOAuthTransactionSweep({ registry, logger: fakeLogger(), maxAgeMs: 0 });

    vi.advanceTimersByTime(1); // strictly past maxAgeMs=0, so the entry is now eligible
    handle.runOnceForTests();
    expect(registry.size).toBe(0);

    handle.stop();
  });

  it("a sweep failure is logged, never thrown/crashes the process", () => {
    const registry = new OAuthTransactionRegistry();
    const throwingSweep = vi.spyOn(registry, "sweep").mockImplementation(() => {
      throw new Error("simulated sweep failure (test)");
    });
    const errorSpy = vi.fn<(obj: { err: unknown }, msg: string) => void>();
    const logger = { error: errorSpy, warn: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger;
    const handle = startOAuthTransactionSweep({ registry, logger });

    expect(() => handle.runOnceForTests()).not.toThrow();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [loggedObj, loggedMessage] = errorSpy.mock.calls[0]!;
    expect(loggedObj.err).toBeInstanceOf(Error);
    expect(loggedMessage).toContain("sweep failed");

    throwingSweep.mockRestore();
    handle.stop();
  });
});
