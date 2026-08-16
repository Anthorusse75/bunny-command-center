// Framework-agnostic connection manager - owns the single EventSource for
// this tab and drives the shared transport reducer
// (packages/shared/src/realtime/transportState.ts). Kept separate from React
// so the state machine's timing-sensitive behavior (mission §21/§34: grace
// timers, repeated flap, cleanup/unmount) can be unit-tested with fake
// timers and an injected fake EventSource class, while SseProvider.tsx stays
// a thin React wrapper around this.
//
// ADR-005 layering (mission §25 - "read ADR-005 for which layer owns
// EventSource retries"): native `EventSource` owns ordinary transient
// reconnects (its own internal timer, honoring the server's `retry:` hint) -
// this manager NEVER recreates the EventSource just because `onerror` fired
// while `readyState === CONNECTING` (that would be a second, competing
// reconnect loop). This manager only creates a NEW EventSource in two cases,
// both explicit and documented: (1) the native instance reached the
// permanent `CLOSED` state (native retry has genuinely given up - the
// "recreation after fatal state" case ADR-005 assigns to this layer) with
// its own exponential backoff; (2) an explicit `online`/foreground event
// forces an immediate reconnect attempt rather than waiting out native
// timing (21_MOBILE_UX.md).
import {
  HEARTBEAT_EVENT_TYPE,
  RESYNC_REQUIRED_EVENT_TYPE,
  SSE_UNHEALTHY_GRACE_MS,
  initialTransportState,
  isPollingFallbackActive,
  nextTransportState,
  type RealtimeTransportAction,
  type RealtimeTransportState,
} from "@bunny-command-center/shared";

/** Minimal EventSource surface this manager depends on - lets tests inject a fake implementation without needing a real browser/jsdom EventSource. */
export interface EventSourceLike {
  readyState: number;
  onopen: ((ev: Event) => void) | null;
  onerror: ((ev: Event) => void) | null;
  addEventListener(type: string, handler: (ev: MessageEvent) => void): void;
  close(): void;
}

export interface EventSourceFactory {
  (url: string): EventSourceLike;
  readonly CONNECTING: number;
  readonly OPEN: number;
  readonly CLOSED: number;
}

/**
 * TEST-ONLY (mission §35/§39 - "test-only seams MUST NOT become production
 * backdoors"; correctness-review round 3, test-only bundle hygiene). Never
 * named class methods (see `SseConnectionManagerOptions.registerTestOnlyControls`'s
 * own doc comment for why), and never wired unless a caller EXPLICITLY
 * supplies the option - the ordinary production `SseProvider.tsx` only does
 * so inside a build-time-eliminable branch (`import.meta.env.VITE_ENABLE_REALTIME_TEST_PROBE`),
 * so an ordinary production build never even calls this constructor option.
 */
export interface SseTestOnlyControls {
  /** Closes the real EventSource and drives the real ERROR/grace/fatal-retry code paths - apps/web/e2e/realtime.spec.ts's Case-B ("D. RESUME") proof. */
  forceDisconnect: () => void;
  /**
   * Same as `forceDisconnect`, but first seeds `lastKnownEventId` with an
   * arbitrary value BEFORE triggering the reconnect - lets a real-browser
   * test establish the CURSOR_AHEAD precondition (a business-source cursor
   * this browser never actually received) through the SAME production
   * Case-B reconnect mechanism `forceDisconnect` uses, without needing to
   * insert an unrealistic number of real rows to reach that ordinal
   * naturally. Everything AFTER this seed - resync_required handling,
   * clearing the poisoned value, resuming live delivery - is the real,
   * unmodified product code path (apps/web/e2e/realtime.spec.ts's "F.
   * CURSOR_AHEAD" test never calls this a second time and never manipulates
   * `lastKnownEventId` directly itself).
   */
  forceDisconnectWithSeededCursor: (id: string) => void;
}

