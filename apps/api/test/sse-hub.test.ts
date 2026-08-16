/**
 * Unit-level proof of the hub's backpressure/bounded-queue behavior (mission
 * §16) and per-connection Last-Event-ID vector bookkeeping. Uses a minimal
 * fake `http.ServerResponse`-shaped object so `write()`'s return value (the
 * real Node backpressure signal) can be controlled precisely and
 * deterministically - something that is impractical to arrange reliably over
 * a real socket in a fast unit test. The REAL end-to-end HTTP streaming
 * proof (headers, genuine incremental delivery, real backpressure over a
 * real socket) is in sse-stream.test.ts.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { SseHub } from "../src/sse/hub.js";
import { STEP_03_TEST_SCOPE } from "@bunny-command-center/shared";

class FakeResponse extends EventEmitter {
  written: string[] = [];
  /** When false, the NEXT write() call returns false (simulates backpressure) and queues everything after. */
  acceptWrites = true;
  ended = false;

  write(chunk: string): boolean {
    // Matches real Node semantics: write() ALWAYS hands the chunk to the
    // stream (nothing is lost on the current call) - the boolean return
    // value is only an advisory "please pause before your NEXT write"
    // signal, which is what the hub's own queueing logic reacts to.
    this.written.push(chunk);
    return this.acceptWrites;
  }

  end(): void {
    this.ended = true;
  }

  destroy(): void {
    this.ended = true;
  }

  simulateDrain(): void {
    this.acceptWrites = true;
    this.emit("drain");
  }
}

