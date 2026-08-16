/**
 * Correctness-review defect 8: `registerSourceAdapter` must prove
 * `sourceIndex` is a positive safe integer (0 stays reserved for heartbeat)
 * BEFORE the adapter is ever wired into the poller/replay path - an invalid
 * sourceIndex here is a genuine programming bug that must fail loudly at
 * server startup (registration time), not surface later as a corrupt wire
 * id or a silent misattribution between two adapters sharing an index.
 */
import { afterEach, describe, expect, it } from "vitest";
import { registerSourceAdapter, resetRegistryForTests } from "../src/sse/registry.js";
import { HEARTBEAT_SOURCE_INDEX, type SourceAdapter, type SourceRow } from "../src/sse/types.js";

function fakeAdapter(overrides: Partial<SourceAdapter>): SourceAdapter {
  return {
    sourceTable: "some_table",
    sourceIndex: 1,
    fetchSince(): Promise<SourceRow[]> {
      return Promise.resolve([]);
    },
    oldestAvailableOrdinal(): Promise<number | null> {
      return Promise.resolve(null);
    },
    ...overrides,
  };
}

describe("registerSourceAdapter: sourceIndex invariants (correctness-review defect 8)", () => {
  afterEach(() => {
    resetRegistryForTests();
  });

  it("accepts a normal positive integer sourceIndex", () => {
    expect(() => registerSourceAdapter(fakeAdapter({ sourceIndex: 7 }))).not.toThrow();
  });

  it("rejects the reserved heartbeat sourceIndex (0)", () => {
    expect(() => registerSourceAdapter(fakeAdapter({ sourceIndex: HEARTBEAT_SOURCE_INDEX }))).toThrow(
      /reserved for heartbeat/,
    );
  });

  it("rejects a negative sourceIndex", () => {
    expect(() => registerSourceAdapter(fakeAdapter({ sourceIndex: -1 }))).toThrow(/negative sourceIndex/);
  });

  it("rejects a non-safe-integer sourceIndex (fractional)", () => {
    expect(() => registerSourceAdapter(fakeAdapter({ sourceIndex: 1.5 }))).toThrow(/non-safe-integer/);
  });

  it("rejects a non-safe-integer sourceIndex (beyond Number.MAX_SAFE_INTEGER)", () => {
    expect(() => registerSourceAdapter(fakeAdapter({ sourceIndex: Number.MAX_SAFE_INTEGER + 10 }))).toThrow(
      /non-safe-integer/,
    );
  });

  it("rejects a non-safe-integer sourceIndex (NaN)", () => {
    expect(() => registerSourceAdapter(fakeAdapter({ sourceIndex: Number.NaN }))).toThrow(/non-safe-integer/);
  });

  it("rejects a non-safe-integer sourceIndex (Infinity)", () => {
    expect(() => registerSourceAdapter(fakeAdapter({ sourceIndex: Number.POSITIVE_INFINITY }))).toThrow(
      /non-safe-integer/,
    );
  });

  it("still rejects a duplicate sourceIndex across two different adapters (pre-existing behavior, unaffected by the new checks)", () => {
    registerSourceAdapter(fakeAdapter({ sourceTable: "table_a", sourceIndex: 3 }));
    expect(() => registerSourceAdapter(fakeAdapter({ sourceTable: "table_b", sourceIndex: 3 }))).toThrow(
      /already used by adapter/,
    );
  });
});
