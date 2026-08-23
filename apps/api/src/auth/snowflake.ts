/**
 * Discord Snowflake identity helpers (08_AUTHORIZATION_AND_RBAC.md,
 * ADR-008). Snowflakes are up to 64 bits / commonly 17-19 decimal digits --
 * well past `Number.MAX_SAFE_INTEGER` (16 digits) -- so EVERY function in
 * this module operates on the string form only. No function here ever
 * calls `Number(...)`/`parseInt(...)`/`parseFloat(...)`/unary `+` on an ID
 * value, and none ever will: doing so can silently collide two different
 * Discord accounts/guilds/roles once their IDs differ only past the 16th
 * significant digit (the exact defect Step 04's "Snowflake correction"
 * fixed for `dashboard_users.discord_user_id`; this module is Step 05's
 * equivalent guarantee for every NEW identity value the RBAC path
 * introduces: guild IDs, role IDs, the Superadmin ID, override subject IDs).
 *
 * Real Discord Snowflakes are 64-bit unsigned integers minted from a custom
 * epoch (2015-01-01) -- in practice this means 17-19 digits today and won't
 * exceed 20 (2^64-1 is 20 digits). `SNOWFLAKE_PATTERN` accepts 15-20
 * digits: generous enough for the low end (a full sweep of "this doesn't
 * even look like a Snowflake" garbage still fails) without hand-tuning to
 * today's exact minimum, which only grows over time as Discord's clock
 * advances.
 */

const SNOWFLAKE_PATTERN = /^\d{15,20}$/;

/**
 * MySQL `BIGINT UNSIGNED`'s real maximum (2^64-1) -- itself 20 decimal
 * digits, same as `SNOWFLAKE_PATTERN`'s upper length bound. A 20-digit
 * decimal string is NOT guaranteed to fit: any value in
 * `(18446744073709551615, 99999999999999999999]` is still 20 digits but
 * overflows the column type every real caller of this function eventually
 * writes the value into (`operator_commands.requested_by_discord_id`/
 * `guild_id`, `db/bigIntParam.ts`'s own `bindBigIntUnsigned`). Compared via
 * `BigInt` -- exact, arbitrary-precision, and safe here specifically
 * because this comparison's boolean RESULT is all that ever leaves this
 * function; the `BigInt` value itself is discarded immediately and never
 * forwarded to a `JSON.stringify`/serialization path that would
 * quote/convert the original digit string (this module's own header
 * comment's invariant: no function here ever turns an ID into a `Number`
 * that could lose or reshape precision on some OTHER path).
 */
const BIGINT_UNSIGNED_MAX = 18446744073709551615n;

/**
 * Syntactic validity only -- this does NOT check the ID against Discord,
 * only that it is SHAPED like a real Snowflake (digits-only, plausible
 * length) AND fits the real numeric range every downstream BIGINT UNSIGNED
 * column requires. Used both for `PLATFORM_SUPERADMIN_DISCORD_ID` startup
 * validation (ADR-008: "production startup fails loudly ... if unset or
 * not a syntactically valid Discord snowflake") and as a defensive guard
 * anywhere an externally-supplied ID-shaped string enters the RBAC path.
 */
export function isSyntacticallyValidSnowflake(value: string): boolean {
  if (!SNOWFLAKE_PATTERN.test(value)) {
    return false;
  }
  return BigInt(value) <= BIGINT_UNSIGNED_MAX;
}

/**
 * Exact, constant-shape string equality for two Snowflake IDs. This is
 * intentionally just `===` -- documented as its own named function so every
 * identity comparison in the RBAC path reads the same way and so a future
 * reviewer never "optimizes" an identity comparison into a numeric one.
 * (Superadmin/session/override comparisons are not attacker-timing-
 * sensitive the way a token/HMAC compare is -- `routes.ts`'s
 * `constantTimeEquals` remains the right tool for THAT class of comparison;
 * this one exists purely to keep numeric coercion out of the identity path,
 * not to defend against a timing side-channel.)
 */
export function snowflakeEquals(a: string, b: string): boolean {
  return a === b;
}