describe("SseHub", () => {
  it("delivers a business event only to connections subscribed to its scope", () => {
    const hub = new SseHub();
    const resA = new FakeResponse();
    const resB = new FakeResponse();
    const handleA = hub.register({
      scopes: [STEP_03_TEST_SCOPE],
      initialVector: new Map(),
      res: resA as never,
      maxQueuedFrames: 10,
      retryMs: 1000,
    });
    const handleB = hub.register({
      scopes: ["platform"],
      initialVector: new Map(),
      res: resB as never,
      maxQueuedFrames: 10,
      retryMs: 1000,
    });
    // A real caller (route.ts's replayOrResync) always calls completeReplay
    // once - here, simulating two fresh connections with nothing to replay.
    hub.completeReplay(handleA.connectionId);
    hub.completeReplay(handleB.connectionId);

    hub.broadcast(STEP_03_TEST_SCOPE, 1, 5, "dashboard.sse_test_event", { n: 1 });

    expect(resA.written).toHaveLength(1);
    expect(resA.written[0]).toContain("event: dashboard.sse_test_event");
    expect(resA.written[0]).toContain("id: 1:5");
    expect(resB.written).toHaveLength(0);
  });

  it("advances a connection's id vector across multiple sources without losing earlier positions", () => {
    const hub = new SseHub();
    const res = new FakeResponse();
    const handle = hub.register({
      scopes: [STEP_03_TEST_SCOPE],
      initialVector: new Map(),
      res: res as never,
      maxQueuedFrames: 10,
      retryMs: 1000,
    });
    hub.completeReplay(handle.connectionId);

    hub.broadcast(STEP_03_TEST_SCOPE, 1, 5, "a", {});
    hub.broadcast(STEP_03_TEST_SCOPE, 2, 9, "b", {});
    hub.broadcast(STEP_03_TEST_SCOPE, 1, 6, "a", {});

    expect(res.written[0]).toContain("id: 1:5");
    expect(res.written[1]).toContain("id: 1:5,2:9");
    expect(res.written[2]).toContain("id: 1:6,2:9");
  });

  describe("backpressure overflow terminates the connection (correctness-review defect 1 - superseded drop-oldest-and-continue design)", () => {
    it("test A: once a slow client's outbound queue exceeds its bound, the connection is terminated - not kept open with a frame dropped", () => {
      const hub = new SseHub();
      const res = new FakeResponse();
      res.acceptWrites = false; // simulate an immediately-backpressured client
      const handle = hub.register({
        scopes: [STEP_03_TEST_SCOPE],
        initialVector: new Map(),
        res: res as never,
        maxQueuedFrames: 3,
        retryMs: 1000,
      });

      for (let i = 1; i <= 5; i++) {
        handle.sendEvent(1, i, "dashboard.sse_test_event", { n: i });
      }

      // Frame 1 was handed directly to res.write() (real Node's first-call
      // semantics). Frames 2,3,4 queue behind it (queue length reaches 3,
      // exactly at the bound - still fine). Frame 5 pushes the queue to 4,
      // EXCEEDING the bound of 3 - the connection is terminated right there,
      // not "frame 5 dropped, 6.. delivered normally".
      expect(res.written).toHaveLength(1); // only the direct write for frame 1 ever happened
      expect(res.ended).toBe(true); // socket genuinely destroyed, not left open
      expect(hub.activeConnectionCount).toBe(0);
    });

    it("test B: no event queued or sent AFTER the overflow can ever reach the client - a later cursor can never silently represent progress past the dropped position", () => {
      const hub = new SseHub();
      const res = new FakeResponse();
      res.acceptWrites = false;
      const handle = hub.register({
        scopes: [STEP_03_TEST_SCOPE],
        initialVector: new Map(),
        res: res as never,
        maxQueuedFrames: 2,
        retryMs: 1000,
      });

      handle.sendEvent(1, 1, "a", {}); // direct write (frame 1)
      handle.sendEvent(1, 2, "a", {}); // queued (queue length 1)
      handle.sendEvent(1, 3, "a", {}); // queued (queue length 2 - AT the bound, not yet over)
      expect(res.ended).toBe(false);
      handle.sendEvent(1, 4, "a", {}); // queued (queue length 3) - EXCEEDS bound of 2 -> overflow, terminate
      expect(res.ended).toBe(true);

      // Anything sent after this point must never be delivered - proving
      // event 4 (the one that overflowed) can never be silently skipped by
      // a later id reaching the client instead.
      handle.sendEvent(1, 5, "a", {});
      handle.sendEvent(1, 6, "a", {});
      expect(res.written).toHaveLength(1); // still just frame 1's direct write
      expect(handle.queuedFrameCount).toBe(0); // queue was cleared on termination, not left holding 5/6
    });

    it("test E: another healthy client on the same broadcast is completely unaffected by a slow client's overflow", () => {
      const hub = new SseHub();
      const resSlow = new FakeResponse();
      resSlow.acceptWrites = false;
      const resHealthy = new FakeResponse();
      const slowHandle = hub.register({
        scopes: [STEP_03_TEST_SCOPE],
        initialVector: new Map(),
        res: resSlow as never,
        maxQueuedFrames: 2,
        retryMs: 1000,
      });
      const healthyHandle = hub.register({
        scopes: [STEP_03_TEST_SCOPE],
        initialVector: new Map(),
        res: resHealthy as never,
        maxQueuedFrames: 2,
        retryMs: 1000,
      });
      // Both connections are already "caught up" for this test's purposes -
      // move them LIVE so `broadcast()` writes directly instead of
      // buffering into the replay bridge (a separate concern, tested below).
      hub.completeReplay(slowHandle.connectionId);
      hub.completeReplay(healthyHandle.connectionId);
      expect(hub.activeConnectionCount).toBe(2);

      for (let i = 1; i <= 5; i++) {
        hub.broadcast(STEP_03_TEST_SCOPE, 1, i, "a", { n: i });
      }

      // The slow connection overflowed its queue (bound 2) and was
      // terminated by broadcast 4.
      expect(resSlow.ended).toBe(true);
      // The healthy connection received every single broadcast normally -
      // the slow client's overflow had zero effect on it.
      expect(resHealthy.written).toHaveLength(5);
      expect(hub.activeConnectionCount).toBe(1);
    });
  });

  describe("replay <-> live phase and bridge buffer (correctness-review defect 3)", () => {
    it("a connection still REPLAYING (the default at registration) does not receive broadcast() events directly - they are buffered instead", () => {
      const hub = new SseHub();
      const res = new FakeResponse();
      hub.register({
        scopes: [STEP_03_TEST_SCOPE],
        initialVector: new Map(),
        res: res as never,
        maxQueuedFrames: 10,
        retryMs: 1000,
      });

      hub.broadcast(STEP_03_TEST_SCOPE, 1, 5, "a", { n: 5 });
      hub.broadcastControl(STEP_03_TEST_SCOPE, "resync_required", {
        scope: STEP_03_TEST_SCOPE,
        reason: "REPLAY_GAP",
      });

      expect(res.written).toHaveLength(0); // nothing written yet - still buffered
    });

    it("completeReplay() flushes buffered events in arrival order and flips the connection LIVE", () => {
      const hub = new SseHub();
      const res = new FakeResponse();
      const handle = hub.register({
        scopes: [STEP_03_TEST_SCOPE],
        initialVector: new Map(),
        res: res as never,
        maxQueuedFrames: 10,
        retryMs: 1000,
      });

      hub.broadcast(STEP_03_TEST_SCOPE, 1, 5, "a", { n: 5 });
      hub.broadcast(STEP_03_TEST_SCOPE, 2, 9, "b", { n: 9 });
      expect(res.written).toHaveLength(0);

      hub.completeReplay(handle.connectionId);

      expect(res.written).toHaveLength(2);
      expect(res.written[0]).toContain("id: 1:5");
      expect(res.written[1]).toContain("id: 1:5,2:9");

      // Now genuinely LIVE - further broadcasts write immediately, no more buffering.
      hub.broadcast(STEP_03_TEST_SCOPE, 1, 6, "a", { n: 6 });
      expect(res.written).toHaveLength(3);
      expect(res.written[2]).toContain("id: 1:6,2:9");
    });

    it("completeReplay() is idempotent - calling it twice never re-flushes or double-delivers", () => {
      const hub = new SseHub();
      const res = new FakeResponse();
      const handle = hub.register({
        scopes: [STEP_03_TEST_SCOPE],
        initialVector: new Map(),
        res: res as never,
        maxQueuedFrames: 10,
        retryMs: 1000,
      });
      hub.broadcast(STEP_03_TEST_SCOPE, 1, 5, "a", {});
      hub.completeReplay(handle.connectionId);
      expect(res.written).toHaveLength(1);

      hub.completeReplay(handle.connectionId); // second call - no-op
      expect(res.written).toHaveLength(1);
    });

    it("completeReplay() on an already-closed/unknown connectionId is a silent no-op (never throws)", () => {
      const hub = new SseHub();
      expect(() => hub.completeReplay("nonexistent-connection-id")).not.toThrow();
    });

    it("the bridge buffer is bounded - exceeding it terminates the connection rather than silently dropping a buffered live event", () => {
      const hub = new SseHub();
      const res = new FakeResponse();
      const handle = hub.register({
        scopes: [STEP_03_TEST_SCOPE],
        initialVector: new Map(),
        res: res as never,
        maxQueuedFrames: 2, // also used as the bridge buffer bound
        retryMs: 1000,
      });

      hub.broadcast(STEP_03_TEST_SCOPE, 1, 1, "a", {}); // buffered (1)
      hub.broadcast(STEP_03_TEST_SCOPE, 1, 2, "a", {}); // buffered (2) - at bound
      expect(hub.activeConnectionCount).toBe(1);
      hub.broadcast(STEP_03_TEST_SCOPE, 1, 3, "a", {}); // buffered (3) - EXCEEDS bound -> terminate

      expect(hub.activeConnectionCount).toBe(0);
      expect(res.ended).toBe(true);
      expect(res.written).toHaveLength(0); // never got to flush anything - terminated first

      // completeReplay on the now-gone connection must not throw or resurrect it.
      expect(() => hub.completeReplay(handle.connectionId)).not.toThrow();
    });

    it("broadcastControl also respects the REPLAYING phase and is included in the flush, in the same relative order as the events around it", () => {
      const hub = new SseHub();
      const res = new FakeResponse();
      const handle = hub.register({
        scopes: [STEP_03_TEST_SCOPE],
        initialVector: new Map(),
        res: res as never,
        maxQueuedFrames: 10,
        retryMs: 1000,
      });

      hub.broadcast(STEP_03_TEST_SCOPE, 1, 1, "a", {});
      hub.broadcastControl(STEP_03_TEST_SCOPE, "resync_required", {
        scope: STEP_03_TEST_SCOPE,
        reason: "REPLAY_GAP",
      });
      hub.broadcast(STEP_03_TEST_SCOPE, 1, 2, "a", {});
      hub.completeReplay(handle.connectionId);

      expect(res.written).toHaveLength(3);
      expect(res.written[0]).toContain("id: 1:1");
      expect(res.written[1]).toContain("event: resync_required");
      expect(res.written[1]).not.toMatch(/^id:/m); // control frames never carry an id
      expect(res.written[2]).toContain("id: 1:2");
    });
  });

  it("flushes queued frames once the real Node 'drain' event fires, respecting partial re-backpressure", () => {
    const hub = new SseHub();
    const res = new FakeResponse();
    const handle = hub.register({
      scopes: [STEP_03_TEST_SCOPE],
      initialVector: new Map(),
      res: res as never,
      maxQueuedFrames: 10,
      retryMs: 1000,
    });

    res.acceptWrites = false;
    handle.sendEvent(1, 1, "a", {}); // attempted directly, returns false -> subsequent writes queue
    handle.sendEvent(1, 2, "a", {}); // queued behind the backpressured first write
    expect(res.written).toHaveLength(1);
    expect(handle.queuedFrameCount).toBe(1);

    res.simulateDrain();
    expect(res.written).toHaveLength(2);
    expect(handle.queuedFrameCount).toBe(0);
  });

  it("simulateNetworkDropForTests abruptly destroys every connection in scope WITHOUT writing a frame first (unlike closeAll's graceful message)", () => {
    const hub = new SseHub();
    const resInScope = new FakeResponse();
    const resOtherScope = new FakeResponse();
    hub.register({
      scopes: [STEP_03_TEST_SCOPE],
      initialVector: new Map(),
      res: resInScope as never,
      maxQueuedFrames: 10,
      retryMs: 1000,
    });
    hub.register({
      scopes: ["platform"],
      initialVector: new Map(),
      res: resOtherScope as never,
      maxQueuedFrames: 10,
      retryMs: 1000,
    });
    expect(hub.activeConnectionCount).toBe(2);

    hub.simulateNetworkDropForTests(STEP_03_TEST_SCOPE);

    expect(hub.activeConnectionCount).toBe(1); // only the in-scope connection was dropped
    expect(resInScope.written).toHaveLength(0); // no graceful frame, unlike closeAll
    expect(resInScope.ended).toBe(true); // socket genuinely destroyed
    expect(resOtherScope.ended).toBe(false); // the other scope's connection is untouched
  });

  it("simulateBackpressureOverflowForTests produces the same observable termination a real overflow would, scoped the same way as simulateNetworkDropForTests", () => {
    const hub = new SseHub();
    const resInScope = new FakeResponse();
    const resOtherScope = new FakeResponse();
    hub.register({
      scopes: [STEP_03_TEST_SCOPE],
      initialVector: new Map(),
      res: resInScope as never,
      maxQueuedFrames: 10,
      retryMs: 1000,
    });
    hub.register({
      scopes: ["platform"],
      initialVector: new Map(),
      res: resOtherScope as never,
      maxQueuedFrames: 10,
      retryMs: 1000,
    });
    expect(hub.activeConnectionCount).toBe(2);

    hub.simulateBackpressureOverflowForTests(STEP_03_TEST_SCOPE);

    expect(hub.activeConnectionCount).toBe(1); // only the in-scope connection was dropped
    expect(resInScope.written).toHaveLength(0); // abrupt, no graceful frame - same as a real overflow
    expect(resInScope.ended).toBe(true);
    expect(resOtherScope.ended).toBe(false);
  });

  it("close() removes the connection from future broadcasts and decrements activeConnectionCount", () => {
    const hub = new SseHub();
    const res = new FakeResponse();
    const handle = hub.register({
      scopes: [STEP_03_TEST_SCOPE],
      initialVector: new Map(),
      res: res as never,
      maxQueuedFrames: 10,
      retryMs: 1000,
    });
    expect(hub.activeConnectionCount).toBe(1);

    handle.close("test");
    expect(hub.activeConnectionCount).toBe(0);

    hub.broadcast(STEP_03_TEST_SCOPE, 1, 1, "a", {});
    expect(res.written).toHaveLength(0);
  });

  it("sendControl (resync_required) never carries an id and never advances the vector", () => {
    const hub = new SseHub();
    const res = new FakeResponse();
    const handle = hub.register({
      scopes: [STEP_03_TEST_SCOPE],
      initialVector: new Map(),
      res: res as never,
      maxQueuedFrames: 10,
      retryMs: 1000,
    });

    handle.sendEvent(1, 5, "a", {});
    handle.sendControl("resync_required", { scope: STEP_03_TEST_SCOPE, reason: "REPLAY_GAP" });
    handle.sendEvent(1, 6, "a", {});

    expect(res.written[1]).not.toMatch(/^id:/m);
    expect(res.written[2]).toContain("id: 1:6"); // vector unaffected by the control frame
  });

  it("closeAll() ends every response and clears the registry", () => {
    const hub = new SseHub();
    const res1 = new FakeResponse();
    const res2 = new FakeResponse();
    hub.register({
      scopes: [STEP_03_TEST_SCOPE],
      initialVector: new Map(),
      res: res1 as never,
      maxQueuedFrames: 10,
      retryMs: 1000,
    });
    hub.register({
      scopes: [STEP_03_TEST_SCOPE],
      initialVector: new Map(),
      res: res2 as never,
      maxQueuedFrames: 10,
      retryMs: 1000,
    });

    hub.closeAll("shutting down");

    expect(res1.ended).toBe(true);
    expect(res2.ended).toBe(true);
    expect(hub.activeConnectionCount).toBe(0);
  });
});
