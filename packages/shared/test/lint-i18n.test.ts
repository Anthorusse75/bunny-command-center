// The i18n gate, proven NEGATIVELY.
//
// 02_design_system_i18n.md §ACCEPTANCE CRITERIA: "i18n CI gate fails intentionally when a key
// is removed from only one locale (prove the gate actually catches the case it exists for)".
//
// Every case below is built by copying the real catalogs into a fresh temp directory and
// applying one specific mutation there. The committed catalogs are never touched - a gate
// proven by editing the thing it guards would leave the repo in an unknown state if the test
// crashed halfway.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractPlaceholders,
  lintI18nCatalogs,
  requiredPluralCategories,
  splitPluralKey,
} from "../scripts/lint-i18n.js";

const REAL_CATALOG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "i18n");

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "bcc-i18n-gate-"));
  cpSync(REAL_CATALOG_DIR, sandbox, { recursive: true });
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function load(locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(sandbox, `${locale}.json`), "utf-8")) as Record<string, unknown>;
}

function save(locale: string, data: unknown): void {
  writeFileSync(path.join(sandbox, `${locale}.json`), JSON.stringify(data, null, 2), "utf-8");
}

function errors(): string[] {
  return lintI18nCatalogs(sandbox).errors;
}

describe("the real committed catalogs", () => {
  it("pass the gate", () => {
    const report = lintI18nCatalogs(REAL_CATALOG_DIR);
    expect(report.errors).toEqual([]);
    expect(report.logicalKeyCount).toBeGreaterThan(50);
    expect(report.pluralKeys.length).toBeGreaterThan(0);
  });

  it("pass it through the untouched copy too (the sandbox itself is not broken)", () => {
    expect(errors()).toEqual([]);
  });
});

describe("a key removed from only one locale", () => {
  it("fails, naming the locale and the key", () => {
    const fr = load("fr");
    delete (fr["common"] as Record<string, unknown>)["lastUpdated"];
    save("fr", fr);

    const found = errors();
    expect(found.length).toBeGreaterThan(0);
    expect(found.join("\n")).toContain('[fr] missing key "common.lastUpdated"');
  });

  it("fails for a key added to only one locale as well, naming who has it", () => {
    const de = load("de");
    (de["common"] as Record<string, unknown>)["somethingOnlyGerman"] = "Nur auf Deutsch";
    save("de", de);
    const found = errors().join("\n");
    // Union-based comparison: the locales that LACK the key are the ones reported, and the
    // message says where it does exist.
    expect(found).toContain('[fr] missing key "common.somethingOnlyGerman" (present in de.json)');
    expect(found).toContain('[en] missing key "common.somethingOnlyGerman" (present in de.json)');
  });
});

describe("a whole namespace dropped from one locale", () => {
  it("fails even though an empty namespace contributes zero keys", () => {
    // This is the case a leaf-only key-set diff cannot see at all.
    const de = load("de");
    delete de["upload"];
    save("de", de);

    const found = errors().join("\n");
    expect(found).toContain("[de]");
    expect(found).toContain("upload");
    expect(found).toMatch(/missing namespace\/section|canonical namespace/);
  });
});

describe("malformed JSON", () => {
  it("fails with the parse error rather than crashing the run", () => {
    writeFileSync(path.join(sandbox, "de.json"), '{ "app": { "title": "x" ', "utf-8");
    const found = errors();
    expect(found.length).toBeGreaterThan(0);
    expect(found.join("\n")).toMatch(/\[de\].*is not valid JSON/);
  });

  it("fails when a catalog file is missing entirely", () => {
    rmSync(path.join(sandbox, "fr.json"));
    expect(errors().join("\n")).toMatch(/\[fr\] cannot read/);
  });
});

describe("structural breakage that presence checks alone would miss", () => {
  it("fails on an empty translation value", () => {
    const en = load("en");
    (en["common"] as Record<string, unknown>)["lastUpdated"] = "   ";
    save("en", en);
    expect(errors().join("\n")).toContain("is empty");
  });

  it("fails when a value is not a string", () => {
    const en = load("en");
    (en["common"] as Record<string, unknown>)["lastUpdated"] = 42;
    save("en", en);
    expect(errors().join("\n")).toMatch(/must be a string or an object/);
  });

  it("fails when a locale turns a leaf into a section", () => {
    const de = load("de");
    (de["common"] as Record<string, unknown>)["lastUpdated"] = { nested: "oops" };
    save("de", de);
    expect(errors().length).toBeGreaterThan(0);
  });

  it("fails when a locale drops an interpolation placeholder", () => {
    const de = load("de");
    (de["errors"] as Record<string, Record<string, string>>)["upload"]!["fileTooLarge"] =
      "Diese Datei ist zu groß.";
    save("de", de);
    expect(errors().join("\n")).toContain("drops the interpolation placeholder(s) {{maxMb}}");
  });

  it("fails when a locale invents a placeholder nothing will supply", () => {
    const de = load("de");
    (de["errors"] as Record<string, Record<string, string>>)["upload"]!["fileTooLarge"] =
      "Limit {{maxMb}} MB für {{guildName}}.";
    save("de", de);
    expect(errors().join("\n")).toContain("introduces the interpolation placeholder(s) {{guildName}}");
  });
});

describe("plural-form validation is CLDR-driven, not count-based", () => {
  it("knows FR needs three cardinal categories and EN/DE two", () => {
    expect(requiredPluralCategories("fr")).toEqual(["many", "one", "other"]);
    expect(requiredPluralCategories("en")).toEqual(["one", "other"]);
    expect(requiredPluralCategories("de")).toEqual(["one", "other"]);
  });

  it("accepts the real catalogs even though FR has a form EN/DE do not", () => {
    // The exact case a naive key-set diff would reject: fr.json legitimately carries
    // `common.screenshotCount_many`, which en.json and de.json must NOT have.
    const fr = load("fr");
    expect(Object.keys(fr["common"] as Record<string, unknown>)).toContain("screenshotCount_many");
    const en = load("en");
    expect(Object.keys(en["common"] as Record<string, unknown>)).not.toContain("screenshotCount_many");
    expect(errors()).toEqual([]);
  });

  it("fails when a locale is missing a plural form its own language requires", () => {
    const fr = load("fr");
    delete (fr["common"] as Record<string, unknown>)["screenshotCount_many"];
    save("fr", fr);
    expect(errors().join("\n")).toContain('is missing the "_many" form(s) required for fr');
  });

  it("fails when a locale declares a plural form its language does not use", () => {
    const de = load("de");
    (de["common"] as Record<string, unknown>)["screenshotCount_many"] = "{{count}} Screenshots";
    save("de", de);
    expect(errors().join("\n")).toContain('declares "_many", which de does not use');
  });
});

describe("helpers", () => {
  it("splits plural suffixes without mangling ordinary keys", () => {
    expect(splitPluralKey("common.screenshotCount_other")).toEqual({
      logical: "common.screenshotCount",
      category: "other",
    });
    expect(splitPluralKey("common.actions.save")).toEqual({
      logical: "common.actions.save",
      category: null,
    });
    // A key that merely ends in a category-like word is not a plural form.
    expect(splitPluralKey("common.other")).toEqual({ logical: "common.other", category: null });
  });

  it("extracts placeholder names, ignoring formatting suffixes", () => {
    expect([...extractPlaceholders("Limit {{maxMb}} MB, {{ count }} files")]).toEqual(["maxMb", "count"]);
    expect([...extractPlaceholders("no placeholders here")]).toEqual([]);
  });
});
