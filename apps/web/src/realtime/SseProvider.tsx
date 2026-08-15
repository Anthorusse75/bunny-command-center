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
import { SseConnectionManager, type EventSourceFactory } from "./sseConnectionManager.js";
import { applyQueryInvalidation } from "./invalidationRegistry.js";
import { dispatchChannelEvent, subscribeChannelEvent } from "./channelEventBus.js";
import { setRealtimeTransportState, useRealtimeTransportState } from "./realtimeStatusStore.js";
import { OfflineBanner } from "./OfflineBanner.js";

interface RealtimeContextValue {
  ensureEventTypeSubscribed: (eventType: string) => void;
  /** TEST-ONLY - see `SseConnectionManager.forceDisconnectForTests`'s own doc comment. */
  forceDisconnectForTests: () => void;
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
      forceDisconnectForTests: () => {
        managerRef.current?.forceDisconnectForTests();
      },
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

/** TEST-ONLY (mission §35) - consumed only by RealtimeTestProbe.tsx, itself compiled out of real production builds. */
export function useRealtimeTestControls(): { forceDisconnect: () => void } {
  const ctx = useRealtimeContext();
  return { forceDisconnect: ctx.forceDisconnectForTests };
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
