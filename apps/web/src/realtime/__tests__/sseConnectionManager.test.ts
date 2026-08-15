/**
 * Deterministic fake-timer proof of the client transport state machine
 * (mission §21/§34): connect success, initial connection failure, transient
 * disconnect, disconnect beyond grace -> fallback, reconnect -> fallback
 * stops, repeated reconnect/flap -> no duplicate timers, cleanup/unmount,
 * online/offline. Uses an injected FAKE `EventSource` (this file's own
 * concern is the STATE MACHINE, not real HTTP streaming - that proof is
 * apps/api's sse-stream.test.ts and the Playwright E2E suite).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SSE_UNHEALTHY_GRACE_MS } from "@bunny-command-center/shared";
import {
  SseConnectionManager,
  type EventSourceFactory,
  type EventSourceLike,
} from "../sseConnectionManager.js";

class FakeEventSource implements EventSourceLike {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  private listeners = new Map<string, Set<(ev: MessageEvent) => void>>();
  closed = false;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (ev: MessageEvent) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(handler);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  // --- test helpers, not part of EventSourceLike ---
  simulateOpen(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.(new Event("open"));
  }

  /** transient error - browser keeps retrying natively (readyState stays CONNECTING) */
  simulateTransientError(): void {
    this.readyState = FakeEventSource.CONNECTING;
    this.onerror?.(new Event("error"));
  }

  /** fatal error - native retry has given up */
  simulateFatalError(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.(new Event("error"));
  }

  simulateEvent(type: string, data: unknown, lastEventId = "1:1"): void {
    const handlers = this.listeners.get(type);
    if (!handlers) return;
    const event = { data: JSON.stringify(data), lastEventId } as MessageEvent;
    for (const h of handlers) h(event);
  }

  hasListenerFor(type: string): boolean {
    return (this.listeners.get(type)?.size ?? 0) > 0;
  }
}

function fakeFactory(): EventSourceFactory {
  const factory = (url: string) => new FakeEventSource(url);
  Object.defineProperty(factory, "CONNECTING", { value: FakeEventSource.CONNECTING });
  Object.defineProperty(factory, "OPEN", { value: FakeEventSource.OPEN });
  Object.defineProperty(factory, "CLOSED", { value: FakeEventSource.CLOSED });
  return factory as unknown as EventSourceFactory;
}

