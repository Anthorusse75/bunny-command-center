// Single shared QueryClient (ADR-003: "TanStack Query for server state").
// Defaults are conservative and generic on purpose - Step 03 owns
// introducing TanStack Query, not any real query. Later steps' `useQuery`
// calls opt into realtime-aware polling via `useRealtimeAwareQueryOptions`
// (./realtimeAwareQuery.ts), never by configuring `refetchInterval` ad hoc
// per screen (mission §23: "Polling must be controlled centrally/by
// reusable query configuration").
import { QueryClient } from "@tanstack/react-query";

export function createBccQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // SSE keeps data fresh while healthy - a query is never considered
        // "stale" purely by clock time the way a plain polling app would
        // configure it; explicit invalidation (via the SSE mapping or a
        // mutation) is what marks it stale.
        staleTime: Infinity,
        // TanStack's own focus-refetch is disabled - SseProvider's
        // `visibilitychange` listener (21_MOBILE_UX.md §Offline/reconnect/
        // background) already forces an SSE reconnect + resync on
        // foreground, which is what actually drives freshness; enabling
        // both would double-refetch on every tab switch.
        refetchOnWindowFocus: false,
        retry: 2,
      },
    },
  });
}
