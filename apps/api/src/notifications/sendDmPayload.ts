/**
 * Builds the `operator_commands.payload_json` value for `command_type=
 * 'SEND_DM'` — the REAL shape the merged Bunny OCR consumer validates and
 * consumes, verified against the live source (correction #1, this step's
 * task brief):
 *
 *   `02_NEW_BOT_OCR/functions/operator_command_consumer.py:1194-1240`
 *   (`validate_send_dm_payload`): requires `discord_user_id` (Python `int`,
 *   i.e. a JSON NUMBER, not a string — `:1203-1205`,
 *   `isinstance(discord_user_id, int) ... discord_user_id <= 0` raises
 *   `SendDmPayloadError` otherwise) and `content` (non-empty `str`,
 *   `:1207-1209`); accepts optional `footer` (`str` or `None`, `:1211-1213`)
 *   and optional `correlation_id` (`str`, capped length, `:1219-1226`).
 *   Nothing else in `payload_json` is trusted (`:1169`: "no embeds, no
 *   attachments"). `content`+`footer` combined are capped at 2000 chars
 *   (Discord's DM limit, `_SEND_DM_MAX_CONTENT_LEN`, `:1172`, enforced at
 *   `:1229-1232`) — a too-long render is a real, terminal `SendDmPayloadError`
 *   on Bunny's side, never something this function silently truncates (a
 *   silently-shortened DM could drop meaningful content without anyone
 *   knowing); Bunny's own terminal-failure path
 *   (`SEND_DM_DELIVERY_OUTCOME_UNKNOWN`'s sibling ordinary `FAILED` case)
 *   surfaces it, and the notification's durable in-app record is unaffected
 *   either way (ADR-013).
 *
 * `discord_user_id` MUST NEVER be run through `Number()`/`parseInt()` in
 * this codebase (00_GLOBAL_IMPLEMENTATION_RULES.md-adjacent Snowflake
 * discipline, `apps/api/src/auth/snowflake.ts`'s own header comment) — but
 * Bunny's validator requires a genuine JSON *number*, not a quoted string.
 * The resolution: this function assembles the JSON TEXT by hand, splicing
 * the ALREADY-VALIDATED (`isSyntacticallyValidSnowflake`) digit string in
 * as a raw, UNQUOTED numeric literal — the JS runtime never parses it into
 * a `Number` at any point (no `JSON.parse`/`Number()` touches it). MySQL's
 * JSON type stores integers that fit a 64-bit (un)signed range using its own
 * internal INT64/UINT64 representation, not `DOUBLE` (verified: MySQL 8's
 * JSON storage docs — "numbers are stored using the smallest type able to
 * hold the value"), so a real Discord Snowflake (well within 64 bits)
 * round-trips through `CAST(? AS JSON)` exactly; Python's `json.loads` then
 * parses it into an arbitrary-precision `int`. Every OTHER field is built
 * via `JSON.stringify` (safe — none of them are Snowflakes).
 */
import { isSyntacticallyValidSnowflake } from "../auth/snowflake.js";

export interface SendDmPayloadInput {
  readonly discordUserId: string;
  readonly content: string;
  readonly footer: string;
  readonly correlationId: string;
}

/** Hand-built JSON text — see file header for why this isn't `JSON.stringify` on a plain object. Throws (never silently coerces) if `discordUserId` isn't already a syntactically valid Snowflake — a defensive invariant check, since every real caller validates this earlier (session identity or `config.superadmin.discordUserId`, both already-validated sources). */
export function buildSendDmPayloadJsonText(input: SendDmPayloadInput): string {
  if (!isSyntacticallyValidSnowflake(input.discordUserId)) {
    throw new Error(
      `buildSendDmPayloadJsonText: discordUserId is not a syntactically valid Discord snowflake: ${JSON.stringify(input.discordUserId)}`,
    );
  }
  if (input.content.length === 0) {
    throw new Error("buildSendDmPayloadJsonText: content must be non-empty");
  }
  return (
    `{"discord_user_id":${input.discordUserId}` +
    `,"content":${JSON.stringify(input.content)}` +
    `,"footer":${JSON.stringify(input.footer)}` +
    `,"correlation_id":${JSON.stringify(input.correlationId)}}`
  );
}
