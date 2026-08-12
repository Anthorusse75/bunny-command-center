/**
 * Dashboard's own first-party migration runner (ADR-011). Owns ONLY
 * Dashboard-exclusive tables (see 25_DATA_MODEL.md's DASHBOARD-OWNED list) —
 * it never touches a shared table, and it is the ONLY thing in this repo
 * allowed to run DDL (00_GLOBAL_IMPLEMENTATION_RULES.md: "no runtime DDL
 * outside the migrator").
 *
 * Deliberately mirrors 01_NEW_SELF_BOTS/database/migrate.py's safety
 * discipline (numbered up/down SQL pairs, checksummed ledger, statement-level
 * crash journaling, STARTED-state blocks progress without --force-retry) —
 * see DASHBOARD/IMPLEMENTATION/01_foundations_and_scaffolding.md's
 * "reuse its conventions, don't reinvent style" instruction.
 *
 * One deliberate addition beyond the self-bot migrator: this runner refuses
 * to proceed if an ALREADY-APPLIED migration's on-disk checksum no longer
 * matches what's recorded in the ledger, for ANY state (not just STARTED) —
 * the self-bot migrator does not enforce this (`up.py` only ever recomputes
 * the checksum for STARTED-state retries). This is required by Step 01's
 * mandatory checksum-mismatch-rejection test and is a strictly stronger
 * safety property, not a divergent one.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import type { MigratorDbConfig } from "./config.js";
import { DASHBOARD_MIGRATION_LEDGER_TABLE } from "../src/db/constants.js";

export interface Migration {
  version: string;
  description: string;
  upPath: string;
  downPath: string;
}

export type LedgerState = "STARTED" | "APPLIED" | "FAILED";

export interface LedgerRow {
  version: string;
  checksum: string;
  state: LedgerState;
  last_statement_index: number | null;
  last_statement_preview: string | null;
  started_at: Date;
  applied_at: Date | null;
}

const VERSION_PREFIX_RE = /^(\d+)_?/;

export function numericPrefix(version: string): number {
  const match = VERSION_PREFIX_RE.exec(version);
  return match ? Number(match[1]) : 0;
}

export function discoverMigrations(migrationsDir: string): Migration[] {
  if (!existsSync(migrationsDir)) {
    return [];
  }
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".up.sql"));
  const migrations = files.map((file): Migration => {
    const version = file.slice(0, -".up.sql".length);
    const description = version.includes("_") ? version.split("_").slice(1).join(" ") : version;
    return {
      version,
      description,
      upPath: path.join(migrationsDir, `${version}.up.sql`),
      downPath: path.join(migrationsDir, `${version}.down.sql`),
    };
  });
  return migrations.sort((a, b) => {
    const diff = numericPrefix(a.version) - numericPrefix(b.version);
    return diff !== 0 ? diff : a.version.localeCompare(b.version);
  });
}

/**
 * Drops whole-line `--` comments, then splits on top-level `;`. Same
 * pragmatic approach as the self-bot migrator: hand-authored DDL files, no
 * stored procedures or complex string literals.
 */
export function splitStatements(sqlText: string): string[] {
  const keptLines = sqlText.split("\n").filter((line) => !line.trim().startsWith("--"));
  return keptLines
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function checksumOf(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

const LEDGER_TABLE = DASHBOARD_MIGRATION_LEDGER_TABLE;

const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
  version VARCHAR(64) NOT NULL,
  checksum CHAR(64) NOT NULL,
  description VARCHAR(255) NULL,
  state VARCHAR(16) NOT NULL DEFAULT 'STARTED',
  started_at DATETIME(6) NOT NULL,
  finished_at DATETIME(6) NULL,
  applied_at DATETIME(6) NULL,
  applied_by VARCHAR(128) NULL,
  duration_ms INT UNSIGNED NULL,
  success BOOLEAN NULL,
  last_statement_index INT UNSIGNED NULL,
  last_statement_preview VARCHAR(255) NULL,
  error_detail VARCHAR(2000) NULL,
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

export async function connect(config: MigratorDbConfig): Promise<mysql.Connection> {
  return mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    multipleStatements: false,
  });
}

export async function bootstrapLedger(conn: mysql.Connection): Promise<void> {
  await conn.query(SCHEMA_MIGRATIONS_DDL);
}

