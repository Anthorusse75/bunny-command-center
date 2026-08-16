// The "fallback-aware query helper" future steps use instead of configuring
// `refetchInterval` themselves per screen (mission §23 REJECTION CRITERIA:
// "each future screen creates its own setInterval polling"; §56 lists this
// exact capability as part of the Step-06 consumer contract).
//
// 26_REALTIME_SSE_AND_SYNC.md §Polling fallback: refetchInterval is
// "disabled while a healthy SSE connection is active ... enabled
// automatically" once the transport degrades. This module wires that rule
// generically.
//
// CORRECTNESS-REVIEW ROUND 4: the original implementation returned
// `refetchInterval: () => isPollingFallbackActive(getRealtimeTransportState()) ? ... : false`
// - a plain function reading the transport-state module singleton directly,
// never subscribing the CALLING COMPONENT to it. That function is only
// RE-EVALUATED by TanStack Query when the query's OWN internal state changes
// (a fetch settling, an explicit invalidation) or when the calling
// component re-renders with a freshly-constructed options object - neither
// of which happens merely because the external transport store changed.
// Once mounted while LIVE (`refetchInterval` → `false`, no timer
// scheduled), a later transition to POLLING would never be noticed on its
// own; the previous `apps/web/src/realtime/RealtimeTestProbe.tsx` masked
// this because it ALSO called `useRealtimeStatus()` in the SAME component,
// whose OWN `useSyncExternalStore` subscription incidentally re-rendered
// the whole component (and therefore re-evaluated `refetchInterval`) on
// every transport change - a coincidence a future screen calling only this
// helper could not rely on. `apps/web/src/realtime/__tests__/realtimeAwareQuery.test.tsx`
// proves this failure mode against the original implementation directly
// (a genuinely isolated consumer, no `useRealtimeStatus()` anywhere in its
// tree) before this fix, and proves the fix afterward.
//
// The fix: a REACT HOOK that calls `useRealtimeTransportState()`
// (realtimeStatusStore.ts's own `useSyncExternalStore`-backed subscription)
// itself. The calling component doesn't need to know this subscription
// exists - it only needs to call this hook, exactly like it already calls
// `useQuery` - so no future screen needs a second, separate
// `useRealtimeStatus()` call merely to make its own polling fallback work.
// Because the component re-renders whenever the transport state changes,
// `refetchInterval` can now be a PLAIN VALUE (recomputed fresh every
// render) rather than a function TanStack Query has to remember to
// re-invoke - simpler, and correct by construction rather than by an
// incidental side effect of some other subscription.
import { useRealtimeTransportState } from "./realtimeStatusStore.js";
import { isPollingFallbackActive } from "@bunny-command-center/shared";

/** 26_REALTIME_SSE_AND_SYNC.md doesn't fix one universal fallback interval (it is per-screen, matching each legacy dashboard polling interval it replaces) - callers pass their own. This module owns only WHEN to poll, not HOW OFTEN for a specific query. Must be called unconditionally at a component's top level, like any other hook - it internally calls `useRealtimeTransportState()`. */
export function useRealtimeAwareQueryOptions<T extends object>(
  options: T,
  fallbackIntervalMs: number,
): T & { refetchInterval: number | false } {
  const transportState = useRealtimeTransportState();
  return {
    ...options,
    refetchInterval: isPollingFallbackActive(transportState) ? fallbackIntervalMs : false,
  };
}
