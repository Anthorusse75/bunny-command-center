// A tiny module-level external store for the current realtime transport
// state, read via React's built-in `useSyncExternalStore` - deliberately NOT
// Zustand (ADR-003 pre-approves Zustand for "small pieces of local UI
// state", but mission §44's dependency discipline requires proving existing
// tools can't do it first: a single reactive value with a subscribe/
// getSnapshot pair is exactly what `useSyncExternalStore` exists for, so no
// new dependency is justified for this narrow need - noted in the Step-03
// HANDOVER's deviations).
//
// One singleton per browser tab (03_realtime_infrastructure.md: "Each
// browser tab opens its own SSE connection" - ADR-005/26_REALTIME_SSE_AND_SYNC.md
// §Multi-tab), which is exactly what a module-level singleton represents
// within one JS runtime/tab.
import { useSyncExternalStore } from "react";
import { initialTransportState, type RealtimeTransportState } from "@bunny-command-center/shared";

type Listener = () => void;

let state: RealtimeTransportState = initialTransportState();
const listeners = new Set<Listener>();

export function getRealtimeTransportState(): RealtimeTransportState {
  return state;
}

export function setRealtimeTransportState(next: RealtimeTransportState): void {
  if (next === state) {
    return;
  }
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeRealtimeTransportState(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test-only reset - the store is a module singleton, tests must not leak state across files/cases. */
export function resetRealtimeTransportStateForTests(): void {
  state = initialTransportState();
  listeners.clear();
}

export function useRealtimeTransportState(): RealtimeTransportState {
  return useSyncExternalStore(
    subscribeRealtimeTransportState,
    getRealtimeTransportState,
    getRealtimeTransportState,
  );
}
