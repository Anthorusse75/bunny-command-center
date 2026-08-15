// The "fallback-aware query helper" future steps use instead of configuring
// `refetchInterval` themselves per screen (mission §23 REJECTION CRITERIA:
// "each future screen creates its own setInterval polling"; §56 lists this
// exact capability as part of the Step-06 consumer contract).
//
// 26_REALTIME_SSE_AND_SYNC.md §Polling fallback: refetchInterval is
// "disabled while a healthy SSE connection is active ... enabled
// automatically" once the transport degrades. This module wires that rule
// generically: `refetchInterval` is a FUNCTION reading the live transport
// state from realtimeStatusStore on every TanStack Query internal check,
// rather than a static value fixed once at query-creation time - the only
// way the fallback can turn on/off automatically as the connection recovers
// without every screen re-subscribing manually.
import type { UseQueryOptions } from "@tanstack/react-query";
import { isPollingFallbackActive } from "@bunny-command-center/shared";
import { getRealtimeTransportState } from "./realtimeStatusStore.js";

/** 26_REALTIME_SSE_AND_SYNC.md doesn't fix one universal fallback interval (it is per-screen, matching each legacy dashboard polling interval it replaces) - callers pass their own. This module owns only WHEN to poll, not HOW OFTEN for a specific query. */
export function realtimeAwareQueryOptions<T extends object>(
  options: T,
  fallbackIntervalMs: number,
): T & { refetchInterval: () => number | false } {
  return {
    ...options,
    refetchInterval: () =>
      isPollingFallbackActive(getRealtimeTransportState()) ? fallbackIntervalMs : false,
  };
}

export type { UseQueryOptions };
