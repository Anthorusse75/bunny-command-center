/**
 * Binds an exact decimal digit string as a query parameter for a
 * `BIGINT UNSIGNED` column, without ever letting the JS runtime parse it
 * into a `Number` (correction #3, this step's task brief: "Never run a
 * Snowflake through `Number()`/`parseInt()`/JS arithmetic. For
 * `operator_commands` BIGINT UNSIGNED columns, bind the exact decimal
 * string and let MySQL convert it.").
 *
 * `apps/api/src/auth/snowflake.ts` established the DASHBOARD-OWNED-table
 * convention of simply typing these columns `VARCHAR`, never numeric
 * (`dashboard_users.discord_user_id`, `dashboard_user_guild_preferences.
 * guild_id`, etc.) — but `operator_commands.requested_by_discord_id`/
 * `guild_id` are SHARED-schema `BIGINT UNSIGNED` columns Dashboard does not
 * own (`01_NEW_SELF_BOTS/database/migrations/0009_operations.up.sql:20,36`)
 * and cannot retype. `mysql2`/Kysely forward a bound parameter to the
 * server as-is — a STRING parameter for a numeric column is sent as a
 * string literal and converted SERVER-SIDE by MySQL, never coerced through
 * a JS `Number` at any point in this process. `kysely-codegen` still types
 * these columns as TS `number` (it has no way to know this codebase's
 * Snowflake-precision discipline), so this function's return type
 * deliberately lies about the runtime value's shape — documented here, at
 * the one place the lie happens, rather than scattered `as unknown as
 * number` casts at every call site.
 */
/**
 * MySQL `BIGINT UNSIGNED`'s real maximum (2^64-1) -- see
 * `auth/snowflake.ts`'s identical constant for the full rationale. Checked
 * via `BigInt` (exact, arbitrary-precision) purely as a one-shot boolean
 * range comparison, discarded immediately -- never forwarded to a
 * `JSON.stringify`/serialization path.
 */
const BIGINT_UNSIGNED_MAX = 18446744073709551615n;

export function bindBigIntUnsigned(exactDecimalDigits: string): number {
  if (!/^\d+$/.test(exactDecimalDigits)) {
    throw new Error(
      `bindBigIntUnsigned: not a plain decimal digit string: ${JSON.stringify(exactDecimalDigits)}`,
    );
  }
  if (BigInt(exactDecimalDigits) > BIGINT_UNSIGNED_MAX) {
    throw new Error(
      `bindBigIntUnsigned: value exceeds MySQL BIGINT UNSIGNED's max (${BIGINT_UNSIGNED_MAX}): ${exactDecimalDigits}`,
    );
  }
  return exactDecimalDigits as unknown as number;
}
