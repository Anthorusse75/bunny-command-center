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
 * ============================================================================
 * SSE `id:` WIRE PROTOCOL — canonical grammar and guarantees
 * ============================================================================
 *
 * This is the implementation-owned protocol note for the SSE event-id shape.
 * Nothing in DASHBOARD/26_REALTIME_SSE_AND_SYNC.md or DASHBOARD/25_DATA_MODEL.md
 * fixes an exact wire encoding for `id:` (26's own example uses a plain
 * illustrative sequential integer; the underlying data model those two docs
 * DO fix is `dashboard_sse_cursor(source_table, cursor_key, last_sequence)` -
 * a durable watermark keyed per source). This file's job is to pick ONE
 * concrete, testable encoding consistent with that data model and document
 * it here, in code - not to alter the frozen architecture documents
 * themselves. Grammar:
 *
 *   id        := entry ("," entry)*
 *   entry     := sourceIndex ":" ordinal
 *   sourceIndex := DIGIT+          (no leading sign, no leading "+")
 *   ordinal   := DIGIT+            (no leading sign, no leading "+")
 *   DIGIT     := "0".."9"
 *
 * i.e. a comma-separated list of `<non-negative-integer>:<non-negative-integer>`
 * pairs, ASCII digits only. There is deliberately no character class in this
 * grammar that can ever produce or accept CR (`\r`), LF (`\n`), or NUL
 * (`U+0000`) - `\d` never matches them, and the only other characters the
 * grammar uses at all are the literal `:` and `,` separators - so no input
 * that survives `decodeSseEventId` can ever contain them, and no output of
 * `encodeSseEventId` can either (proven for both directions in
 * packages/shared/test/realtime.test.ts, not merely asserted here).
 *
 * WHY A VECTOR, NOT A SINGLE (sourceIndex, ordinal) PAIR: one SSE connection
 * multiplexes events from every source adapter the connection's channel
 * scopes are subscribed to (plus heartbeats, reserved `sourceIndex` 0, which
 * are never replayable/durable and exist only to keep that reserved slot's
 * "last known position" moving so a heartbeat-only gap still round-trips
 * safely). Native `Last-Event-ID` is one opaque string carrying only the
 * *last frame's* id - if that id encoded only one source, a reconnect would
 * lose the client's known position in every OTHER source it had also
 * received frames from earlier in the same connection. Carrying the full
 * multi-source vector forward on every frame (not just the frame's own
 * source) avoids that data loss without a second durable table: each
 * source's own component is derived from that source's own durable,
 * monotonic ordinal (e.g. an auto-increment PK) - never a randomly-minted or
 * process-local counter - so it is restart-safe and requires no extra
 * storage beyond the single `dashboard_sse_cursor` row per
 * `(source_table, cursor_key)` the data model already provides.
 *
 * CANONICAL FORM AND DETERMINISM: `encodeSseEventId` always emits entries
 * sorted by ascending `sourceIndex`, regardless of the input `Map`'s
 * insertion order - so the SAME vector (same key/value pairs) always
 * serializes to the EXACT SAME string, and two vectors built by inserting
 * their entries in different orders are provably indistinguishable in their
 * encoded form (packages/shared/test/realtime.test.ts, "canonical form is
 * insertion-order-independent"). `decodeSseEventId` is a strict, total
 * parse: any input outside the grammar above (including a duplicate
 * `sourceIndex` within one id, which this server itself never produces and
 * therefore treats as unambiguously malformed rather than picking a side)
 * returns `null` - never throws, never guesses (mission §12: "invalid
 * Last-Event-ID -> documented safe behavior"). encode -> decode -> encode is
 * proven stable (round-trip test) for every vector shape exercised.
 *
 * BOUNDS: `sourceIndex`/`ordinal` are each required to parse as a JS safe
 * integer (`Number.isSafeInteger`, i.e. within +/-2^53-1) - anything larger
 * is rejected as malformed, not silently truncated or wrapped. The vector is
 * capped at `MAX_VECTOR_ENTRIES` distinct sources, and the RAW input string
 * is capped at `MAX_ENCODED_LENGTH` bytes BEFORE any split/parse work
 * happens, so a hostile/malformed `Last-Event-ID` cannot force unbounded
 * parsing work.
 *
 * UNKNOWN SOURCE ENTRIES: a syntactically valid vector may legitimately
 * contain a `sourceIndex` that no currently-registered adapter owns (e.g. a
 * client reconnecting after a server-side adapter was removed/renamed
 * between deploys). `decodeSseEventId` accepts it (it is not malformed - the
 * ENCODING is valid, only its relationship to the CURRENT server is
 * unknown); the documented safe behavior for that case lives at the
 * CONSUMER (apps/api/src/sse/route.ts's replay logic iterates only
 * currently-registered adapters and looks up each one's own component in
 * the decoded vector - an entry for an unregistered source is simply never
 * looked up, never causes an error, and is silently dropped from the
 * connection's live vector going forward once any real frame re-encodes it).
 *
 * Exported here (not just in apps/api) because the web client's Last-Event-ID
 * handling and any future cross-package tooling need the same shape contract.
 */
export type SseCursorVector = ReadonlyMap<number, number>;

const VECTOR_ENTRY_RE = /^(\d+):(\d+)$/;
/** Hard cap on distinct sources per id, generous vs. the realistic adapter count - a safety bound against a malformed/hostile Last-Event-ID header, not a real product limit. */
const MAX_VECTOR_ENTRIES = 64;
/**
 * Hard cap on the RAW encoded string length, checked before any
 * split/parse work - independent of `MAX_VECTOR_ENTRIES` (which alone
 * wouldn't stop a hostile client from sending 64 entries with absurdly long
 * digit runs). `20` decimal digits comfortably exceeds the longest possible
 * safe-integer representation (`Number.MAX_SAFE_INTEGER` is 16 digits), so
 * `64 * (20 + 1 + 20 + 1) = 2688`; 4096 leaves headroom without being
 * effectively unbounded.
 */
const MAX_ENCODED_LENGTH = 4096;

export function encodeSseEventId(vector: SseCursorVector): string {
  return [...vector.entries()]
    .sort(([a], [b]) => a - b)
    .map(([sourceIndex, ordinal]) => `${sourceIndex}:${ordinal}`)
    .join(",");
}

/**
 * Whole-string grammar check, applied BEFORE any split/parse work and
 * WITHOUT ever calling `.trim()` on the input. This is deliberate, not an
 * oversight: `String.prototype.trim()` strips every Unicode "whitespace"
 * character, which includes `\n`/`\r`/tab - trimming first and validating
 * second would silently turn `"1:2\n"` into the well-formed `"1:2"`,
 * SWALLOWING an embedded control character instead of rejecting it (found
 * and fixed via a real failing test, not a hypothetical concern - see
 * packages/shared/test/realtime.test.ts's "rejects embedded CR, LF, or NUL"
 * case). Requiring the ENTIRE raw string to match this pattern - no leading/
 * trailing/internal whitespace of any kind tolerated anywhere - makes CR/LF/
 * NUL injection structurally impossible: `\d` never matches them, and `:`/
 * `,` are the only other characters the pattern allows.
 */
const FULL_VECTOR_RE = /^\d+:\d+(,\d+:\d+)*$/;

/** Parses and validates a client-supplied `Last-Event-ID`. Never throws - returns `null` for any malformed input (mission §12: "invalid Last-Event-ID -> documented safe behavior"). An empty string is also `null` (not an empty, valid vector) - a real client either omits `Last-Event-ID` entirely (never reaches this function - see apps/api/src/sse/route.ts) or sends a real, previously-issued id; an explicit empty value is never something this server itself produces and is therefore treated as malformed like any other unrecognized shape. */
export function decodeSseEventId(raw: string): SseCursorVector | null {
  if (raw.length === 0 || raw.length > MAX_ENCODED_LENGTH) {
    return null;
  }
  if (!FULL_VECTOR_RE.test(raw)) {
    return null;
  }
  const parts = raw.split(",");
  if (parts.length > MAX_VECTOR_ENTRIES) {
    return null;
  }
  const vector = new Map<number, number>();
  for (const part of parts) {
    const match = VECTOR_ENTRY_RE.exec(part);
    if (!match) {
      // Unreachable given FULL_VECTOR_RE already matched the whole string,
      // but kept as a defensive check rather than a non-null assertion.
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
