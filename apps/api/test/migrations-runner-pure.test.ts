import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checksumOf, discoverMigrations, numericPrefix, splitStatements } from "../migrations/runner.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "migrations");

describe("runner pure functions", () => {
  it("splitStatements drops comment lines and splits on top-level ;", () => {
    const sql = "-- a comment\nCREATE TABLE t (id INT);\n-- another\nALTER TABLE t ADD COLUMN x INT;";
    expect(splitStatements(sql)).toEqual(["CREATE TABLE t (id INT)", "ALTER TABLE t ADD COLUMN x INT"]);
  });

  it("checksumOf is deterministic and content-sensitive", () => {
    const a = checksumOf("CREATE TABLE t (id INT);");
    const b = checksumOf("CREATE TABLE t (id INT);");
    const c = checksumOf("CREATE TABLE t (id INT, x INT);");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("numericPrefix extracts the leading zero-padded number", () => {
    expect(numericPrefix("0001_foo")).toBe(1);
    expect(numericPrefix("0014_bar")).toBe(14);
  });

  it("discoverMigrations returns fixture pairs sorted in numeric order", () => {
    const migrations = discoverMigrations(FIXTURES_DIR);
    expect(migrations.map((m) => m.version)).toEqual([
      "0001_create_dashboard_test_probe",
      "0002_add_dashboard_test_probe_note",
    ]);
  });

  it("discoverMigrations returns an empty array for a directory with no .up.sql files", () => {
    expect(discoverMigrations(path.join(FIXTURES_DIR, "..", "does-not-exist"))).toEqual([]);
  });
});