export async function loadLedgerStates(conn: mysql.Connection): Promise<Map<string, LedgerRow>> {
  const [rows] = await conn.query<mysql.RowDataPacket[]>(
    `SELECT version, checksum, state, last_statement_index, last_statement_preview, started_at, applied_at
     FROM ${LEDGER_TABLE}`,
  );
  const map = new Map<string, LedgerRow>();
  for (const row of rows) {
    map.set(row.version as string, row as unknown as LedgerRow);
  }
  return map;
}

function sanitizeError(err: unknown, secrets: string[]): string {
  let message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  for (const secret of secrets) {
    if (secret) {
      message = message.split(secret).join("***");
    }
  }
  return message.slice(0, 2000);
}

async function journalStarted(
  conn: mysql.Connection,
  migration: Migration,
  checksum: string,
  startedAt: Date,
): Promise<void> {
  await conn.query(
    `INSERT INTO ${LEDGER_TABLE}
       (version, checksum, description, state, started_at,
        finished_at, applied_at, applied_by, duration_ms, success,
        last_statement_index, last_statement_preview, error_detail)
     VALUES (?, ?, ?, 'STARTED', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
     ON DUPLICATE KEY UPDATE
       checksum = VALUES(checksum),
       description = VALUES(description),
       state = 'STARTED',
       started_at = VALUES(started_at),
       finished_at = NULL, applied_at = NULL, applied_by = NULL,
       duration_ms = NULL, success = NULL,
       last_statement_index = NULL, last_statement_preview = NULL,
       error_detail = NULL`,
    [migration.version, checksum, migration.description, startedAt],
  );
}

async function journalProgress(
  conn: mysql.Connection,
  version: string,
  index: number,
  preview: string,
): Promise<void> {
  await conn.query(
    `UPDATE ${LEDGER_TABLE} SET last_statement_index = ?, last_statement_preview = ? WHERE version = ?`,
    [index, preview, version],
  );
}

async function journalFailed(
  conn: mysql.Connection,
  version: string,
  index: number,
  preview: string,
  errorDetail: string,
): Promise<void> {
  await conn.query(
    `UPDATE ${LEDGER_TABLE}
     SET state = 'FAILED', finished_at = NOW(6), success = 0,
         last_statement_index = ?, last_statement_preview = ?, error_detail = ?
     WHERE version = ?`,
    [index, preview, errorDetail.slice(0, 2000), version],
  );
}

async function journalApplied(
  conn: mysql.Connection,
  version: string,
  durationMs: number,
  appliedBy: string,
): Promise<void> {
  await conn.query(
    `UPDATE ${LEDGER_TABLE}
     SET state = 'APPLIED', finished_at = NOW(6), applied_at = NOW(6), applied_by = ?, duration_ms = ?, success = 1
     WHERE version = ?`,
    [appliedBy, durationMs, version],
  );
}

export async function applyMigration(
  conn: mysql.Connection,
  migration: Migration,
  appliedBy: string,
  secrets: string[],
): Promise<{ ok: boolean; error?: string }> {
  const content = readFileSync(migration.upPath, "utf-8");
  const checksum = checksumOf(content);
  const startedAt = new Date();

  await journalStarted(conn, migration, checksum, startedAt);

  const statements = splitStatements(content);
  const t0 = Date.now();
  for (let index = 0; index < statements.length; index++) {
    const statement = statements[index]!;
    const preview = statement.slice(0, 255);
    try {
      await conn.query(statement);
    } catch (err) {
      const errorDetail = sanitizeError(err, secrets);
      await journalFailed(conn, migration.version, index, preview, errorDetail);
      return { ok: false, error: errorDetail };
    }
    await journalProgress(conn, migration.version, index, preview);
  }

  const durationMs = Date.now() - t0;
  await journalApplied(conn, migration.version, durationMs, appliedBy);
  return { ok: true };
}

export interface UpResult {
  ok: boolean;
  message: string;
  applied: string[];
  skipped: string[];
}

