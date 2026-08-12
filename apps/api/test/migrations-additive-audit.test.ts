import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditMigrationContent } from "../migrations/additive-audit.js";

const REAL_MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

describe("additive-audit static checker", () => {
  it("flags DROP TABLE as non-additive", () => {
    const violations = auditMigrationContent("synthetic.up.sql", "DROP TABLE dashboard_widgets;");
    expect(violations).toHaveLength(1);
    expect(violations[0]!.reason).toMatch(/DROP TABLE/);
  });

  it("flags MODIFY COLUMN as non-additive", () => {
    const violations = auditMigrationContent(
      "synthetic.up.sql",
      "ALTER TABLE dashboard_widgets MODIFY COLUMN label VARCHAR(16) NOT NULL;",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]!.reason).toMatch(/MODIFY COLUMN/);
  });

  it("flags CREATE TABLE for a non-Dashboard-owned (shared-looking) table name", () => {
    const violations = auditMigrationContent(
      "synthetic.up.sql",
      "CREATE TABLE capture_cases (id CHAR(26) NOT NULL, PRIMARY KEY (id));",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]!.reason).toMatch(/not Dashboard-owned/);
  });

  it("allows an additive CREATE TABLE with the dashboard_ prefix", () => {
    const violations = auditMigrationContent(
      "synthetic.up.sql",
      "CREATE TABLE dashboard_widgets (id INT NOT NULL AUTO_INCREMENT, PRIMARY KEY (id));",
    );
    expect(violations).toEqual([]);
  });

  it("allows the explicit non-prefixed Dashboard-owned allowlist (e.g. upload_sessions)", () => {
    const violations = auditMigrationContent(
      "synthetic.up.sql",
      "CREATE TABLE upload_sessions (id CHAR(26) NOT NULL, PRIMARY KEY (id));",
    );
    expect(violations).toEqual([]);
  });

  it("allows a purely additive ALTER TABLE ADD COLUMN", () => {
    const violations = auditMigrationContent(
      "synthetic.up.sql",
      "ALTER TABLE dashboard_widgets ADD COLUMN note VARCHAR(128) NULL;",
    );
    expect(violations).toEqual([]);
  });

  it("the REAL committed ledger (apps/api/migrations/*.up.sql) has zero violations", () => {
    const files = readdirSync(REAL_MIGRATIONS_DIR).filter((f) => f.endsWith(".up.sql"));
    const allViolations = files.flatMap((file) =>
      auditMigrationContent(file, readFileSync(path.join(REAL_MIGRATIONS_DIR, file), "utf-8")),
    );
    expect(allViolations).toEqual([]);
  });
});
