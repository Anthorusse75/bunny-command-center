// The D-050 PremiumPlus copy-safety gate, proven NEGATIVELY and POSITIVELY.
//
// 02_design_system_i18n.md: "Add isolated positive and negative fixtures proving the rule."
// Every case below copies the real catalogs into a fresh temp directory and mutates only the
// copy - the committed catalogs (still empty `premiumplus`/`upload.priority` namespaces at this
// point in the build) are never touched.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lintPremiumPlusCopy } from "../scripts/lint-i18n-premiumplus.js";

const REAL_CATALOG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "i18n");

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "bcc-premiumplus-gate-"));
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
  return lintPremiumPlusCopy(sandbox).errors;
}

describe("the real committed catalogs", () => {
  it("pass the gate (both gated namespaces are still empty placeholders)", () => {
    const report = lintPremiumPlusCopy(REAL_CATALOG_DIR);
    expect(report.errors).toEqual([]);
    expect(report.scannedKeyCount).toBe(0);
  });
});

describe("negative fixtures — stop-implying copy with no continuation clause", () => {
  it("fails on English 'stop'", () => {
    const en = load("en");
    (en["premiumplus"] as Record<string, unknown>)["reached"] = { headline: "Uploads stop here." };
    save("en", en);
    expect(errors().join("\n")).toContain('[en] "premiumplus.reached.headline"');
  });

  it("fails on French 'ne plus'", () => {
    const fr = load("fr");
    (fr["premiumplus"] as Record<string, unknown>)["reached"] = {
      headline: "Vous n'avez plus besoin d'envoyer de captures.",
    };
    save("fr", fr);
    expect(errors().join("\n")).toContain('[fr] "premiumplus.reached.headline"');
  });

  it("fails on German 'beenden'", () => {
    const de = load("de");
    (de["premiumplus"] as Record<string, unknown>)["reached"] = { headline: "Bitte Uploads beenden." };
    save("de", de);
    expect(errors().join("\n")).toContain('[de] "premiumplus.reached.headline"');
  });

  it("fails on the same denylist applied to upload.priority.*", () => {
    const en = load("en");
    (en["upload"] as Record<string, unknown>)["priority"] = { banner: "Stop uploading Titans." };
    save("en", en);
    expect(errors().join("\n")).toContain('[en] "upload.priority.banner"');
  });

  it("fails on unqualified English 'done'", () => {
    const en = load("en");
    (en["premiumplus"] as Record<string, unknown>)["reached"] = { headline: "Titans quota done." };
    save("en", en);
    expect(errors().join("\n")).toContain('[en] "premiumplus.reached.headline"');
  });
});

describe("positive fixtures — the same terms, next to the document's own continuation pattern", () => {
  it("passes English 'stop' when a 'remains useful' clause is adjacent", () => {
    const en = load("en");
    (en["premiumplus"] as Record<string, unknown>)["reached"] = {
      headline:
        "Monthly goal reached! You can stop worrying about the quota — every extra screenshot still remains useful for future seasons.",
    };
    save("en", en);
    expect(errors()).toEqual([]);
  });

  it("passes French 'terminé' when followed by a forward-looking clause", () => {
    const fr = load("fr");
    (fr["premiumplus"] as Record<string, unknown>)["reached"] = {
      headline: "Objectif du mois terminé ! Vos captures restent utiles pour les saisons futures.",
    };
    save("fr", fr);
    expect(errors()).toEqual([]);
  });

  it("passes the exact 'Priority now' banner clause from 13_PREMIUMPLUS_AND_STOCK.md", () => {
    const en = load("en");
    (en["upload"] as Record<string, unknown>)["priority"] = {
      banner: "Priority now: Titans — we need more Titan captures today. All your screenshots remain useful.",
    };
    save("en", en);
    expect(errors()).toEqual([]);
  });

  it("passes copy that never uses a denylisted term at all", () => {
    const de = load("de");
    (de["premiumplus"] as Record<string, unknown>)["reached"] = {
      headline: "Monatsziel erreicht! Danke für eure Beiträge.",
    };
    save("de", de);
    expect(errors()).toEqual([]);
  });
});