export async function runUp(
  conn: mysql.Connection,
  migrationsDir: string,
  config: MigratorDbConfig,
  opts: { forceRetry?: boolean } = {},
): Promise<UpResult> {
  const migrations = discoverMigrations(migrationsDir);
  const applied: string[] = [];
  const skipped: string[] = [];

  await bootstrapLedger(conn);
  const states = await loadLedgerStates(conn);

  const started = [...states.values()].filter((row) => row.state === "STARTED");
  if (started.length > 0 && !opts.forceRetry) {
    return {
      ok: false,
      message:
        "Refusing to proceed: a previous run left migration(s) in state STARTED " +
        `(${started.map((r) => r.version).join(", ")}). Inspect the real DB state manually, ` +
        "then re-run with --force-retry once confirmed safe.",
      applied,
      skipped,
    };
  }

  for (const migration of migrations) {
    const row = states.get(migration.version);
    if (row) {
      const content = readFileSync(migration.upPath, "utf-8");
      const currentChecksum = checksumOf(content);
      if (currentChecksum !== row.checksum) {
        return {
          ok: false,
          message:
            `CHECKSUM MISMATCH for ${migration.version}: recorded=${row.checksum} ` +
            `current=${currentChecksum}. This migration file was modified after being applied. ` +
            "Refusing to continue — never silently re-apply or accept a changed migration.",
          applied,
          skipped,
        };
      }
      if (row.state === "APPLIED") {
        skipped.push(migration.version);
        continue;
      }
      if ((row.state === "FAILED" || row.state === "STARTED") && !opts.forceRetry) {
        return {
          ok: false,
          message: `Migration ${migration.version} is in state ${row.state}; use --force-retry to retry it.`,
          applied,
          skipped,
        };
      }
    }

    const result = await applyMigration(conn, migration, config.user, [config.password]);
    if (!result.ok) {
      return { ok: false, message: `[${migration.version}] FAILED: ${result.error}`, applied, skipped };
    }
    applied.push(migration.version);
  }

  return { ok: true, message: "All migrations applied.", applied, skipped };
}

export async function applyDown(
  conn: mysql.Connection,
  migration: Migration,
  secrets: string[],
): Promise<{ ok: boolean; error?: string }> {
  if (!existsSync(migration.downPath)) {
    return { ok: false, error: `No down migration file found at ${migration.downPath}` };
  }
  const content = readFileSync(migration.downPath, "utf-8");
  const statements = splitStatements(content);
  for (const statement of statements) {
    try {
      await conn.query(statement);
    } catch (err) {
      return { ok: false, error: sanitizeError(err, secrets) };
    }
  }
  await conn.query(`DELETE FROM ${LEDGER_TABLE} WHERE version = ?`, [migration.version]);
  return { ok: true };
}

export interface DownResult {
  ok: boolean;
  message: string;
  reverted: string[];
}

export async function runDown(
  conn: mysql.Connection,
  migrationsDir: string,
  config: MigratorDbConfig,
  opts: { toVersion?: string | undefined } = {},
): Promise<DownResult> {
  await bootstrapLedger(conn);
  const migrationsByVersion = new Map(discoverMigrations(migrationsDir).map((m) => [m.version, m]));

  const [rows] = await conn.query<mysql.RowDataPacket[]>(
    `SELECT version FROM ${LEDGER_TABLE} WHERE state = 'APPLIED'`,
  );
  const appliedVersions = rows
    .map((r) => r.version as string)
    .sort((a, b) => numericPrefix(b) - numericPrefix(a));

  const toRevert = opts.toVersion
    ? appliedVersions.filter((v) => numericPrefix(v) > numericPrefix(opts.toVersion!))
    : appliedVersions;

  if (toRevert.length === 0) {
    return { ok: true, message: "Nothing to revert.", reverted: [] };
  }

  const reverted: string[] = [];
  for (const version of toRevert) {
    const migration = migrationsByVersion.get(version);
    if (!migration) {
      return {
        ok: false,
        message: `No migration file found for applied version ${version}; aborting teardown.`,
        reverted,
      };
    }
    const result = await applyDown(conn, migration, [config.password]);
    if (!result.ok) {
      return { ok: false, message: `[${version}] DOWN FAILED: ${result.error}`, reverted };
    }
    reverted.push(version);
  }

  return { ok: true, message: "Down migration(s) complete.", reverted };
}

export interface StatusRow {
  version: string;
  state: string;
  appliedAt: Date | null;
}

export async function runStatus(conn: mysql.Connection, migrationsDir: string): Promise<StatusRow[]> {
  await bootstrapLedger(conn);
  const migrations = discoverMigrations(migrationsDir);
  const states = await loadLedgerStates(conn);
  return migrations.map((m) => {
    const row = states.get(m.version);
    return { version: m.version, state: row?.state ?? "not yet applied", appliedAt: row?.applied_at ?? null };
  });
}

export { LEDGER_TABLE };