describe("SseConnectionManager (fake EventSource, fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("connect success: OPEN transitions CONNECTING -> LIVE", () => {
    const states: string[] = [];
    const manager = new SseConnectionManager({
      url: "/api/stream",
      eventSourceFactory: fakeFactory(),
      onStateChange: (s) => states.push(s),
    });
    expect(manager.getState()).toBe("CONNECTING");
    FakeEventSource.instances[0]!.simulateOpen();
    expect(manager.getState()).toBe("LIVE");
    expect(states).toEqual(["LIVE"]);
    manager.destroy();
  });

  it("initial connection failure: transient error keeps CONNECTING->GRACE without creating a second EventSource (native reconnect owns it)", () => {
    const manager = new SseConnectionManager({ url: "/api/stream", eventSourceFactory: fakeFactory() });
    FakeEventSource.instances[0]!.simulateTransientError();
    expect(manager.getState()).toBe("GRACE");
    expect(FakeEventSource.instances).toHaveLength(1); // no competing reconnect loop
    manager.destroy();
  });

  it("transient disconnect shorter than grace recovers to LIVE without ever reaching POLLING", () => {
    const manager = new SseConnectionManager({ url: "/api/stream", eventSourceFactory: fakeFactory() });
    const es = FakeEventSource.instances[0]!;
    es.simulateOpen();
    expect(manager.getState()).toBe("LIVE");

    es.simulateTransientError();
    expect(manager.getState()).toBe("GRACE");
    vi.advanceTimersByTime(SSE_UNHEALTHY_GRACE_MS - 1);
    es.simulateOpen(); // recovers just before grace expires
    expect(manager.getState()).toBe("LIVE");

    vi.advanceTimersByTime(SSE_UNHEALTHY_GRACE_MS * 2);
    expect(manager.getState()).toBe("LIVE"); // grace timer was cleared, never fires late
    manager.destroy();
  });

  it("disconnect beyond grace activates fallback (POLLING)", () => {
    const manager = new SseConnectionManager({ url: "/api/stream", eventSourceFactory: fakeFactory() });
    const es = FakeEventSource.instances[0]!;
    es.simulateOpen();
    es.simulateTransientError();
    expect(manager.getState()).toBe("GRACE");
    expect(manager.isPollingFallbackActive()).toBe(false);

    vi.advanceTimersByTime(SSE_UNHEALTHY_GRACE_MS);
    expect(manager.getState()).toBe("POLLING");
    expect(manager.isPollingFallbackActive()).toBe(true);
    manager.destroy();
  });

  it("reconnect after fallback: OPEN then a real MESSAGE confirms recovery and stops fallback; a bare OPEN alone does not", () => {
    const manager = new SseConnectionManager({ url: "/api/stream", eventSourceFactory: fakeFactory() });
    const es = FakeEventSource.instances[0]!;
    es.simulateOpen();
    es.simulateTransientError();
    vi.advanceTimersByTime(SSE_UNHEALTHY_GRACE_MS);
    expect(manager.getState()).toBe("POLLING");

    es.simulateOpen();
    expect(manager.getState()).toBe("RECONNECTING"); // tentative - not yet trusted
    expect(manager.isPollingFallbackActive()).toBe(true); // still polling until confirmed

    es.simulateEvent("heartbeat", {});
    expect(manager.getState()).toBe("LIVE");
    expect(manager.isPollingFallbackActive()).toBe(false);
    manager.destroy();
  });

  it("repeated flap (reconnect/disconnect cycles) never leaks a duplicate grace timer", () => {
    const manager = new SseConnectionManager({ url: "/api/stream", eventSourceFactory: fakeFactory() });
    const es = FakeEventSource.instances[0]!;
    es.simulateOpen();

    for (let i = 0; i < 10; i++) {
      es.simulateTransientError();
      es.simulateOpen();
    }
    expect(manager.getState()).toBe("LIVE");

    // If a duplicate grace timer had leaked from an earlier flap, this
    // advance would spuriously flip the state to POLLING even though we're
    // currently LIVE and never re-entered GRACE.
    vi.advanceTimersByTime(SSE_UNHEALTHY_GRACE_MS * 3);
    expect(manager.getState()).toBe("LIVE");
    manager.destroy();
  });

  it("fatal state (native retry exhausted) triggers this layer's own reconnect with exponential backoff", () => {
    const manager = new SseConnectionManager({
      url: "/api/stream",
      eventSourceFactory: fakeFactory(),
      fatalRetryBaseMs: 1000,
      fatalRetryMaxMs: 8000,
    });
    FakeEventSource.instances[0]!.simulateFatalError();
    expect(FakeEventSource.instances).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2); // first retry

    FakeEventSource.instances[1]!.simulateFatalError();
    vi.advanceTimersByTime(1999);
    expect(FakeEventSource.instances).toHaveLength(2); // not yet - backoff doubled to 2000ms
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(3);
    manager.destroy();
  });

  it("online event forces an immediate reconnect while degraded, without waiting for the grace timer", () => {
    const manager = new SseConnectionManager({ url: "/api/stream", eventSourceFactory: fakeFactory() });
    FakeEventSource.instances[0]!.simulateOpen();
    FakeEventSource.instances[0]!.simulateTransientError();
    expect(manager.getState()).toBe("GRACE");
    expect(FakeEventSource.instances).toHaveLength(1);

    window.dispatchEvent(new Event("online"));
    // Forced reconnect closes the old EventSource and opens a new one immediately.
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    manager.destroy();
  });

  it("offline event transitions LIVE -> GRACE", () => {
    const manager = new SseConnectionManager({ url: "/api/stream", eventSourceFactory: fakeFactory() });
    FakeEventSource.instances[0]!.simulateOpen();
    expect(manager.getState()).toBe("LIVE");

    window.dispatchEvent(new Event("offline"));
    expect(manager.getState()).toBe("GRACE");
    manager.destroy();
  });

  it("cleanup/unmount: destroy() clears timers and closes the connection, leaving no further callbacks", () => {
    const states: string[] = [];
    const manager = new SseConnectionManager({
      url: "/api/stream",
      eventSourceFactory: fakeFactory(),
      onStateChange: (s) => states.push(s),
    });
    const es = FakeEventSource.instances[0]!;
    es.simulateOpen();
    es.simulateTransientError(); // enters GRACE, starts a timer

    manager.destroy();
    expect(es.closed).toBe(true);
    states.length = 0;

    // Advancing time after destroy must not fire the (cleared) grace timer.
    vi.advanceTimersByTime(SSE_UNHEALTHY_GRACE_MS * 2);
    expect(states).toEqual([]);
  });

  it("heartbeat never invalidates and never reaches onEvent; a real event does", () => {
    const events: [string, unknown][] = [];
    const manager = new SseConnectionManager({
      url: "/api/stream",
      eventSourceFactory: fakeFactory(),
      onEvent: (type, data) => events.push([type, data]),
    });
    manager.ensureEventTypeSubscribed("dashboard.sse_test_probe_changed");
    const es = FakeEventSource.instances[0]!;
    es.simulateOpen();
    es.simulateEvent("heartbeat", {});
    expect(events).toEqual([]);

    es.simulateEvent("dashboard.sse_test_probe_changed", { label: "hi" });
    expect(events).toEqual([["dashboard.sse_test_probe_changed", { label: "hi" }]]);
    manager.destroy();
  });

  it("resync_required is routed to onResyncRequired, never onEvent, and confirms liveness", () => {
    const events: unknown[] = [];
    const resyncs: unknown[] = [];
    const manager = new SseConnectionManager({
      url: "/api/stream",
      eventSourceFactory: fakeFactory(),
      onEvent: (type, data) => events.push([type, data]),
      onResyncRequired: (data) => resyncs.push(data),
    });
    const es = FakeEventSource.instances[0]!;
    es.simulateOpen();
    es.simulateEvent("resync_required", { scope: "test", reason: "REPLAY_GAP" });
    expect(events).toEqual([]);
    expect(resyncs).toEqual([{ scope: "test", reason: "REPLAY_GAP" }]);
    manager.destroy();
  });

  it("ensureEventTypeSubscribed attaches a native listener, including after a reconnect creates a fresh EventSource", () => {
    const manager = new SseConnectionManager({ url: "/api/stream", eventSourceFactory: fakeFactory() });
    manager.ensureEventTypeSubscribed("dashboard.sse_test_probe_changed");
    expect(FakeEventSource.instances[0]!.hasListenerFor("dashboard.sse_test_probe_changed")).toBe(true);

    FakeEventSource.instances[0]!.simulateFatalError();
    vi.advanceTimersByTime(5000);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]!.hasListenerFor("dashboard.sse_test_probe_changed")).toBe(true);
    manager.destroy();
  });
});
