import { HEARTBEAT_EVENT_TYPE, type HeartbeatData } from "@bunny-command-center/shared";
import type { SseConnectionHandle, SseHub } from "./hub.js";
import { HEARTBEAT_SOURCE_INDEX } from "./types.js";

const HEARTBEAT_DATA: HeartbeatData = {};

/**
 * 26_REALTIME_SSE_AND_SYNC.md: "`heartbeat` fires every 15s to keep
 * intermediary proxies from timing out the connection ... and doubles as a
 * client-side liveness signal." Mission §14: heartbeats "must NOT advance a
 * business cursor ... invalidate every TanStack Query ... spam application
 * logs". Heartbeats use the reserved `HEARTBEAT_SOURCE_INDEX` (0) slot of the
 * connection's id vector, which is never written by `dashboard_sse_cursor`
 * and never causes a client-side query invalidation (apps/web's
 * invalidation registry has no mapping for the `heartbeat` event type at
 * all) - so this satisfies the "must not advance a business cursor" rule by
 * construction, not by a special case.
 */
export function startHeartbeat(
  hub: SseHub,
  handle: SseConnectionHandle,
  intervalSeconds: number,
): () => void {
  const timer = setInterval(() => {
    const ordinal = hub.nextHeartbeatOrdinal(handle.connectionId);
    handle.sendEvent(HEARTBEAT_SOURCE_INDEX, ordinal, HEARTBEAT_EVENT_TYPE, HEARTBEAT_DATA);
  }, intervalSeconds * 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}