export interface SseConnectionManagerOptions {
  url: string;
  eventSourceFactory: EventSourceFactory;
  graceMs?: number;
  fatalRetryBaseMs?: number;
  fatalRetryMaxMs?: number;
  onStateChange?: (state: RealtimeTransportState) => void;
  /** Invoked for EVERY named event received (including heartbeat/resync_required) - the generic extension point `useRealtimeChannel` builds on. */
  onEvent?: (eventType: string, data: unknown, rawId: string | null) => void;
  /** Invoked specifically for `resync_required` - separate from `onEvent` because it typically drives a broader "invalidate everything in this scope" action, not a single mapped query key. */
  onResyncRequired?: (data: unknown) => void;
  /**
   * TEST-ONLY extension point (correctness-review round 3). If provided,
   * called ONCE, synchronously, from the constructor with a fresh
   * `SseTestOnlyControls` object built from anonymous closures over this
   * manager's private state - deliberately NOT exposed as named public
   * class methods, so an ordinary production `SseConnectionManager`
   * instance (which never receives this option - see `SseProvider.tsx`)
   * has no discoverable, callable test-only API surface at all, and the
   * literal strings `forceDisconnectForTests`/`simulateNetworkDropForTests`
   * never appear anywhere in this class. Never called in production - only
   * `SseProvider.tsx`'s own build-time-eliminable E2E branch supplies it.
   */
  registerTestOnlyControls?: (controls: SseTestOnlyControls) => void;
}

const FATAL_RETRY_BASE_MS_DEFAULT = 1000;
const FATAL_RETRY_MAX_MS_DEFAULT = 30_000;

export class SseConnectionManager {
  private state: RealtimeTransportState = initialTransportState();
  private es: EventSourceLike | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private fatalRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private fatalRetryDelayMs: number;
  private destroyed = false;
  private extraEventTypes = new Set<string>();
  /**
   * Native `EventSource` has no API to set custom request headers, so a
   * BROWSER-NATIVE reconnect (same object, after its own internal retry)
   * sends `Last-Event-ID` correctly on its own, but a reconnect THIS LAYER
   * initiates by constructing a genuinely NEW `EventSource` object (fatal
   * retry, forced online/foreground reconnect) cannot set that header at
   * all. Tracked here and appended as a `lastEventId` QUERY parameter
   * instead (apps/api/src/sse/route.ts accepts either) - the standard,
   * well-established workaround for this exact EventSource limitation.
   */
  private lastKnownEventId: string | null = null;
  private readonly graceMs: number;
  private readonly fatalRetryBaseMs: number;
  private readonly fatalRetryMaxMs: number;

