// In-process SSE counters (30_OBSERVABILITY_AND_AUDIT.md §Metrics: "SSE
// connection count" is explicitly listed among the /metrics fields Step 21
// formalizes; 03_realtime_infrastructure.md §OBSERVABILITY: "Log SSE
// connection count, reconnect rate, fallback-activation rate ... the
// counters should exist from here"). No public HTTP /metrics route yet -
// that endpoint is Step 21's (30_OBSERVABILITY_AND_AUDIT.md: "Not built as
// new infrastructure in this mission ... decided in the relevant
// IMPLEMENTATION step"). `getSseMetricsSnapshot` exists so a future step (or
// a test) can read the current counters without needing that route yet.
export interface SseMetrics {
  connectionsOpenedTotal: number;
  connectionsClosedTotal: number;
  connectionsActive: number;
  reconnectsWithLastEventIdTotal: number;
  eventsReplayedTotal: number;
  replayGapsTotal: number;
  resyncsSentTotal: number;
  framesDroppedForBackpressureTotal: number;
  pollTicksTotal: number;
  pollErrorsTotal: number;
}

function empty(): SseMetrics {
  return {
    connectionsOpenedTotal: 0,
    connectionsClosedTotal: 0,
    connectionsActive: 0,
    reconnectsWithLastEventIdTotal: 0,
    eventsReplayedTotal: 0,
    replayGapsTotal: 0,
    resyncsSentTotal: 0,
    framesDroppedForBackpressureTotal: 0,
    pollTicksTotal: 0,
    pollErrorsTotal: 0,
  };
}

let metrics: SseMetrics = empty();

export function getSseMetricsSnapshot(): SseMetrics {
  return { ...metrics };
}

export function resetSseMetricsForTests(): void {
  metrics = empty();
}

export const sseMetrics = {
  connectionOpened(): void {
    metrics.connectionsOpenedTotal += 1;
    metrics.connectionsActive += 1;
  },
  connectionClosed(): void {
    metrics.connectionsClosedTotal += 1;
    metrics.connectionsActive = Math.max(0, metrics.connectionsActive - 1);
  },
  reconnectWithLastEventId(): void {
    metrics.reconnectsWithLastEventIdTotal += 1;
  },
  eventsReplayed(count: number): void {
    metrics.eventsReplayedTotal += count;
  },
  replayGap(): void {
    metrics.replayGapsTotal += 1;
  },
  resyncSent(): void {
    metrics.resyncsSentTotal += 1;
  },
  frameDroppedForBackpressure(): void {
    metrics.framesDroppedForBackpressureTotal += 1;
  },
  pollTick(): void {
    metrics.pollTicksTotal += 1;
  },
  pollError(): void {
    metrics.pollErrorsTotal += 1;
  },
};
