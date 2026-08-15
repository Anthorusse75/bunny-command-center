// SSE wire-format constants and the two GENERIC (non-feature) event types
// Step 03 owns: `heartbeat` and `resync_required`
// (DASHBOARD/26_REALTIME_SSE_AND_SYNC.md §Event schema, §Reconnection and
// resume). Every other event type from that doc's example (capture state
// changes, upload progress, and so on) is registered by its owning later
// step through apps/api/src/sse/registry.ts's `registerEventType` - this
// file must never gain a feature-specific entry (03_realtime_infrastructure.md
// REJECTION CRITERIA: "Any feature-specific event hardcoded into this
// generic layer").
import { z } from "zod";

/** `event: heartbeat` / `data: {}` - 26_REALTIME_SSE_AND_SYNC.md's literal example. */
export const HEARTBEAT_EVENT_TYPE = "heartbeat" as const;
export const heartbeatDataSchema = z.object({}).strict();
export type HeartbeatData = z.infer<typeof heartbeatDataSchema>;

/**
 * Sent instead of a long replay when the client's Last-Event-ID is older
 * than the source's retained history ("If the gap exceeds a retention
 * window ... the server sends a `resync_required` event instead of a long
 * replay, and the client does a full data refetch"). `scope` names the
 * channel scope affected so a client subscribed to multiple scopes only
 * invalidates the affected one.
 */
export const RESYNC_REQUIRED_EVENT_TYPE = "resync_required" as const;
export const resyncRequiredDataSchema = z
  .object({
    scope: z.string().min(1),
    reason: z.enum(["REPLAY_GAP", "INVALID_CURSOR"]),
  })
  .strict();
export type ResyncRequiredData = z.infer<typeof resyncRequiredDataSchema>;

/**
 * Server-assigned SSE `id:` shape - a compact, restart-safe VECTOR of
 * "as-of-this-frame, here is my furthest-seen position in every source I'm
 * tracking": `"<sourceIndex>:<localOrdinal>,<sourceIndex>:<localOrdinal>,..."`,
 * sorted by sourceIndex ascending for a canonical/deterministic string form.
 *
 * Why a vector and not a single (sourceIndex, ordinal) pair: a single SSE
 * connection multiplexes events from every source adapter the connection's
 * channel scopes are subscribed to (plus heartbeats, sourceIndex 0, which are
 * never replayable/durable and exist only to keep the vector's "last known
 * position" for the reserved heartbeat slot moving). Native `Last-Event-ID`
 * is one opaque string carrying only the *last frame's* id - if that id
 * encoded only one source, a reconnect would lose the client's known
 * position in every OTHER source it had also received frames from earlier in
 * the same connection. Carrying the full multi-source vector forward on every
 * frame (not just the frame's own source) avoids that data loss without a
 * second durable table (each source row's global id is deterministically
 * *computed*, not looked up, so no extra storage is needed - see
 * apps/api/src/sse/sequence.ts).
 *
 * Exported here (not just in apps/api) because the web client's Last-Event-ID
 * handling and any future cross-package tooling need the same shape contract.
 */
export type SseCursorVector = ReadonlyMap<number, number>;

const VECTOR_ENTRY_RE = /^(\d+):(\d+)$/;
/** Hard cap on distinct sources per id, generous vs. the realistic adapter count - a safety bound against a malformed/hostile Last-Event-ID header, not a real product limit. */
const MAX_VECTOR_ENTRIES = 64;

export function encodeSseEventId(vector: SseCursorVector): string {
  return [...vector.entries()]
    .sort(([a], [b]) => a - b)
    .map(([sourceIndex, ordinal]) => `${sourceIndex}:${ordinal}`)
    .join(",");
}

/** Parses and validates a client-supplied `Last-Event-ID`. Never throws - returns `null` for any malformed input (mission §12: "invalid Last-Event-ID -> documented safe behavior"). */
export function decodeSseEventId(raw: string): SseCursorVector | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parts = trimmed.split(",");
  if (parts.length > MAX_VECTOR_ENTRIES) {
    return null;
  }
  const vector = new Map<number, number>();
  for (const part of parts) {
    const match = VECTOR_ENTRY_RE.exec(part.trim());
    if (!match) {
      return null;
    }
    const sourceIndex = Number(match[1]);
    const ordinal = Number(match[2]);
    if (!Number.isSafeInteger(sourceIndex) || !Number.isSafeInteger(ordinal)) {
      return null;
    }
    if (vector.has(sourceIndex)) {
      // Duplicate sourceIndex within one id - not a well-formed vector this
      // server ever produces itself. Reject rather than silently pick one.
      return null;
    }
    vector.set(sourceIndex, ordinal);
  }
  return vector;
}

/** Returns a new vector with `sourceIndex` advanced to `ordinal` (never regressing - mission §51: "cursor regression cannot silently move backward"). */
export function advanceVector(
  vector: SseCursorVector,
  sourceIndex: number,
  ordinal: number,
): SseCursorVector {
  const next = new Map(vector);
  const current = next.get(sourceIndex);
  if (current === undefined || ordinal > current) {
    next.set(sourceIndex, ordinal);
  }
  return next;
}

/**
 * ADR-005 risk mitigation / 26_REALTIME_SSE_AND_SYNC.md §Event schema:
 * "`heartbeat` fires every 15s". Overridable server-side via
 * `SSE_HEARTBEAT_SECONDS` (32_DEPLOYMENT_AND_OPERATIONS.md's env table);
 * this is the documented default both sides fall back to.
 */
export const DEFAULT_HEARTBEAT_SECONDS = 15;

/**
 * 26_REALTIME_SSE_AND_SYNC.md §Polling fallback: "enabled automatically
 * when: `EventSource.readyState !== OPEN` for more than 10 seconds ...".
 */
export const SSE_UNHEALTHY_GRACE_MS = 10_000;

/**
 * 03_realtime_infrastructure.md §ÉTAT ATTENDU APRÈS: "An internal poller
 * (2-5s interval)". Default sits at the middle of that documented range.
 */
export const DEFAULT_SOURCE_POLL_INTERVAL_MS = 3_000;

/**
 * Multi-tab toast dedup window (26_REALTIME_SSE_AND_SYNC.md §Multi-tab):
 * "the first tab to see a given event ID within a 500ms window shows the
 * toast, others suppress it".
 */
export const MULTI_TAB_DEDUP_WINDOW_MS = 500;
