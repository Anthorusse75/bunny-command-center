import type mysql from "mysql2/promise";

/**
 * Dashboard's SUPPORTED shared-schema compatibility range
 * (06_VERSIONING_AND_COMPATIBILITY.md: "the Dashboard's SUPPORTED_SCHEMA_MAX
 * floor is always ≥ the migration that introduced
 * web_upload_intake/web_upload_staging_blobs/guilds.lifecycle_state") —
 * mirrors the exact SUPPORTED_SCHEMA_MIN/MAX pattern the two bots already
 * use (`vendor/self-bot-schema/src/database/schema_compat.py`), checked
 * against the SAME canonical `schema_migrations` ledger the Self-bot
 * migrator owns (never a second, Dashboard-invented ledger for the shared
 * schema).
 *
 * Step 10 is the first Dashboard feature that genuinely depends on shared
 * migration 0015 (`guilds.lifecycle_state`/`lifecycle_state_changed_at`/
 * `suspended_from_state`) — the point `readiness.ts`'s own prior doc comment
 * predicted ("the first real dependency ... arrives in Step 07 ... will
 * replace this constant with a real compatibility gate") has now arrived.
 *
 * ONE canonical declaration, consumed by BOTH `readiness.ts` (live check
 * against the actual applied schema) and `routes/version.ts` (static
 * "what this build supports" reporting) — bump both values together
 * whenever a new shared migration is introduced AND this codebase has been
 * updated to work with the schema it produces, never scattered as a second
 * literal elsewhere.
 */
export const SUPPORTED_SHARED_SCHEMA_MIN = "0015";
export const SUPPORTED_SHARED_SCHEMA_MAX = "0015";

/** The SHARED, Self-bot-owned migration ledger — distinct from `db/constants.ts`'s `DASHBOARD_MIGRATION_LEDGER_TABLE`, never configurable, never Dashboard-written (`vendor/self-bot-schema/database/migrate.py` is its sole writer). */
export const SHARED_SCHEMA_MIGRATIONS_TABLE = "schema_migrations";

export interface SharedSchemaCompatibilityResult {
  readonly compatible: boolean;
  readonly highestAppliedVersion: string | null;
  readonly detail: string;
}

/** The zero-padded numeric prefix a real migration "version" string (e.g. "0015_web_ingestion_and_guild_lifecycle") is compared by — same convention as the Python `_version_prefix()` this mirrors, so string length differences never skew the comparison. */
function versionPrefix(version: string): string {
  return version.split("_", 1)[0]!;
}

/**
 * Mirrors `vendor/self-bot-schema/src/database/schema_compat.py`'s
 * `check_schema_compatibility()` in intent: same table, same
 * `state = 'APPLIED'` filter (a `STARTED`/`FAILED` row for a migration is
 * therefore never counted as applied — an unresolved highest migration
 * simply falls back to whatever real version below it IS applied, which
 * this build's MIN/MAX range then judges on its own merits), same
 * numeric-prefix range comparison. Takes an already-open connection
 * (`readiness.ts`'s own short-lived `mysql2` connection, into the SAME
 * database the shared ledger lives in) rather than opening a second one.
 */
export async function checkSharedSchemaCompatibility(
  conn: mysql.Connection,
): Promise<SharedSchemaCompatibilityResult> {
  const [tableRows] = await conn.query<mysql.RowDataPacket[]>(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1",
    [SHARED_SCHEMA_MIGRATIONS_TABLE],
  );
  if (tableRows.length === 0) {
    return {
      compatible: false,
      highestAppliedVersion: null,
      detail: `shared ${SHARED_SCHEMA_MIGRATIONS_TABLE} table does not exist -- run the Self-bot migrator ('up') first`,
    };
  }

  const [appliedRows] = await conn.query<mysql.RowDataPacket[]>(
    `SELECT version FROM ${SHARED_SCHEMA_MIGRATIONS_TABLE} WHERE state = 'APPLIED'`,
  );
  if (appliedRows.length === 0) {
    return {
      compatible: false,
      highestAppliedVersion: null,
      detail: `shared ${SHARED_SCHEMA_MIGRATIONS_TABLE} shows no applied migrations -- run the Self-bot migrator ('up') first`,
    };
  }

  const versions = (appliedRows as { version: string }[])
    .map((row) => row.version)
    .sort((a, b) => versionPrefix(a).localeCompare(versionPrefix(b)));
  const highest = versions[versions.length - 1]!;
  const highestPrefix = versionPrefix(highest);

  if (highestPrefix < SUPPORTED_SHARED_SCHEMA_MIN) {
    return {
      compatible: false,
      highestAppliedVersion: highest,
      detail:
        `highest applied shared migration ${highestPrefix} is below this Dashboard build's ` +
        `supported minimum ${SUPPORTED_SHARED_SCHEMA_MIN} -- run the Self-bot migrator ('up')`,
    };
  }

  if (highestPrefix > SUPPORTED_SHARED_SCHEMA_MAX) {
    return {
      compatible: false,
      highestAppliedVersion: highest,
      detail:
        `highest applied shared migration ${highestPrefix} exceeds this Dashboard build's ` +
        `supported maximum ${SUPPORTED_SHARED_SCHEMA_MAX} -- upgrade the Dashboard before this schema`,
    };
  }

  return {
    compatible: true,
    highestAppliedVersion: highest,
    detail: `shared schema compatible (highest applied migration: ${highest})`,
  };
}
