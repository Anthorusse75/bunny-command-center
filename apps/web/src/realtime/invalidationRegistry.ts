// The client-side half of "SSE event -> query-invalidation domain"
// (mission §22: "Create the architecture-defined mapping: SSE event ->
// invalidation domain/query key -> QueryClient invalidation. Keep the
// mapping extensible for later steps."). This is the ONE reusable place a
// future feature step registers "when event type X arrives, invalidate
// these query keys" - so no future screen has to manually parse EventSource
// messages itself (mission §22 rejection: "each future screen must
// implement its own EventSource").
//
// Deliberately empty of any feature-specific mapping as of Step 03
// (03_realtime_infrastructure.md REJECTION CRITERIA: "Any feature-specific
// event hardcoded into this generic layer") - `heartbeat` and
// `resync_required` are handled specially by SseProvider itself (never
// through this registry: heartbeat never invalidates anything by
// construction, mission §14; resync_required triggers a broader
// "invalidate everything under this scope" path, not a single mapped key).
import type { QueryClient } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";

export type InvalidationMapper<TData = unknown> = (data: TData) => QueryKey[];

const registry = new Map<string, InvalidationMapper>();

/**
 * STEP 06+ EXTENSION POINT. Example (future step, illustrative only - not
 * wired in Step 03): `registerQueryInvalidation('capture.state_changed',
 * (data) => [['guild', data.guildId, 'uploadItems']])`.
 */
export function registerQueryInvalidation<TData = unknown>(
  eventType: string,
  mapper: InvalidationMapper<TData>,
): void {
  registry.set(eventType, mapper as InvalidationMapper);
}

export function unregisterQueryInvalidation(eventType: string): void {
  registry.delete(eventType);
}

/** Test-only reset - module-level singleton registry. */
export function resetInvalidationRegistryForTests(): void {
  registry.clear();
}

/**
 * Applies the registered mapping for one received event, if any. Returns the
 * list of query keys invalidated (empty if the event type has no mapping -
 * an unmapped event is a deliberate no-op, never an error: many event types
 * exist purely for `useRealtimeChannel`-style direct consumption rather than
 * automatic invalidation).
 */
export function applyQueryInvalidation(
  queryClient: QueryClient,
  eventType: string,
  data: unknown,
): QueryKey[] {
  const mapper = registry.get(eventType);
  if (!mapper) {
    return [];
  }
  const keys = mapper(data);
  for (const key of keys) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
  return keys;
}
