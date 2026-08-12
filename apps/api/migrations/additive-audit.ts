/**
 * Static safety checks for Dashboard migration files (ADR-011):
 *   1. Additive-only: no DROP TABLE/COLUMN/INDEX, no MODIFY/CHANGE COLUMN.
 *   2. Ownership boundary: every CREATE TABLE name must be Dashboard-owned
 *      (dashboard_* prefix, or the explicit non-prefixed allowlist from
 *      25_DATA_MODEL.md's DASHBOARD-OWNED table list) — this migrator must
 *      never create a shared table (that's the Self-bot repo's canonical
 *      migrator's job).
 *
 * Mirrors 01_NEW_SELF_BOTS/tests/test_migrations_additive_audit.py's intent,
 * reimplemented for this repo's own (currently empty) ledger.
 */
import { splitStatements } from "./runner.js";

const FORBIDDEN_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "DROP TABLE", re: /^\s*DROP\s+TABLE\b/i },
  { name: "DROP COLUMN", re: /ALTER\s+TABLE\s+`?\w+`?\s+DROP\s+COLUMN\b/i },
  { name: "DROP INDEX", re: /^\s*DROP\s+INDEX\b/i },
  { name: "ALTER TABLE ... DROP (constraint/key)", re: /ALTER\s+TABLE\s+`?\w+`?\s+DROP\b/i },
  { name: "MODIFY COLUMN", re: /ALTER\s+TABLE\s+`?\w+`?\s+MODIFY\b/i },
  { name: "CHANGE COLUMN", re: /ALTER\s+TABLE\s+`?\w+`?\s+CHANGE\b/i },
];

const CREATE_TABLE_RE = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/i;

/**
 * Non-`dashboard_`-prefixed tables that are nonetheless Dashboard-owned, per
 * 25_DATA_MODEL.md's DASHBOARD-OWNED table list and ADR-011's explicit
 * allowlist carve-out.
 */
export const DASHBOARD_OWNED_ALLOWLIST = [
  "upload_sessions",
  "upload_items",
  "badge_definitions",
  "badge_awards",
  "hero_discovery_decisions",
  "hero_discovery_config",
];

export interface AuditViolation {
  file: string;
  statementPreview: string;
  reason: string;
}

export function auditMigrationContent(fileName: string, sqlText: string): AuditViolation[] {
  const violations: AuditViolation[] = [];
  for (const statement of splitStatements(sqlText)) {
    for (const { name, re } of FORBIDDEN_PATTERNS) {
      if (re.test(statement)) {
        violations.push({
          file: fileName,
          statementPreview: statement.slice(0, 120),
          reason: `Non-additive statement (${name}) is forbidden in the Dashboard migration ledger.`,
        });
      }
    }
    const createMatch = CREATE_TABLE_RE.exec(statement);
    if (createMatch) {
      const table = createMatch[1]!;
      const isAllowed = table.startsWith("dashboard_") || DASHBOARD_OWNED_ALLOWLIST.includes(table);
      if (!isAllowed) {
        violations.push({
          file: fileName,
          statementPreview: statement.slice(0, 120),
          reason:
            `CREATE TABLE \`${table}\` is not Dashboard-owned (no dashboard_ prefix, not in the ` +
            "explicit allowlist). Shared tables are migrated exclusively by the Self-bot repo's " +
            "canonical migrator (ADR-011) — this file must not create one.",
        });
      }
    }
  }
  return violations;
}
