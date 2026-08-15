import { describe, expect, it } from "vitest";
import {
  encodeSseEventId,
  decodeSseEventId,
  advanceVector,
  guildScope,
  userScope,
  adminScope,
  PLATFORM_SCOPE,
  STEP_03_TEST_SCOPE,
  initialTransportState,
  nextTransportState,
  isPollingFallbackActive,
  isRealtimeHealthy,
  type RealtimeTransportState,
} from "../src/realtime/index.js";

describe("SSE event id vector encode/decode", () => {
  it("round-trips a single-source vector", () => {
    const vector = new Map([[3, 42]]);
    expect(decodeSseEventId(encodeSseEventId(vector))).toEqual(vector);
  });

  it("round-trips a multi-source vector, canonically sorted by sourceIndex", () => {
    const vector = new Map([
      [2, 7],
      [0, 5],
      [1, 100],
    ]);
    const encoded = encodeSseEventId(vector);
    expect(encoded).toBe("0:5,1:100,2:7");
    expect(decodeSseEventId(encoded)).toEqual(
      new Map([
        [0, 5],
        [1, 100],
        [2, 7],
      ]),
    );
  });

  it("rejects malformed ids safely (never throws)", () => {
    expect(decodeSseEventId("not-an-id")).toBeNull();
    expect(decodeSseEventId("")).toBeNull();
    expect(decodeSseEventId("1:")).toBeNull();
    expect(decodeSseEventId(":1")).toBeNull();
    expect(decodeSseEventId("1:2:3")).toBeNull();
    expect(decodeSseEventId("-1:2")).toBeNull();
    expect(decodeSseEventId("1.5:2")).toBeNull();
    expect(decodeSseEventId("1:2,1:3")).toBeNull(); // duplicate sourceIndex
    expect(decodeSseEventId("1:2,")).toBeNull();
  });

  it("advanceVector never regresses an existing entry", () => {
    const vector = new Map([[1, 10]]);
    expect(advanceVector(vector, 1, 5)).toEqual(new Map([[1, 10]])); // lower ordinal ignored
    expect(advanceVector(vector, 1, 15)).toEqual(new Map([[1, 15]])); // higher ordinal wins
    expect(advanceVector(vector, 2, 1)).toEqual(
      new Map([
        [1, 10],
        [2, 1],
      ]),
    ); // new source added
  });
});

describe("channel scope helpers", () => {
  it("build the documented scope strings", () => {
    expect(guildScope("42")).toBe("guild:42");
    expect(userScope("7")).toBe("user:7");
    expect(adminScope("42")).toBe("admin:42");
    expect(PLATFORM_SCOPE).toBe("platform");
    expect(STEP_03_TEST_SCOPE).toBe("test");
  });
});

describe("realtime transport state machine", () => {
  it("starts CONNECTING", () => {
    expect(initialTransportState()).toBe("CONNECTING");
  });

  it("CONNECTING -> LIVE on OPEN", () => {
    expect(nextTransportState("CONNECTING", { type: "OPEN" })).toBe("LIVE");
  });

  it("CONNECTING -> GRACE on ERROR (initial connection failure)", () => {
    expect(nextTransportState("CONNECTING", { type: "ERROR" })).toBe("GRACE");
  });

  it("LIVE -> GRACE on ERROR (transient disconnect)", () => {
    expect(nextTransportState("LIVE", { type: "ERROR" })).toBe("GRACE");
  });

  it("LIVE stays LIVE on repeated MESSAGE", () => {
    expect(nextTransportState("LIVE", { type: "MESSAGE" })).toBe("LIVE");
  });

  it("GRACE -> LIVE if recovery happens before the grace timer fires", () => {
    expect(nextTransportState("GRACE", { type: "OPEN" })).toBe("LIVE");
  });

  it("GRACE -> POLLING once the grace timer elapses (disconnect beyond grace)", () => {
    expect(nextTransportState("GRACE", { type: "GRACE_TIMEOUT" })).toBe("POLLING");
  });

  it("POLLING -> RECONNECTING on OPEN, not immediately LIVE (anti-oscillation)", () => {
    expect(nextTransportState("POLLING", { type: "OPEN" })).toBe("RECONNECTING");
  });

  it("RECONNECTING -> LIVE once a real frame is actually received", () => {
    expect(nextTransportState("RECONNECTING", { type: "MESSAGE" })).toBe("LIVE");
  });

  it("RECONNECTING -> POLLING again on a flaky re-drop (repeated reconnect, no false recovery)", () => {
    expect(nextTransportState("RECONNECTING", { type: "ERROR" })).toBe("POLLING");
  });

  it("OFFLINE from LIVE starts the grace path; ONLINE from GRACE re-attempts without waiting out the timer", () => {
    const afterOffline = nextTransportState("LIVE", { type: "OFFLINE" });
    expect(afterOffline).toBe("GRACE");
    expect(nextTransportState(afterOffline, { type: "ONLINE" })).toBe("GRACE");
  });

  it("POLLING is a stable state under repeated ERROR/OFFLINE (no state thrash, no duplicate poll loop signal)", () => {
    let state: RealtimeTransportState = "POLLING";
    for (let i = 0; i < 5; i++) {
      state = nextTransportState(state, { type: "ERROR" });
    }
    expect(state).toBe("POLLING");
  });

  it("fallback is active exactly in POLLING/RECONNECTING, and only those", () => {
    const all: RealtimeTransportState[] = ["CONNECTING", "LIVE", "GRACE", "POLLING", "RECONNECTING"];
    expect(all.filter(isPollingFallbackActive)).toEqual(["POLLING", "RECONNECTING"]);
  });

  it("only LIVE counts as healthy for UI purposes", () => {
    const all: RealtimeTransportState[] = ["CONNECTING", "LIVE", "GRACE", "POLLING", "RECONNECTING"];
    expect(all.filter(isRealtimeHealthy)).toEqual(["LIVE"]);
  });
});
