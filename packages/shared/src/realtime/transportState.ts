// Realtime client transport state machine (03_realtime_infrastructure.md
// §ÉTAT ATTENDU APRÈS: "TanStack Query's global config disables
// `refetchInterval` while SSE is healthy and enables it automatically per
// the trigger conditions in `26_REALTIME_SSE_AND_SYNC.md` (readyState check,
// `navigator.onLine`, timeout-based SSE-never-opened detection)"; mission
// §20: "Implement explicit, testable transport states from the
// architecture. ... Conceptual behavior will likely include equivalents of
// CONNECTING, LIVE, DEGRADED/GRACE, POLLING, RECONNECTING but DO NOT invent
// enum names if the architecture already defines them.")
//
// The architecture docs (26_REALTIME_SSE_AND_SYNC.md, ADR-005) describe the
// required BEHAVIOR precisely (10s grace before fallback, native EventSource
// reconnect ownership, offline/online-driven immediate reconnect) but never
// fix a literal enum name for the states themselves - these five names are
// this implementation's own choice, made explicit here (not silently) per
// 00_GLOBAL_IMPLEMENTATION_RULES.md #1, and documented as such in the Step-03
// HANDOVER's "Deviations" section.
//
// This module is a PURE reducer: no timers, no EventSource, no DOM. The
// provider (apps/web/src/realtime/SseProvider.tsx) is the only place that
// schedules the grace timer and drives OPEN/MESSAGE/ERROR from the real
// EventSource - keeping the state machine itself trivially unit-testable
// with fake clocks (mission §21/§34).

export type RealtimeTransportState = "CONNECTING" | "LIVE" | "GRACE" | "POLLING" | "RECONNECTING";

export type RealtimeTransportAction =
  /** EventSource `onopen` fired, or a real frame proves the stream is alive. */
  | { type: "OPEN" }
  /** A real (non-heartbeat) message was received - reaffirms LIVE. */
  | { type: "MESSAGE" }
  /** EventSource `onerror` fired, or the stream was explicitly closed. */
  | { type: "ERROR" }
  /** The GRACE timer (SSE_UNHEALTHY_GRACE_MS) elapsed without recovery. */
  | { type: "GRACE_TIMEOUT" }
  /** `navigator.onLine` flipped false. */
  | { type: "OFFLINE" }
  /** `navigator.onLine` flipped true, or `visibilitychange` foreground. */
  | { type: "ONLINE" };

export function initialTransportState(): RealtimeTransportState {
  return "CONNECTING";
}

/**
 * Deterministic, side-effect-free transition table. Every arm is listed
 * explicitly (no wildcard fallthrough) so a missing case is a compile error
 * (TypeScript's exhaustiveness check on the switch below), not a silent
 * no-op that could hide a real bug (mission §34's "no duplicate interval, no
 * timer leak" requirement depends on the reducer never returning a stale
 * unreachable state).
 */
export function nextTransportState(
  state: RealtimeTransportState,
  action: RealtimeTransportAction,
): RealtimeTransportState {
  switch (state) {
    case "CONNECTING":
      switch (action.type) {
        case "OPEN":
        case "MESSAGE":
          return "LIVE";
        case "ERROR":
          return "GRACE";
        case "OFFLINE":
          return "GRACE";
        case "ONLINE":
        case "GRACE_TIMEOUT":
          return state;
      }
      break;
    case "LIVE":
      switch (action.type) {
        case "OPEN":
        case "MESSAGE":
        case "ONLINE":
          return "LIVE";
        case "ERROR":
        case "OFFLINE":
          return "GRACE";
        case "GRACE_TIMEOUT":
          return state;
      }
      break;
    case "GRACE":
      switch (action.type) {
        case "OPEN":
        case "MESSAGE":
          return "LIVE";
        case "GRACE_TIMEOUT":
          return "POLLING";
        case "ONLINE":
          // 21_MOBILE_UX.md: online/foreground forces an immediate reconnect
          // attempt rather than waiting out the rest of the grace timer -
          // modeled as re-entering GRACE's own connecting attempt, not a new
          // state (the provider triggers `eventSource = new EventSource(...)`
          // as its side effect for this action; the state itself is
          // unaffected until that attempt resolves to OPEN or ERROR again).
          return "GRACE";
        case "ERROR":
        case "OFFLINE":
          return state;
      }
      break;
    case "POLLING":
      switch (action.type) {
        case "OPEN":
          // Tentative recovery - do not trust a single OPEN event to declare
          // LIVE again (mission §21: "no oscillation on a millisecond network
          // glitch"). RECONNECTING waits for one real received frame.
          return "RECONNECTING";
        case "ONLINE":
          return state;
        case "MESSAGE":
        case "ERROR":
        case "OFFLINE":
        case "GRACE_TIMEOUT":
          return state;
      }
      break;
    case "RECONNECTING":
      switch (action.type) {
        case "MESSAGE":
        case "OPEN":
          return "LIVE";
        case "ERROR":
        case "OFFLINE":
          return "POLLING";
        case "ONLINE":
        case "GRACE_TIMEOUT":
          return state;
      }
      break;
  }
  return state;
}

/** Whether TanStack Query's polling fallback should be active in this state. */
export function isPollingFallbackActive(state: RealtimeTransportState): boolean {
  return state === "POLLING" || state === "RECONNECTING";
}

/** Whether the state counts as "live" for UI purposes (no degraded banner). */
export function isRealtimeHealthy(state: RealtimeTransportState): boolean {
  return state === "LIVE";
}
