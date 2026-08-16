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
    hub.register({
      scopes: [STEP_03_TEST_SCOPE],
      initialVector: new Map(),
      res: resA as never,
      maxQueuedFrames: 10,
      retryMs: 1000,
    });
    hub.register({
      scopes: ["platform"],
      initialVector: new Map(),
      res: resB as never,
      maxQueuedFrames: 10,
      retryMs: 1000,
    });

    hub.broadcast(STEP_03_TEST_SCOPE, 1, 5, "dashboard.sse_test_event", { n: 1 });

    expect(resA.written).toHaveLength(1);
    expect(resA.written[0]).toContain("event: dashboard.sse_test_event");
    expect(resA.written[0]).toContain("id: 1:5");
    expect(resB.written).toHaveLength(0);
  });

  it("advances a connection's id vector across multiple sources without losing earlier positions", () => {
    const hub = new SseHub();
    const res = new FakeResponse();
    hub.register({
      scopes: [STEP_03_TEST_SCOPE],
      initialVector: new Map(),
      res: res as never,
      maxQueuedFrames: 10,
      retryMs: 1000,
    });

    hub.broadcast(STEP_03_TEST_SCOPE, 1, 5, "a", {});
    hub.broadcast(STEP_03_TEST_SCOPE, 2, 9, "b", {});
    hub.broadcast(STEP_03_TEST_SCOPE, 1, 6, "a", {});

    expect(res.written[0]).toContain("id: 1:5");
    expect(res.written[1]).toContain("id: 1:5,2:9");
    expect(res.written[2]).toContain("id: 1:6,2:9");
  });

  it("bounds a slow client's outbound queue and drops the OLDEST frame once full (mission §16)", () => {
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
    // semantics - nothing is lost, the return value only flags backpressure
    // for what comes NEXT). Frames 2-5 queue behind it, and the bound (3)
    // means the oldest queued frame (n=2) is dropped once n=5 arrives.
    expect(res.written).toHaveLength(1);
    expect(handle.queuedFrameCount).toBe(3);

    res.simulateDrain();

    // n=1 (direct) + n=3,4,5 (survived the bound) = 4 total. n=2 was
    // dropped as oldest-first once the queue exceeded its bound.
    expect(res.written).toHaveLength(4);
    expect(res.written.join("")).not.toContain('"n":2');
    expect(res.written.join("")).toContain('"n":1');
    expect(res.written.join("")).toContain('"n":3');
    expect(res.written.join("")).toContain('"n":5');
    expect(handle.queuedFrameCount).toBe(0);
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