  constructor(private readonly opts: SseConnectionManagerOptions) {
    this.graceMs = opts.graceMs ?? SSE_UNHEALTHY_GRACE_MS;
    this.fatalRetryBaseMs = opts.fatalRetryBaseMs ?? FATAL_RETRY_BASE_MS_DEFAULT;
    this.fatalRetryMaxMs = opts.fatalRetryMaxMs ?? FATAL_RETRY_MAX_MS_DEFAULT;
    this.fatalRetryDelayMs = this.fatalRetryBaseMs;
    this.connect();
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.handleOnline);
      window.addEventListener("offline", this.handleOffline);
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.handleVisibilityChange);
    }
    // TEST-ONLY (mission §35/§37, correctness-review round 3): simulates a
    // genuine real network drop of an already-OPEN connection. Exists
    // because real browser automation tools (Playwright/CDP's
    // `context.setOffline()`) were found, empirically, to flip
    // `navigator.onLine` correctly but NOT to actually terminate an
    // already-established long-lived HTTP/1.1 streaming socket - heartbeats
    // kept flowing straight through the "offline" emulation, a real
    // limitation of that automation layer, not a fact about production
    // networks. These closures drive the exact same production code paths a
    // genuine drop would (`ERROR` dispatch, the real grace timer, the real
    // fatal-retry reconnect) - they do not fabricate a state transition,
    // they trigger the real ones. Deliberately anonymous (never named class
    // methods - see `SseConnectionManagerOptions.registerTestOnlyControls`'s
    // own doc comment).
    //
    // The `import.meta.env.VITE_ENABLE_REALTIME_TEST_PROBE === "true"` guard
    // here is NOT redundant with the caller-side optionality of
    // `opts.registerTestOnlyControls` (correctness-review round 3, "do not
    // merely rename the symbol"): without it, THIS constructor body would
    // unconditionally compile the `{ forceDisconnect, forceDisconnectWithSeededCursor }`
    // object literal into `sseConnectionManager.ts` itself regardless of
    // what any CALLER passes - `SseConnectionManager` is a core, always-
    // shipped production class, so an `?.()` optional call alone cannot make
    // Vite/Terser dead-code-eliminate the object literal's own key strings
    // (confirmed the hard way: this is exactly what leaked
    // `forceDisconnectForTests` into the real production bundle in the
    // FIRST place, and initially reappeared here as
    // `forceDisconnectWithSeededCursor`/`registerTestOnlyControls` before
    // this guard was added - verified via the real built
    // dist/assets/*.js, not assumed). Dot-notation access is required for
    // the same reason `SseProvider.tsx`/`RealtimeTestProbe.tsx` document.
    if (import.meta.env.VITE_ENABLE_REALTIME_TEST_PROBE === "true") {
      this.opts.registerTestOnlyControls?.({
        forceDisconnect: () => {
          this.es?.close();
          this.dispatch({ type: "ERROR" });
          this.scheduleFatalRetry();
        },
        forceDisconnectWithSeededCursor: (id: string) => {
          this.lastKnownEventId = id;
          this.es?.close();
          this.dispatch({ type: "ERROR" });
          this.scheduleFatalRetry();
        },
      });
    }
  }

  getState(): RealtimeTransportState {
    return this.state;
  }

  isPollingFallbackActive(): boolean {
    return isPollingFallbackActive(this.state);
  }

  /** Extension point: `useRealtimeChannel` registers here so a future feature's own event type gets a native listener attached (mission §56/§54's "extension point future steps use to add a new channel/event type"). */
  ensureEventTypeSubscribed(eventType: string): void {
    if (this.extraEventTypes.has(eventType)) {
      return;
    }
    this.extraEventTypes.add(eventType);
    if (this.es) {
      this.attachListenerForType(this.es, eventType);
    }
  }

  private buildConnectUrl(): string {
    if (!this.lastKnownEventId) {
      return this.opts.url;
    }
    const separator = this.opts.url.includes("?") ? "&" : "?";
    return `${this.opts.url}${separator}lastEventId=${encodeURIComponent(this.lastKnownEventId)}`;
  }

  private connect(): void {
    if (this.destroyed) {
      return;
    }
    const es = this.opts.eventSourceFactory(this.buildConnectUrl());
    this.es = es;

    es.onopen = () => this.dispatch({ type: "OPEN" });
    es.onerror = () => {
      if (es.readyState === this.opts.eventSourceFactory.CLOSED) {
        this.dispatch({ type: "ERROR" });
        this.scheduleFatalRetry();
      } else {
        // CONNECTING: native EventSource is already retrying on its own timer - reflect the health signal, don't fight it.
        this.dispatch({ type: "ERROR" });
      }
    };

    this.attachListenerForType(es, HEARTBEAT_EVENT_TYPE);
    this.attachListenerForType(es, RESYNC_REQUIRED_EVENT_TYPE);
    for (const type of this.extraEventTypes) {
      this.attachListenerForType(es, type);
    }
  }

  private attachListenerForType(es: EventSourceLike, eventType: string): void {
    es.addEventListener(eventType, (ev) => this.handleNamedEvent(eventType, ev));
  }

  private handleNamedEvent(eventType: string, ev: MessageEvent): void {
    this.fatalRetryDelayMs = this.fatalRetryBaseMs; // any real frame proves the connection is genuinely healthy
    if (ev.lastEventId) {
      // Control frames (resync_required) never carry an id (hub.ts) and
      // therefore never overwrite a real position with nothing - a heartbeat
      // frame's own reserved-slot id is still a legitimate, safe position to
      // remember (its vector only ever advances the reserved heartbeat
      // slot, mission §14 - see packages/shared/src/realtime/envelope.ts).
      this.lastKnownEventId = ev.lastEventId;
    }
    this.dispatch({ type: "MESSAGE" });

    let data: unknown;
    try {
      data = ev.data !== undefined ? JSON.parse(ev.data as string) : undefined;
    } catch {
      // A malformed payload must never crash the client (mission §43) - just skip data-dependent handling for this one frame.
      return;
    }

    if (eventType === HEARTBEAT_EVENT_TYPE) {
      // Never invalidates anything, never reaches onEvent (mission §14/§22: "heartbeat -> no query invalidation").
      return;
    }
    if (eventType === RESYNC_REQUIRED_EVENT_TYPE) {
      // Correctness-review round 2 (CURSOR_AHEAD/resync recovery): whatever
      // this manager was remembering as its own resume position can no
      // longer be trusted once the server has explicitly said so - clear it
      // so that any FUTURE reconnect THIS LAYER itself initiates (case B -
      // `buildConnectUrl`, e.g. after a fatal retry) starts fresh rather than
      // resending a cursor the server has already rejected once. This does
      // NOT touch the current, still-open connection or force a reconnect:
      // the native browser reconnect (case A) tracks its OWN internal
      // last-event-id from real received frames on THIS EventSource object,
      // which can never include a rejected value either, because
      // apps/api/src/sse/route.ts's `replayOrResync` already resets the
      // connection's server-side vector for the affected source (via
      // `SseHub.resetSourceVector`) BEFORE this frame - or any frame after
      // it - is ever sent. So the current connection self-heals without any
      // client action, and this line only prevents a STALE app-level memory
      // from re-poisoning a later, separate reconnect.
      this.lastKnownEventId = null;
      this.opts.onResyncRequired?.(data);
      return;
    }
    this.opts.onEvent?.(eventType, data, ev.lastEventId ?? null);
  }

  private scheduleFatalRetry(): void {
    if (this.fatalRetryTimer || this.destroyed) {
      return;
    }
    this.fatalRetryTimer = setTimeout(() => {
      this.fatalRetryTimer = null;
      this.fatalRetryDelayMs = Math.min(this.fatalRetryDelayMs * 2, this.fatalRetryMaxMs);
      this.es?.close();
      this.connect();
    }, this.fatalRetryDelayMs);
  }

  private handleOnline = (): void => {
    this.dispatch({ type: "ONLINE" });
    this.forceReconnectIfNeeded();
  };

  private handleOffline = (): void => {
    this.dispatch({ type: "OFFLINE" });
  };

  private handleVisibilityChange = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      this.dispatch({ type: "ONLINE" });
      this.forceReconnectIfNeeded();
    }
  };

  private forceReconnectIfNeeded(): void {
    if (this.state === "LIVE" || this.destroyed) {
      return;
    }
    if (this.fatalRetryTimer) {
      clearTimeout(this.fatalRetryTimer);
      this.fatalRetryTimer = null;
    }
    this.fatalRetryDelayMs = this.fatalRetryBaseMs;
    this.es?.close();
    this.connect();
  }

  private dispatch(action: RealtimeTransportAction): void {
    const prev = this.state;
    const next = nextTransportState(prev, action);
    if (next === prev) {
      return;
    }
    if (prev !== "GRACE" && next === "GRACE") {
      this.startGraceTimer();
    }
    if (prev === "GRACE" && next !== "GRACE") {
      this.clearGraceTimer();
    }
    this.state = next;
    this.opts.onStateChange?.(next);
  }

  private startGraceTimer(): void {
    this.clearGraceTimer();
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      this.dispatch({ type: "GRACE_TIMEOUT" });
    }, this.graceMs);
  }

  private clearGraceTimer(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  /** Cleanup: no leaked timers, listeners, or open connections (mission §15/§50). */
  destroy(): void {
    this.destroyed = true;
    this.clearGraceTimer();
    if (this.fatalRetryTimer) {
      clearTimeout(this.fatalRetryTimer);
      this.fatalRetryTimer = null;
    }
    this.es?.close();
    this.es = null;
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.handleOnline);
      window.removeEventListener("offline", this.handleOffline);
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    }
  }
}
