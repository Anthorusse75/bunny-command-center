/**
 * Canonical, Python-compatible checksum for a materialized guild
 * configuration version (Step 10 external-review correction round, Section
 * 5 — "the most safety-critical item").
 *
 * MUST byte-for-byte match the canonical Self-bot writer's algorithm,
 * `01_NEW_SELF_BOTS/src/database/repositories/guild_config.py`:
 *
 *   def _checksum(payload):
 *       canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
 *       return hashlib.sha256(canonical.encode("utf-8")).digest()
 *
 *   checksum = _checksum({"common": common, "bunny": bunny, "selfbot": selfbot, "orchestrator": orchestrator})
 *
 * where each of the 4 sub-dicts is EXACTLY what gets inserted into
 * `guild_config_common`/`guild_config_bunny`/`guild_config_selfbot`/
 * `guild_config_orchestrator` (column name -> value, flat, except
 * `allowed_mime_json` — a nested list — and `decision_rules_json` — a
 * nested object/null).
 *
 * Two traps a naive `JSON.stringify`-based port falls into — this module
 * never calls `JSON.stringify` on the payload; every value is forced
 * through an explicit, Python-type-tagged `PyValue` first:
 *
 *  1. Real Discord snowflakes (BIGINT UNSIGNED, up to 2^64-1) passed through
 *     a JS `number` silently lose precision (JS numbers cannot represent
 *     integers above 2^53-1 losslessly) — Python's arbitrary-precision
 *     `int` renders as a bare, unquoted decimal digit sequence. Every "int"
 *     `PyValue` here carries a `bigint` (built from an exact decimal
 *     string, never a `number`) and is rendered via `bigint.toString(10)`.
 *
 *  2. Python's `json.dumps` defaults to `ensure_ascii=True` (escapes every
 *     codepoint outside printable ASCII, 0x20-0x7E, as `\uXXXX`);
 *     `JSON.stringify` does not. `encodePyString` below reimplements
 *     CPython's `json.encoder.py_encode_basestring_ascii` exactly.
 *     ** Disclosed **: every real Step-10-authored config field is
 *     ASCII-only in practice (digit-string channel ids, boolean flags,
 *     small integers, fixed enum-like strings) — this escaping path is
 *     implemented here for genuine correctness but is not exercised by any
 *     real production value today.
 *
 * `guild_weight`/`error_rate_circuit`/`fairness_weight` (SQL `DECIMAL`
 * columns) are represented as `PyValue` `"decimal"` — a JSON STRING holding
 * the exact decimal digits — matching what a real Python caller reading
 * these columns back via `aiomysql` (which yields `decimal.Decimal`) would
 * produce once handed to `json.dumps(..., default=str)`:
 * `default=str` fires for any type `json` cannot natively serialize,
 * calling `str(the_decimal)` and embedding the result as a JSON string.
 * ** Documented judgment call ** (flagged per this mission's "report
 * contradictions" culture): `guild_config.py`'s own unit test
 * (`tests/test_guild_config_repository.py`) constructs its `_COMMON` fixture
 * with a bare Python `float` (`guild_weight=1.0`), which `json.dumps` would
 * instead render as an UNQUOTED number (`1.0`). That module is not called by
 * any real production caller yet (its own docstring says so), so there is no
 * real precedent to match either way. This module deliberately treats
 * `DECIMAL` columns as the `decimal.Decimal`-via-`default=str` shape (a
 * quoted string, exact digits preserved) rather than the test's convenience
 * float literal, because: (a) that is what ANY real caller reading this
 * column back from MySQL through a standard Python DB driver actually gets,
 * and (b) it is round-trip-exact for arbitrary decimal precision, which a
 * JS/Python float is not. This is an explicit, disclosed choice — not a
 * silently-assumed one — and does not affect any byte comparison this phase
 * actually performs (the golden test below generates its Python-side
 * expected digest using the SAME chosen shape).
 */
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------
// PyValue: an explicit tagged representation of "the literal JSON type
// Python would have produced for this value's real Python type," so this
// module never has to guess from a plain JS value's own type.
// ---------------------------------------------------------------------
export type PyValue =
  | { readonly t: "int"; readonly v: bigint }
  | { readonly t: "str"; readonly v: string }
  | { readonly t: "bool"; readonly v: boolean }
  | { readonly t: "null" }
  | { readonly t: "decimal"; readonly v: string }
  | { readonly t: "list"; readonly v: readonly PyValue[] }
  | { readonly t: "dict"; readonly v: Readonly<Record<string, PyValue>> };

