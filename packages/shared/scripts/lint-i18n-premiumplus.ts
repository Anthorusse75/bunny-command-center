// PremiumPlus copy-safety gate (D-050).
//
// 13_PREMIUMPLUS_AND_STOCK.md §Messaging Rules: "The UI must never imply 'PremiumPlus reached
// => stop.' [...] i18n lint rule (D-050): a CI script scans every `premiumplus.*` i18n key
// across all 3 locales for a denylist of stop-implying terms/patterns [...] and fails the build
// if found without an adjacent whitelisted continuation phrase." The same rule applies to
// `upload.priority.*` (same document, §"Priority now" banner: "same messaging-rule lint applies
// to `upload.priority.*` keys").
//
// 02_design_system_i18n.md assigns building this gate to Step 02 ("PremiumPlus copy lint rule
// [...] Read the real wording rules before implementing them [...] Add isolated positive and
// negative fixtures proving the rule. No PremiumPlus feature screen is built now."). Both
// namespaces are still empty objects at this point in the build (`premiumplus.*` and
// `upload.priority.*` copy belongs to Step 13/17) - this gate is dormant today by construction,
// not by omission, and starts enforcing the moment either namespace gains real strings.
//
// The denylist/whitelist term lists below are the exact examples the document gives, not an
// exhaustive canonical list - 13_PREMIUMPLUS_AND_STOCK.md gives illustrative terms per language
// ("e.g. FR: ..., EN: ..., DE: ...") rather than a closed set. Extending either list is expected
// as real `premiumplus.*`/`upload.priority.*` copy gets written in later steps.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SUPPORTED_LOCALES, type BccLocale } from "../src/i18n/locales.js";

const GATED_PREFIXES = ["premiumplus", "upload.priority"] as const;

interface DenylistTerm {
  /** Human-readable label for error messages. */
  label: string;
  pattern: RegExp;
}

/** 13_PREMIUMPLUS_AND_STOCK.md §Messaging Rules, item 2 - the exact terms it lists, per locale. */
const DENYLIST: Record<BccLocale, DenylistTerm[]> = {
  fr: [
    { label: '"arrêt"', pattern: /\barrêts?\b/iu },
    { label: '"terminé" (closing sense)', pattern: /\bterminée?s?\b/iu },
    // French almost always elides "ne" to "n'" before a vowel ("n'avez plus", not "ne avez
    // plus"), so the literal "ne plus" from the document's example is only one of the surface
    // forms - "plus besoin" ("no longer needed") is the other everyday phrasing of the same
    // negation and is exactly the EN "no longer needed" analogue two rows below.
    { label: '"ne plus"/"plus besoin"', pattern: /\bne\s+plus\b|\bn['’]\w+\s+plus\b|\bplus\s+besoin\b/iu },
  ],
  en: [
    { label: '"stop"', pattern: /\bstop(s|ped|ping)?\b/iu },
    { label: '"no longer needed"', pattern: /\bno longer needed\b/iu },
    { label: '"done" (unqualified)', pattern: /\bdone\b/iu },
  ],
  de: [
    { label: '"beenden"', pattern: /\bbeenden\b/iu },
    { label: '"nicht mehr nötig"', pattern: /\bnicht mehr nötig\b/iu },
  ],
};

/**
 * Continuation phrases the document's own approved copy pattern uses: "forward-looking
 * contribution prompt", the "stock-for-future-seasons" callout, and the "priority now" banner's
 * mandatory "all screenshots remain useful" clause. A denylist hit next to one of these is the
 * accomplishment-plus-continuation pattern the document requires, not a stop message.
 */
const CONTINUATION_WHITELIST: Record<BccLocale, RegExp[]> = {
  fr: [/reste(nt)?\s+utiles?/iu, /continu(ez|ons|er)?\s+(à|de)\s+contribuer/iu, /saisons?\s+futures?/iu],
  en: [/remain(s)?\s+useful/iu, /keep\s+(on\s+)?contributing/iu, /future\s+seasons?/iu],
  de: [/bleiben?\s+nützlich/iu, /weiter(hin)?\s+(beitragen|hilfreich)/iu, /zukünftige?\s+saisons?/iu],
};

export interface PremiumPlusLintReport {
  errors: string[];
  scannedKeyCount: number;
}

function defaultCatalogDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "i18n");
}

function isGatedKey(key: string): boolean {
  return GATED_PREFIXES.some((prefix) => key === prefix || key.startsWith(`${prefix}.`));
}

function collectGatedLeaves(value: unknown, prefix: string, into: Map<string, string>): void {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      collectGatedLeaves(child, prefix ? `${prefix}.${key}` : key, into);
    }
    return;
  }
  if (typeof value === "string" && isGatedKey(prefix)) {
    into.set(prefix, value);
  }
}

export function lintPremiumPlusCopy(dir: string = defaultCatalogDir()): PremiumPlusLintReport {
  const errors: string[] = [];
  let scannedKeyCount = 0;

  for (const locale of SUPPORTED_LOCALES) {
    const filePath = path.join(dir, `${locale}.json`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch (cause) {
      errors.push(`[${locale}] cannot read/parse ${filePath}: ${(cause as Error).message}`);
      continue;
    }

    const gated = new Map<string, string>();
    collectGatedLeaves(parsed, "", gated);
    scannedKeyCount += gated.size;

    for (const [key, value] of gated) {
      for (const term of DENYLIST[locale]) {
        if (!term.pattern.test(value)) {
          continue;
        }
        const hasContinuation = CONTINUATION_WHITELIST[locale].some((phrase) => phrase.test(value));
        if (!hasContinuation) {
          errors.push(
            `[${locale}] "${key}" contains stop-implying language (${term.label}) with no adjacent ` +
              `continuation phrase: "${value}" (13_PREMIUMPLUS_AND_STOCK.md §Messaging Rules, D-050).`,
          );
        }
      }
    }
  }

  return { errors, scannedKeyCount };
}

function parseDirArg(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--dir");
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  if (!value) {
    throw new Error("--dir requires a path argument.");
  }
  return path.resolve(value);
}

export function runCli(argv: readonly string[]): number {
  const dir = parseDirArg(argv) ?? defaultCatalogDir();
  const report = lintPremiumPlusCopy(dir);
  for (const error of report.errors) {
    console.error(`[i18n-premiumplus] ERROR ${error}`);
  }
  if (report.errors.length > 0) {
    console.error(`[i18n-premiumplus] FAILED — ${report.errors.length} violation(s) in ${dir}.`);
    return 1;
  }
  console.log(
    `[i18n-premiumplus] OK — ${report.scannedKeyCount} gated key(s) under ${GATED_PREFIXES.join(", ")} ` +
      `across ${SUPPORTED_LOCALES.join(", ")}, none violate D-050.`,
  );
  return 0;
}

// See lint-i18n.ts for why this is `pathToFileURL(...).href`, not a hand-rolled `file://` compare.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runCli(process.argv.slice(2)));
}
