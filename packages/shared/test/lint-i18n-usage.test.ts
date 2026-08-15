// The usage gate: dangling `t()` references fail, unreferenced keys warn.
//
// 19_I18N_FR_EN_DE.md §Enforcement item 2. Proven negatively on a sandboxed copy of the repo's
// scanned roots, never against the real source tree.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractReferences, lintI18nUsage } from "../scripts/lint-i18n-usage.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let sandbox: string;

/** A minimal repo skeleton: real catalogs, plus a scanned source root we control. */
beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "bcc-i18n-usage-"));
  const catalogDir = path.join(sandbox, "packages", "shared", "src", "i18n");
  mkdirSync(catalogDir, { recursive: true });
  cpSync(path.join(REPO_ROOT, "packages", "shared", "src", "i18n"), catalogDir, { recursive: true });
  mkdirSync(path.join(sandbox, "apps", "web", "src"), { recursive: true });
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function writeSource(relative: string, contents: string): void {
  const full = path.join(sandbox, "apps", "web", "src", relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf-8");
}

describe("the real repository", () => {
  it("has no dangling key references", () => {
    const report = lintI18nUsage(REPO_ROOT);
    expect(report.errors).toEqual([]);
    expect(report.referencedKeyCount).toBeGreaterThan(20);
  });
});

describe("dangling references are a hard failure", () => {
  it("fails on a key no locale defines", () => {
    writeSource("Widget.tsx", `export const x = t("common.thisKeyDoesNotExist");`);
    const report = lintI18nUsage(sandbox);
    expect(report.errors.join("\n")).toContain("common.thisKeyDoesNotExist");
  });

  it("fails on a key that exists in only some locales", () => {
    // Give EN and DE a key FR lacks, then reference it. The catalog gate notices the parity
    // break first (and says so), which is itself the correct behaviour: a half-defined key is
    // never allowed to reach the "is it referenced?" question.
    for (const locale of ["en", "de"]) {
      const target = path.join(sandbox, "packages", "shared", "src", "i18n", `${locale}.json`);
      const data = JSON.parse(readFileSync(target, "utf-8")) as Record<string, Record<string, unknown>>;
      data["common"]!["halfDefined"] = "value";
      writeFileSync(target, JSON.stringify(data, null, 2), "utf-8");
    }
    writeSource("Widget.tsx", `export const x = t("common.halfDefined");`);
    const report = lintI18nUsage(sandbox);
    expect(report.errors.length).toBeGreaterThan(0);
  });

  it("fails on a dynamic key prefix that matches nothing", () => {
    writeSource("Widget.tsx", "export const x = t(`common.nosuchgroup.${tone}`);");
    expect(lintI18nUsage(sandbox).errors.join("\n")).toContain("common.nosuchgroup.");
  });

  it("refuses to draw conclusions while the catalogs themselves are broken", () => {
    writeFileSync(path.join(sandbox, "packages", "shared", "src", "i18n", "de.json"), "{ broken", "utf-8");
    const report = lintI18nUsage(sandbox);
    expect(report.errors.join("\n")).toContain("catalog lint must pass");
  });
});

describe("unreferenced keys are a warning, not a failure", () => {
  it("reports dead weight without failing the build", () => {
    writeSource("Widget.tsx", `export const x = t("common.actions.save");`);
    const report = lintI18nUsage(sandbox);
    expect(report.errors).toEqual([]);
    expect(report.orphanKeys).toContain("common.actions.cancel");
    expect(report.orphanKeys).not.toContain("common.actions.save");
    expect(report.warnings.some((warning) => warning.includes("common.actions.cancel"))).toBe(true);
  });

  it("does not flag backend-driven error keys, which no frontend literal can reference", () => {
    writeSource("Widget.tsx", `export const x = t("common.actions.save");`);
    const report = lintI18nUsage(sandbox);
    expect(report.orphanKeys.filter((key) => key.startsWith("errors."))).toEqual([]);
  });

  it("treats a dynamic prefix as covering its whole key family", () => {
    writeSource("Badge.tsx", "export const x = t(`common.status.${tone}`);");
    const report = lintI18nUsage(sandbox);
    expect(report.orphanKeys.filter((key) => key.startsWith("common.status."))).toEqual([]);
  });
});

describe("reference extraction", () => {
  it("recognises the call shapes the codebase actually uses", () => {
    const source = [
      `const a = t("common.actions.save");`,
      `const b = t('a11y.skipToContent');`,
      `<Trans i18nKey="showcase.title" />`,
      `const d = { labelKey: "common.status.error" };`,
      `const e = { message_key: "errors.generic" };`,
      "const f = t(`common.theme.${name}`);",
      `const table = { success: "common.status.success" };`,
    ].join("\n");
    const keys = extractReferences(source, "x.tsx");
    const exact = keys.filter((reference) => !reference.isPrefix).map((reference) => reference.key);
    expect(exact).toContain("common.actions.save");
    expect(exact).toContain("a11y.skipToContent");
    expect(exact).toContain("showcase.title");
    expect(exact).toContain("common.status.error");
    expect(exact).toContain("errors.generic");
    // A key table entry counts as a reference even with no `t()` around it - this is how
    // STATUS_TONE_LABEL_KEYS is seen.
    expect(exact).toContain("common.status.success");
    expect(keys.filter((reference) => reference.isPrefix).map((reference) => reference.key)).toContain(
      "common.theme.",
    );
  });

  it("does not mistake ordinary strings for keys", () => {
    const keys = extractReferences(
      `const url = "https://example.com/a.b"; const msg = t("Hello world.");`,
      "x.tsx",
    );
    expect(keys.map((reference) => reference.key)).not.toContain("Hello world.");
  });
});