/** `value` must be an exact base-10 digit string (optionally `-` prefixed) or a safe JS integer/bigint — never a value that has already been round-tripped through float arithmetic. */
export function pyInt(value: bigint | number | string): PyValue {
  if (typeof value === "bigint") return { t: "int", v: value };
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`pyInt: ${value} is not an integer`);
    }
    return { t: "int", v: BigInt(value) };
  }
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`pyInt: not a plain decimal digit string: ${JSON.stringify(value)}`);
  }
  return { t: "int", v: BigInt(value) };
}
export function pyStr(value: string): PyValue {
  return { t: "str", v: value };
}
export function pyBool(value: boolean): PyValue {
  return { t: "bool", v: value };
}
export const pyNull: PyValue = { t: "null" };
/** `value` is the EXACT decimal digit string as stored/read (e.g. `"1.000"`) — never a float that may have lost trailing-zero precision. */
export function pyDecimal(value: string): PyValue {
  return { t: "decimal", v: value };
}
export function pyList(value: readonly PyValue[]): PyValue {
  return { t: "list", v: value };
}
export function pyDict(value: Readonly<Record<string, PyValue>>): PyValue {
  return { t: "dict", v: value };
}
/** `null` in, `null` out; otherwise unwraps to `value`. Convenience for the many nullable orchestrator/bunny columns below. */
export function pyNullable(value: PyValue | null): PyValue {
  return value ?? pyNull;
}

/**
 * CPython's `json.encoder.py_encode_basestring_ascii`: escape `"` and `\`,
 * the 6 named short escapes for their control characters, `\u00XX` for
 * every other codepoint outside `0x20..0x7E` inclusive. Iterating the JS
 * string's UTF-16 code units and escaping each one individually already
 * reproduces CPython's own surrogate-pair-as-two-`\u`-escapes behavior for
 * codepoints beyond the BMP — no extra surrogate-pair handling needed here.
 */
function encodePyString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]!;
    const code = s.charCodeAt(i);
    if (ch === '"') {
      out += '\\"';
    } else if (ch === "\\") {
      out += "\\\\";
    } else if (code >= 0x20 && code <= 0x7e) {
      out += ch;
    } else {
      switch (code) {
        case 0x08:
          out += "\\b";
          break;
        case 0x0c:
          out += "\\f";
          break;
        case 0x0a:
          out += "\\n";
          break;
        case 0x0d:
          out += "\\r";
          break;
        case 0x09:
          out += "\\t";
          break;
        default:
          out += `\\u${code.toString(16).padStart(4, "0")}`;
          break;
      }
    }
  }
  return `${out}"`;
}

