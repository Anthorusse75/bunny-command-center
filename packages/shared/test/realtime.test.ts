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
  guildLifecycleStateChangedDataSchema,
  type RealtimeTransportState,
  type SseCursorVector,
} from "../src/realtime/index.js";
import { lifecycleStateSchema } from "../src/types/lifecycle.js";

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

  it("advancing one source changes ONLY that source's watermark - every other entry is untouched (identity-preserved)", () => {
    const vector = new Map([
      [1, 10],
      [2, 20],
      [3, 30],
    ]);
    const next = advanceVector(vector, 2, 99);
    expect(next.get(1)).toBe(10);
    expect(next.get(2)).toBe(99);
    expect(next.get(3)).toBe(30);
    expect(next.size).toBe(3);
    // The original vector is never mutated in place (immutability - a
    // caller holding the old reference must never observe the advance).
    expect(vector.get(2)).toBe(20);
  });

  it("no vector regression can silently move a source backwards, even across repeated advances in mixed order", () => {
    let vector: SseCursorVector = new Map();
    const applied = [5, 3, 10, 1, 10, 20, 2, 20];
    for (const ordinal of applied) {
      vector = advanceVector(vector, 7, ordinal);
    }
    // Only the running maximum ever survives, regardless of arrival order.
    expect(vector.get(7)).toBe(20);
  });

  describe("canonical form, determinism, and round-trip stability", () => {
    it("canonical form is insertion-order-independent: the SAME key/value pairs always serialize to the EXACT SAME string", () => {
      const forward = new Map([
        [0, 5],
        [1, 100],
        [2, 7],
      ]);
      const backward = new Map([
        [2, 7],
        [1, 100],
        [0, 5],
      ]);
      const shuffled = new Map([
        [1, 100],
        [2, 7],
        [0, 5],
      ]);
      const encodedForward = encodeSseEventId(forward);
      expect(encodeSseEventId(backward)).toBe(encodedForward);
      expect(encodeSseEventId(shuffled)).toBe(encodedForward);
      expect(encodedForward).toBe("0:5,1:100,2:7");
    });

    it("encode -> decode -> encode is stable for a range of NON-EMPTY vector shapes", () => {
      // The empty vector is deliberately excluded here: `encodeSseEventId(new
      // Map())` produces `""`, but `decodeSseEventId("")` is intentionally
      // `null` (documented above `decodeSseEventId`'s own definition) - a
      // real client either omits `Last-Event-ID` entirely or sends a real
      // previously-issued id, and this server itself never encodes an empty
      // vector onto the wire (hub.ts always advances the vector by at least
      // one entry before its first `encodeSseEventId` call), so an empty
      // string is never a reachable round-trip input in practice. That
      // specific asymmetry is covered on its own below, not conflated with
      // this round-trip proof.
      const shapes: SseCursorVector[] = [
        new Map([[0, 0]]),
        new Map([[5, 12345]]),
        new Map([
          [0, 1],
          [1, 2],
          [2, 3],
          [3, 4],
        ]),
        new Map([[Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]]),
      ];
      for (const vector of shapes) {
        const once = encodeSseEventId(vector);
        const decoded = decodeSseEventId(once);
        expect(decoded).not.toBeNull();
        const twice = encodeSseEventId(decoded!);
        expect(twice).toBe(once);
      }
    });

    it("the empty vector's asymmetry is explicit and intentional, not an oversight", () => {
      expect(encodeSseEventId(new Map())).toBe("");
      // Feeding that empty string back into decode does NOT round-trip to
      // an empty vector - it is rejected, matching the documented rule that
      // an empty string is never a valid Last-Event-ID (see
      // decodeSseEventId's own doc comment).
      expect(decodeSseEventId(encodeSseEventId(new Map()))).toBeNull();
    });

    it("decoding is unambiguous: two syntactically different strings never decode to the same vector unless they ARE the canonical form of each other", () => {
      // "1:5,2:9" and "2:9,1:5" describe the same set of pairs but are
      // different raw strings - both must decode to an equal vector (Map
      // equality is by content here, not string identity), proving the
      // parser doesn't accidentally treat ordering as meaningful data.
      const a = decodeSseEventId("1:5,2:9");
      const b = decodeSseEventId("2:9,1:5");
      expect(a).toEqual(b);
      // But re-encoding EITHER always produces the one true canonical form.
      expect(encodeSseEventId(a!)).toBe("1:5,2:9");
      expect(encodeSseEventId(b!)).toBe("1:5,2:9");
    });
  });

  describe("malformed / hostile input safety", () => {
    it("rejects embedded CR, LF, or NUL anywhere in the raw input", () => {
      expect(decodeSseEventId("1:2\r\n3:4")).toBeNull();
      expect(decodeSseEventId("1:2\n")).toBeNull();
      expect(decodeSseEventId("1:2\r")).toBeNull();
      expect(decodeSseEventId("1:2\0")).toBeNull();
      expect(decodeSseEventId("\x001:2")).toBeNull();
      expect(decodeSseEventId("1\r:2")).toBeNull();
    });

    it("encodeSseEventId can never PRODUCE a CR, LF, or NUL for any valid vector (grammar is digits/colon/comma only)", () => {
      const vector = new Map([
        [0, 0],
        [1, Number.MAX_SAFE_INTEGER],
        [42, 7],
      ]);
      const encoded = encodeSseEventId(vector);
      expect(encoded).not.toMatch(/[\r\n\0]/);
      expect(encoded).toMatch(/^[0-9:,]*$/);
    });

    it("rejects integers exceeding Number.isSafeInteger bounds rather than silently truncating/wrapping", () => {
      // 2^53 - Number.MAX_SAFE_INTEGER is 2^53-1; one past it must be rejected.
      expect(decodeSseEventId("9007199254740992:1")).toBeNull(); // 2^53, unsafe
      expect(decodeSseEventId("1:9007199254740992")).toBeNull();
      expect(decodeSseEventId(`${Number.MAX_SAFE_INTEGER}:1`)).not.toBeNull(); // exactly at the boundary is fine
      expect(decodeSseEventId("99999999999999999999999999:1")).toBeNull(); // wildly oversized
    });

    it("enforces a maximum raw encoded length before attempting to split/parse (defense against a hostile Last-Event-ID)", () => {
      const hostile = Array.from({ length: 2000 }, (_, i) => `${i}:${i}`).join(",");
      expect(hostile.length).toBeGreaterThan(4096);
      expect(decodeSseEventId(hostile)).toBeNull();
    });

    it("enforces a maximum entry count independent of raw length", () => {
      const tooManyShortEntries = Array.from({ length: 65 }, (_, i) => `${i}:1`).join(",");
      expect(decodeSseEventId(tooManyShortEntries)).toBeNull();
      const exactlyAtLimit = Array.from({ length: 64 }, (_, i) => `${i}:1`).join(",");
      expect(decodeSseEventId(exactlyAtLimit)).not.toBeNull();
    });

    it("duplicate sourceIndex within one id is rejected outright, never resolved by picking either value (no ambiguous state)", () => {
      expect(decodeSseEventId("1:5,1:5")).toBeNull(); // even identical duplicate values
      expect(decodeSseEventId("1:5,2:9,1:7")).toBeNull(); // duplicate not adjacent
    });

    it("an unknown (unregistered) sourceIndex is syntactically VALID and decodes successfully - safe consumption is the consumer's responsibility, not the codec's", () => {
      // This documents the boundary explicitly: the codec only enforces
      // GRAMMAR validity. What a server does with a sourceIndex it doesn't
      // currently recognize is proven at the consumer
      // (apps/api/test/sse-stream.test.ts's replay tests - an adapter only
      // ever looks up ITS OWN sourceIndex in the decoded vector, so an
      // unrecognized entry is simply never read, never errors).
      const decoded = decodeSseEventId("999:1");
      expect(decoded).toEqual(new Map([[999, 1]]));
    });
  });

  describe("internal invariants: advanceVector/encodeSseEventId reject invalid INTERNAL state (correctness-review defect 8)", () => {
    // These are distinct from the "malformed / hostile input safety" suite
    // above: that suite is about untrusted WIRE input (decodeSseEventId,
    // which never throws). These are about this codebase's OWN internal
    // callers (apps/api/src/sse/hub.ts's sendEvent/broadcast, fed only by a
    // registered adapter's own sourceIndex constant and a source row's own
    // durable ordinal) passing an invalid value - which is a genuine
    // programming bug, not attacker input, so the right behavior is to
    // throw loudly rather than silently produce a wire id the decoder would
    // itself reject.

    it("advanceVector rejects a negative sourceIndex", () => {
      expect(() => advanceVector(new Map(), -1, 5)).toThrow(/sourceIndex/);
    });

    it("advanceVector rejects a non-safe-integer sourceIndex", () => {
      expect(() => advanceVector(new Map(), 1.5, 5)).toThrow(/sourceIndex/);
      expect(() => advanceVector(new Map(), Number.NaN, 5)).toThrow(/sourceIndex/);
      expect(() => advanceVector(new Map(), Number.POSITIVE_INFINITY, 5)).toThrow(/sourceIndex/);
    });

    it("advanceVector rejects a negative ordinal", () => {
      expect(() => advanceVector(new Map(), 1, -1)).toThrow(/ordinal/);
    });

    it("advanceVector rejects a non-safe-integer ordinal", () => {
      expect(() => advanceVector(new Map(), 1, 5.5)).toThrow(/ordinal/);
      expect(() => advanceVector(new Map(), 1, Number.NaN)).toThrow(/ordinal/);
    });

    it("advanceVector accepts ordinal 0 (a source's very first, zero-based durable row)", () => {
      expect(() => advanceVector(new Map(), 1, 0)).not.toThrow();
    });

    it("encodeSseEventId throws rather than emitting an id decodeSseEventId would reject, if handed an internally-invalid vector directly", () => {
      // A hostile/buggy caller bypassing advanceVector's own guard by
      // constructing a Map directly - encodeSseEventId must not trust its
      // input either, so corrupt internal state can never reach the wire.
      expect(() => encodeSseEventId(new Map([[-1, 5]]))).toThrow(/sourceIndex/);
      expect(() => encodeSseEventId(new Map([[1, -5]]))).toThrow(/ordinal/);
      expect(() => encodeSseEventId(new Map([[1.5, 5]]))).toThrow(/sourceIndex/);
    });

    it("encodeSseEventId throws if the internal vector exceeds MAX_VECTOR_ENTRIES, rather than truncating and silently losing a source's position", () => {
      const oversized = new Map<number, number>();
      for (let i = 0; i < 65; i++) {
        oversized.set(i + 1, 1); // 65 entries > MAX_VECTOR_ENTRIES (64), sourceIndex 0 avoided (heartbeat-reserved)
      }
      expect(() => encodeSseEventId(oversized)).toThrow(/MAX_VECTOR_ENTRIES/);
    });

    it("every output of encodeSseEventId for a VALID vector is always successfully re-decoded (the guard never rejects legitimate internal state)", () => {
      const vector = new Map([
        [1, 100],
        [2, 250],
        [64, 9999],
      ]);
      const encoded = encodeSseEventId(vector);
      expect(decodeSseEventId(encoded)).toEqual(vector);
    });
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

describe("guildLifecycleStateChangedDataSchema (PR #7 review finding: reuses canonical discordSnowflakeSchema/lifecycleStateSchema, never a second weaker definition)", () => {
  it("accepts a real-shape event: valid Discord snowflake + two real lifecycle states", () => {
    const result = guildLifecycleStateChangedDataSchema.safeParse({
      guildId: "600000000000000001",
      previousState: "CONFIGURING",
      lifecycleState: "PENDING_APPROVAL",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a malformed/non-Snowflake guildId", () => {
    for (const guildId of ["not-a-guild-id", "123", "", "600000000000000001x"]) {
      const result = guildLifecycleStateChangedDataSchema.safeParse({
        guildId,
        previousState: "CONFIGURING",
        lifecycleState: "PENDING_APPROVAL",
      });
      expect(result.success).toBe(false);
    }
  });

  it("rejects an unknown previousState", () => {
    const result = guildLifecycleStateChangedDataSchema.safeParse({
      guildId: "600000000000000001",
      previousState: "NOT_A_REAL_STATE",
      lifecycleState: "PENDING_APPROVAL",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown lifecycleState", () => {
    const result = guildLifecycleStateChangedDataSchema.safeParse({
      guildId: "600000000000000001",
      previousState: "CONFIGURING",
      lifecycleState: "NOT_A_REAL_STATE",
    });
    expect(result.success).toBe(false);
  });

  it("accepts every canonical LifecycleState in both the previousState and lifecycleState positions", () => {
    for (const state of lifecycleStateSchema.options) {
      const result = guildLifecycleStateChangedDataSchema.safeParse({
        guildId: "600000000000000001",
        previousState: state,
        lifecycleState: state,
      });
      expect(result.success).toBe(true);
    }
  });
});
