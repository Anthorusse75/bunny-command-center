// The Step-06 consumer contract (03_realtime_infrastructure.md,
// 00_GLOBAL_IMPLEMENTATION_RULES.md's "extension point future steps use"
// requirement): `<SseProvider>`, `useRealtimeChannel(eventType, handler)`,
// `useRealtimeStatus()`. Composes with the existing provider tree
// (apps/web/src/app/App.tsx) rather than replacing it - owns nothing about
// theme, i18n, or the shell.
import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  RESYNC_REQUIRED_EVENT_TYPE,
  isPollingFallbackActive,
  isRealtimeHealthy,
  type RealtimeTransportState,
} from "@bunny-command-center/shared";
import {
  SseConnectionManager,
  type EventSourceFactory,
  type SseTestOnlyControls,
} from "./sseConnectionManager.js";
import { applyQueryInvalidation } from "./invalidationRegistry.js";
import { dispatchChannelEvent, subscribeChannelEvent } from "./channelEventBus.js";
import { setRealtimeTransportState, useRealtimeTransportState } from "./realtimeStatusStore.js";
import { OfflineBanner } from "./OfflineBanner.js";

interface RealtimeContextValue {
  ensureEventTypeSubscribed: (eventType: string) => void;
  /**
   * TEST-ONLY, and genuinely OPTIONAL in the type (correctness-review round
   * 3, test-only bundle hygiene) - only ever populated inside the
   * build-time-eliminable `import.meta.env.VITE_ENABLE_REALTIME_TEST_PROBE`
   * branch below, the SAME flag `realtimeTestProbeEnabled()`
   * (RealtimeTestProbe.tsx) already gates on, so an ordinary production
   * build's `SseProvider` never constructs these fields at all - unlike the
   * previous design, where this context value UNCONDITIONALLY built a
   * `forceDisconnectForTests` closure regardless of whether anything ever
   * consumed it, which is why the string survived tree-shaking despite
   * `RealtimeTestProbe` itself being correctly eliminated.
   */
  testOnlyControls?: SseTestOnlyControls;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

/**
 * Wraps the real, native `window.EventSource` CLASS (a constructor - `new
 * EventSource(url)`) as a plain factory FUNCTION matching
 * `EventSourceFactory`'s shape, so `SseConnectionManager` (and its tests,
 * which inject their own fake factory the same way) never needs to know
 * whether the underlying implementation is a class or a function.
 */
function createBrowserEventSourceFactory(): EventSourceFactory {
  const factory = (url: string) => new window.EventSource(url);
  return Object.assign(factory, {
    CONNECTING: window.EventSource.CONNECTING,
    OPEN: window.EventSource.OPEN,
    CLOSED: window.EventSource.CLOSED,
  });
}

export interface SseProviderProps {
  children?: React.ReactNode;
  /** Override for tests - defaults to the real `/api/stream` route. */
  streamUrl?: string;
  /** Override for tests - defaults to the browser's real `window.EventSource`. */
  eventSourceFactory?: EventSourceFactory;
}

/**
 * MUST be rendered inside a TanStack `QueryClientProvider` (it calls
 * `useQueryClient()` to drive the invalidation registry and the
 * `resync_required` full-refetch path).
 */
export function SseProvider({
  children,
  streamUrl = "/api/stream",
  eventSourceFactory,
}: SseProviderProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const managerRef = useRef<SseConnectionManager | null>(null);
  // React mounts a CHILD's effects before its PARENT's (e.g.
  // `useRealtimeChannel` called from a component under `<SseProvider>`
  // mounts before this provider's own `useEffect` below runs) - a child
  // calling `ensureEventTypeSubscribed` on its very first render would
  // otherwise silently no-op against a manager that doesn't exist yet and
  // never get attached. Queuing here and flushing once the manager is
  // actually constructed makes subscription order-independent. (Found via
  // the real-browser E2E suite: a synthetic test event never reached the
  // page even though the server-side broadcast and the connection's own
  // heartbeat/resync listeners worked correctly - proof this was a genuine
  // bug, not a hypothetical one.)
  const pendingEventTypesRef = useRef<Set<string>>(new Set());
  // Populated ONLY by the manager's own `registerTestOnlyControls` callback
  // below, which is itself only ever passed a non-undefined value inside the
  // build-time-eliminable branch (correctness-review round 3) - stays `null`
  // for the entire lifetime of an ordinary production render.
  const testOnlyControlsRef = useRef<SseTestOnlyControls | null>(null);

  useEffect(() => {
    const factory = eventSourceFactory ?? createBrowserEventSourceFactory();
    const manager = new SseConnectionManager({
      url: streamUrl,
      eventSourceFactory: factory,
      onStateChange: (state: RealtimeTransportState) => setRealtimeTransportState(state),
      onEvent: (eventType, data) => {
        applyQueryInvalidation(queryClient, eventType, data);
        dispatchChannelEvent(eventType, data);
      },
      // Dot-notation `import.meta.env.VITE_*` access is REQUIRED (not a
      // style preference) for Vite's static replacement to recognize and
      // eliminate this branch in an ordinary production build - the SAME
      // requirement `realtimeTestProbeEnabled()` (RealtimeTestProbe.tsx)
      // documents and a bracket form was already found NOT to satisfy
      // there. Only a real E2E build (playwright.config.ts's `webServer`,
      // which sets this exact env var) ever supplies a real callback here;
      // an ordinary build's `SseConnectionManager` therefore never even
      // RECEIVES `registerTestOnlyControls`, let alone calls it. The key is
      // OMITTED entirely (not set to `undefined`) outside this branch -
      // `exactOptionalPropertyTypes` requires that distinction.
      ...(import.meta.env.VITE_ENABLE_REALTIME_TEST_PROBE === "true"
        ? {
            registerTestOnlyControls: (controls: SseTestOnlyControls) => {
              testOnlyControlsRef.current = controls;
            },
          }
        : {}),
      onResyncRequired: (data) => {
        // Step 03 has no scope -> query-key mapping table yet (no real
        // feature queries exist) - the conservative, always-correct choice
        // is a full invalidation of everything currently cached
        // (26_REALTIME_SSE_AND_SYNC.md: "the client does a full data
        // refetch for the affected queries"). A later step that introduces
        // per-scope query keys can narrow this to
        // `invalidateQueries({ predicate: matchesScope(data.scope) })`
        // without changing this call site's shape.
        void queryClient.invalidateQueries();
        dispatchChannelEvent(RESYNC_REQUIRED_EVENT_TYPE, data);
      },
    });
    managerRef.current = manager;
    for (const eventType of pendingEventTypesRef.current) {
      manager.ensureEventTypeSubscribed(eventType);
    }
    pendingEventTypesRef.current.clear();
    setRealtimeTransportState(manager.getState());

    return () => {
      manager.destroy();
      managerRef.current = null;
    };
    // `eventSourceFactory` is intentionally excluded from the dependency
    // list: it is a stable test-only override (production callers never
    // pass it, so it is always `undefined` there), and re-running this
    // effect whenever a new inline object reference happened to be passed
    // would tear down/recreate the real connection pointlessly. (This
    // project's eslint config has no react-hooks/exhaustive-deps rule
    // configured, so no suppression directive is needed here.)
  }, [streamUrl, queryClient]);

  const value = useMemo<RealtimeContextValue>(
    () => ({
      ensureEventTypeSubscribed: (eventType: string) => {
        if (managerRef.current) {
          managerRef.current.ensureEventTypeSubscribed(eventType);
        } else {
          pendingEventTypesRef.current.add(eventType);
        }
      },
      // Same build-time-eliminable branch as the manager construction above
      // - an ordinary production build never reaches this object literal at
      // all, so `testOnlyControls` (and the two closures inside it) has no
      // presence in that bundle (correctness-review round 3).
      ...(import.meta.env.VITE_ENABLE_REALTIME_TEST_PROBE === "true"
        ? {
            testOnlyControls: {
              forceDisconnect: () => testOnlyControlsRef.current?.forceDisconnect(),
              forceDisconnectWithSeededCursor: (id: string) =>
                testOnlyControlsRef.current?.forceDisconnectWithSeededCursor(id),
            },
          }
        : {}),
    }),
    [],
  );

  return (
    <RealtimeContext.Provider value={value}>
      {children}
      <OfflineBanner />
    </RealtimeContext.Provider>
  );
}

function useRealtimeContext(): RealtimeContextValue {
  const value = useContext(RealtimeContext);
  if (!value) {
    throw new Error("useRealtimeChannel/useRealtimeStatus must be used inside <SseProvider>.");
  }
  return value;
}

/**
 * TEST-ONLY (mission §35) - consumed only by RealtimeTestProbe.tsx, itself
 * compiled out of real production builds by the SAME
 * `VITE_ENABLE_REALTIME_TEST_PROBE` flag `ctx.testOnlyControls` is gated on
 * above, so whenever this hook is genuinely CALLED at runtime the field is
 * guaranteed present - the thrown error below is a defensive invariant
 * check, not an expected production code path.
 */
export function useRealtimeTestControls(): SseTestOnlyControls {
  const ctx = useRealtimeContext();
  if (!ctx.testOnlyControls) {
    throw new Error(
      "useRealtimeTestControls called without VITE_ENABLE_REALTIME_TEST_PROBE set - this should be unreachable.",
    );
  }
  return ctx.testOnlyControls;
}

/**
 * STEP 06+ CONSUMER CONTRACT: subscribe to one SSE event type generically.
 * Automatically tells the connection manager to attach a native listener for
 * `eventType` (idempotent - safe to call from many components for the same
 * type) and re-registers across a reconnect automatically. Prefer
 * `registerQueryInvalidation` (invalidationRegistry.ts) for the common case
 * of "this event means refetch query X" - use this hook only when a
 * component needs the raw event data itself (e.g. driving a toast).
 */
export function useRealtimeChannel<TData = unknown>(eventType: string, handler: (data: TData) => void): void {
  const ctx = useRealtimeContext();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    ctx.ensureEventTypeSubscribed(eventType);
    return subscribeChannelEvent(eventType, (data) => handlerRef.current(data as TData));
  }, [ctx, eventType]);
}

export interface RealtimeStatus {
  state: RealtimeTransportState;
  isHealthy: boolean;
  isPollingFallbackActive: boolean;
}

/** STEP 06+ CONSUMER CONTRACT: read the current transport state reactively. */
export function useRealtimeStatus(): RealtimeStatus {
  const state = useRealtimeTransportState();
  return {
    state,
    isHealthy: isRealtimeHealthy(state),
    isPollingFallbackActive: isPollingFallbackActive(state),
  };
}