function canonicalize(value: PyValue): string {
  switch (value.t) {
    case "int":
      return value.v.toString(10);
    case "bool":
      return value.v ? "true" : "false";
    case "null":
      return "null";
    case "str":
      return encodePyString(value.v);
    case "decimal":
      // json.dumps(..., default=str) on a decimal.Decimal -> a JSON STRING
      // holding str(the_decimal) -- never a bare number.
      return encodePyString(value.v);
    case "list":
      return `[${value.v.map(canonicalize).join(",")}]`;
    case "dict": {
      // Python's sort_keys=True sorts by Unicode codepoint order, same as
      // JS's default Array.sort() on strings for the ASCII-only column-name
      // keys this module ever builds dicts from.
      const keys = Object.keys(value.v).sort();
      return `{${keys.map((k) => `${encodePyString(k)}:${canonicalize(value.v[k]!)}`).join(",")}}`;
    }
    default: {
      const exhaustive: never = value;
      throw new Error(`canonicalize: unreachable PyValue variant: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** The exact UTF-8 text `json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)` would produce for the equivalent Python value. Exported for the golden cross-language test. */
export function canonicalPyJson(value: PyValue): string {
  return canonicalize(value);
}

export function sha256OfCanonicalPyJson(value: PyValue): Buffer {
  return createHash("sha256").update(canonicalPyJson(value), "utf8").digest();
}

// ---------------------------------------------------------------------
// The 4 real sub-table shapes, matching guild_config.py's own
// COMMON_COLUMNS/BUNNY_COLUMNS/SELFBOT_COLUMNS/ORCHESTRATOR_OVERRIDE_COLUMNS
// allowlists exactly (see that module for the authoritative column list).
//
// ** Documented judgment call ** (reconstructibility): `guild_config.py`'s
// own `orchestrator` dict is whatever SPARSE subset of columns a real
// caller happens to pass (e.g. its own test passes only
// `{max_guild_inflight: 1}`) -- the checksum only reflects the keys
// actually present, not the full DB row (unset columns are simply absent
// from the checksum'd dict, not present-with-null). That is NOT
// reconstructible from `guild_config_orchestrator`'s stored row alone --
// the DB row cannot distinguish "this column was never part of the
// caller's dict" from "this column was explicitly set to NULL," both look
// identical once persisted. Since this TypeScript materializer is the ONLY
// writer of Step-10-created guild configuration versions today (Python's
// `create_draft_guild_version` has no real caller yet, per its own
// docstring), this module adopts a single, ALWAYS-FULL-COLUMN convention
// for every one of the 4 sub-dicts (every allowlisted column key always
// present, `null` for anything unset) -- this makes "recompute the checksum
// from the real stored sub-table rows" (Section 5.1) well-defined and
// reconstructible by construction, at the cost of not matching Python's
// OWN sparse-dict test fixture literally. The golden cross-language test
// below still proves this module's SERIALIZER is byte-for-byte faithful to
// Python's algorithm for a given dict shape (full OR sparse) -- the
// "always full" choice is a materialization-time policy, orthogonal to
// serializer correctness, and is exercised identically on both the
// materialize-time computation and the approval-time recompute so the two
// can never disagree with each other.
// ---------------------------------------------------------------------

export interface CommonSubtableValues {
  readonly timezone: string;
  readonly operationalEnabled: boolean;
  readonly locale: string;
  /** Exact decimal digit string, e.g. `"1.000"` -- never a float. */
  readonly guildWeight: string;
}

export interface BunnySubtableValues {
  /** Exact decimal digit string (BIGINT UNSIGNED snowflake-range channel id). */
  readonly incomingChannelId: string;
  readonly processedChannelId: string | null;
  readonly ingestionEnabled: boolean;
  readonly sourceDeletePolicy: string;
  readonly saveProcessedCopy: boolean;
  readonly ocrEngine: string;
  readonly ocrProfile: string;
  readonly perGuildConcurrency: number;
  readonly maxOcrAttempts: number;
  readonly retryBaseSeconds: number;
  readonly catchupIntervalSeconds: number;
  /** Exact decimal digit string (BIGINT UNSIGNED) -- practically always small, but read via CAST(...AS CHAR) for the same precision-safety discipline as every other BIGINT column here. */
  readonly maxAttachmentBytes: string;
  readonly allowedMime: readonly string[];
}

export interface SelfbotSubtableValues {
  readonly herowarbotChannelId: string;
  readonly screenshotsChannelId: string | null;
  readonly communityChannelId: string | null;
  readonly automationEnabled: boolean;
  readonly profileEnabled: boolean;
  readonly profileTimeoutSeconds: number;
  readonly profileStaleSeconds: number;
  readonly heroResponseTimeoutSeconds: number;
  readonly maxDeliveryAttempts: number;
  readonly communityUpdatesEnabled: boolean;
  readonly everyoneMentionsEnabled: boolean;
  readonly reminderEnabled: boolean;
  readonly nbGcHero: number;
  readonly nbGcTitan: number;
  readonly nbHol: number;
  readonly nbHero: number;
  readonly nbTitan: number;
  readonly autoProfileIntervalSeconds: number;
  readonly autoMaxPerCycle: number;
}

export interface OrchestratorSubtableValues {
  readonly maxGuildInflight: number | null;
  readonly maxChannelInflight: number | null;
  readonly riskEvalMinSeconds: number | null;
  readonly riskEvalMaxSeconds: number | null;
  readonly sendMinSeconds: number | null;
  readonly sendMaxSeconds: number | null;
  readonly profileMinSeconds: number | null;
  readonly profileMaxSeconds: number | null;
  readonly reminderMinSeconds: number | null;
  readonly reminderMaxSeconds: number | null;
  readonly criticalHoursRemaining: number | null;
  readonly heroLatencyCircuitSeconds: number | null;
  /** Exact decimal digit string or `null` -- DECIMAL column. */
  readonly errorRateCircuit: string | null;
  readonly minSampleSize: number | null;
  /** Exact decimal digit string or `null` -- DECIMAL column. */
  readonly fairnessWeight: string | null;
  readonly starvationSeconds: number | null;
  readonly decisionRulesJson: JsonLikeValue | null;
}

export interface MaterializedConfigValues {
  readonly common: CommonSubtableValues;
  readonly bunny: BunnySubtableValues;
  readonly selfbot: SelfbotSubtableValues;
  readonly orchestrator: OrchestratorSubtableValues;
}

// A minimal JSON-value type for decision_rules_json's arbitrary nested
// shape (never populated by Step 10 -- no onboarding section writes
// orchestrator overrides -- but implemented for genuine correctness).
export type JsonLikeValue =
  string | number | boolean | null | readonly JsonLikeValue[] | { readonly [key: string]: JsonLikeValue };

/**
 * Generic JSON-value -> PyValue converter for `decision_rules_json`'s
 * unspecified nested shape. ** Documented limitation **: a plain JS
 * `number` here is treated as a Python `int` via `pyInt` when it is a safe
 * integer, matching how a JSON column value like `5` would have been
 * authored as a Python int literal; a non-integer JS number is rendered
 * using `String(value)`, wrapped as `pyDecimal`-shaped output (a bare
 * fallback, not a rigorous Python-float-repr port) -- this path is
 * currently unreachable in practice (no Step 10 code ever populates
 * `decision_rules_json`), so it is deliberately not built out further than
 * "correct for the integer case, documented-best-effort otherwise."
 */
export function jsonLikeToPyValue(value: JsonLikeValue): PyValue {
  if (value === null) return pyNull;
  if (typeof value === "boolean") return pyBool(value);
  if (typeof value === "string") return pyStr(value);
  if (typeof value === "number") {
    if (Number.isInteger(value)) return pyInt(value);
    // See the doc comment above -- not exercised by any real Step 10 data.
    return pyStr(String(value));
  }
  if (Array.isArray(value)) return pyList(value.map(jsonLikeToPyValue));
  const record = value as { readonly [key: string]: JsonLikeValue };
  const out: Record<string, PyValue> = {};
  for (const key of Object.keys(record)) {
    out[key] = jsonLikeToPyValue(record[key]!);
  }
  return pyDict(out);
}

function commonToPyDict(v: CommonSubtableValues): PyValue {
  return pyDict({
    timezone: pyStr(v.timezone),
    operational_enabled: pyBool(v.operationalEnabled),
    locale: pyStr(v.locale),
    guild_weight: pyDecimal(v.guildWeight),
  });
}

function bunnyToPyDict(v: BunnySubtableValues): PyValue {
  return pyDict({
    incoming_channel_id: pyInt(v.incomingChannelId),
    processed_channel_id: v.processedChannelId === null ? pyNull : pyInt(v.processedChannelId),
    ingestion_enabled: pyBool(v.ingestionEnabled),
    source_delete_policy: pyStr(v.sourceDeletePolicy),
    save_processed_copy: pyBool(v.saveProcessedCopy),
    ocr_engine: pyStr(v.ocrEngine),
    ocr_profile: pyStr(v.ocrProfile),
    per_guild_concurrency: pyInt(v.perGuildConcurrency),
    max_ocr_attempts: pyInt(v.maxOcrAttempts),
    retry_base_seconds: pyInt(v.retryBaseSeconds),
    catchup_interval_seconds: pyInt(v.catchupIntervalSeconds),
    max_attachment_bytes: pyInt(v.maxAttachmentBytes),
    allowed_mime_json: pyList(v.allowedMime.map(pyStr)),
  });
}

function selfbotToPyDict(v: SelfbotSubtableValues): PyValue {
  return pyDict({
    herowarbot_channel_id: pyInt(v.herowarbotChannelId),
    screenshots_channel_id: v.screenshotsChannelId === null ? pyNull : pyInt(v.screenshotsChannelId),
    community_channel_id: v.communityChannelId === null ? pyNull : pyInt(v.communityChannelId),
    automation_enabled: pyBool(v.automationEnabled),
    profile_enabled: pyBool(v.profileEnabled),
    profile_timeout_seconds: pyInt(v.profileTimeoutSeconds),
    profile_stale_seconds: pyInt(v.profileStaleSeconds),
    hero_response_timeout_seconds: pyInt(v.heroResponseTimeoutSeconds),
    max_delivery_attempts: pyInt(v.maxDeliveryAttempts),
    community_updates_enabled: pyBool(v.communityUpdatesEnabled),
    everyone_mentions_enabled: pyBool(v.everyoneMentionsEnabled),
    reminder_enabled: pyBool(v.reminderEnabled),
    nb_gc_hero: pyInt(v.nbGcHero),
    nb_gc_titan: pyInt(v.nbGcTitan),
    nb_hol: pyInt(v.nbHol),
    nb_hero: pyInt(v.nbHero),
    nb_titan: pyInt(v.nbTitan),
    auto_profile_interval_seconds: pyInt(v.autoProfileIntervalSeconds),
    auto_max_per_cycle: pyInt(v.autoMaxPerCycle),
  });
}

function orchestratorToPyDict(v: OrchestratorSubtableValues): PyValue {
  const intOrNull = (n: number | null): PyValue => (n === null ? pyNull : pyInt(n));
  const decOrNull = (s: string | null): PyValue => (s === null ? pyNull : pyDecimal(s));
  return pyDict({
    max_guild_inflight: intOrNull(v.maxGuildInflight),
    max_channel_inflight: intOrNull(v.maxChannelInflight),
    risk_eval_min_seconds: intOrNull(v.riskEvalMinSeconds),
    risk_eval_max_seconds: intOrNull(v.riskEvalMaxSeconds),
    send_min_seconds: intOrNull(v.sendMinSeconds),
    send_max_seconds: intOrNull(v.sendMaxSeconds),
    profile_min_seconds: intOrNull(v.profileMinSeconds),
    profile_max_seconds: intOrNull(v.profileMaxSeconds),
    reminder_min_seconds: intOrNull(v.reminderMinSeconds),
    reminder_max_seconds: intOrNull(v.reminderMaxSeconds),
    critical_hours_remaining: intOrNull(v.criticalHoursRemaining),
    hero_latency_circuit_seconds: intOrNull(v.heroLatencyCircuitSeconds),
    error_rate_circuit: decOrNull(v.errorRateCircuit),
    min_sample_size: intOrNull(v.minSampleSize),
    fairness_weight: decOrNull(v.fairnessWeight),
    starvation_seconds: intOrNull(v.starvationSeconds),
    decision_rules_json: v.decisionRulesJson === null ? pyNull : jsonLikeToPyValue(v.decisionRulesJson),
  });
}

/** The exact `PyValue` tree for `{"common": ..., "bunny": ..., "selfbot": ..., "orchestrator": ...}` -- exported for tests that want to inspect/compare the canonical JSON text directly. */
export function buildMaterializedConfigPyValue(values: MaterializedConfigValues): PyValue {
  return pyDict({
    common: commonToPyDict(values.common),
    bunny: bunnyToPyDict(values.bunny),
    selfbot: selfbotToPyDict(values.selfbot),
    orchestrator: orchestratorToPyDict(values.orchestrator),
  });
}

/** `guild_configuration_versions.checksum` (BINARY(32)) for a fully materialized config -- the ONE function every checksum-writing/checksum-verifying call site in this step must go through. */
export function computeMaterializedConfigChecksum(values: MaterializedConfigValues): Buffer {
  return sha256OfCanonicalPyJson(buildMaterializedConfigPyValue(values));
}
