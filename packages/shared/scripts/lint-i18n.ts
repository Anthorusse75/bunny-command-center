// i18n catalog gate (hard merge gate, not a style guide).
//
// Implements DASHBOARD/19_I18N_FR_EN_DE.md §Enforcement item 1 ("Key completeness")
// plus the structural checks that item 1 alone would miss, and
// 00_GLOBAL_IMPLEMENTATION_RULES.md #12 ("the CI i18n-completeness check is a hard
// merge gate, not a follow-up task").
//
// Why this is not a key-count comparison:
//  * Plural forms legitimately differ per locale. `Intl.PluralRules` gives FR three
//    cardinal categories (one/many/other) and EN/DE two (one/other), so a naive
//    key-set diff would fail on a *correct* catalog. This script compares LOGICAL
//    keys (plural suffixes normalised away) and then separately asserts each locale
//    provides exactly the CLDR categories that locale actually needs.
//  * An empty namespace object (`"upload": {}`) contributes zero leaf keys, so a
//    leaf-only diff cannot notice a namespace being dropped from one locale. Container
//    paths are therefore compared as their own set, and the canonical namespace list
//    is asserted present in every locale.
//  * A key whose value is `""` passes any presence check while shipping a blank
//    string to the user, so empty/whitespace-only values are a hard failure.
//  * A missing interpolation placeholder (`{{maxMb}}` present in EN, absent in DE)
//    passes every presence check and silently drops information, so placeholder sets
//    are compared across locales too.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { I18N_NAMESPACES } from "../src/i18n/namespaces.js";
import { SUPPORTED_LOCALES, type BccLocale } from "../src/i18n/locales.js";

const PLURAL_SEPARATOR = "_";
/** Every CLDR cardinal category i18next can emit as a suffix. */
const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"] as const;

export interface LintReport {
  errors: string[];
  warnings: string[];
  logicalKeyCount: number;
  containerCount: number;
  pluralKeys: string[];
}

interface Catalog {
  /** leaf path -> string value */
  leaves: Map<string, string>;
  /** every object path, including empty objects */
  containers: Set<string>;
}

function defaultCatalogDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "i18n");
}

function walk(value: unknown, prefix: string, catalog: Catalog, errors: string[], locale: string): void {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    catalog.containers.add(prefix);
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walk(child, prefix ? `${prefix}.${key}` : key, catalog, errors, locale);
    }
    return;
  }
  if (typeof value !== "string") {
    errors.push(
      `[${locale}] "${prefix}" must be a string or an object, got ${Array.isArray(value) ? "array" : String(value === null ? "null" : typeof value)}.`,
    );
    return;
  }
  if (value.trim().length === 0) {
    errors.push(`[${locale}] "${prefix}" is empty — an untranslated key is a hole, not a translation.`);
    return;
  }
  catalog.leaves.set(prefix, value);
}

function readCatalog(dir: string, locale: BccLocale, errors: string[]): Catalog | null {
  const filePath = path.join(dir, `${locale}.json`);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    errors.push(`[${locale}] cannot read ${filePath}.`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    errors.push(`[${locale}] ${filePath} is not valid JSON: ${(cause as Error).message}`);
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    errors.push(`[${locale}] ${filePath} must contain a JSON object at the top level.`);
    return null;
  }
  const catalog: Catalog = { leaves: new Map(), containers: new Set() };
  walk(parsed, "", catalog, errors, locale);
  catalog.containers.delete("");
  return catalog;
}

/** `common.screenshotCount_other` -> `{ logical: "common.screenshotCount", category: "other" }` */
export function splitPluralKey(key: string): { logical: string; category: string | null } {
  for (const category of PLURAL_CATEGORIES) {
    const suffix = `${PLURAL_SEPARATOR}${category}`;
    if (key.endsWith(suffix) && key.length > suffix.length) {
      return { logical: key.slice(0, -suffix.length), category };
    }
  }
  return { logical: key, category: null };
}

export function requiredPluralCategories(locale: BccLocale): string[] {
  return [...new Intl.PluralRules(locale).resolvedOptions().pluralCategories].sort();
}

export function extractPlaceholders(value: string): Set<string> {
  const found = new Set<string>();
  for (const match of value.matchAll(/\{\{\s*([^}\s,]+)[^}]*\}\}/g)) {
    found.add(match[1]!);
  }
  return found;
}

interface LogicalEntry {
  /** null for a non-plural key, otherwise the set of categories present. */
  categories: Set<string> | null;
  placeholders: Set<string>;
}

function toLogicalEntries(catalog: Catalog): Map<string, LogicalEntry> {
  const entries = new Map<string, LogicalEntry>();
  for (const [key, value] of catalog.leaves) {
    const { logical, category } = splitPluralKey(key);
    let entry = entries.get(logical);
    if (!entry) {
      entry = { categories: category ? new Set() : null, placeholders: new Set() };
      entries.set(logical, entry);
    }
    if (category) {
      entry.categories ??= new Set();
      entry.categories.add(category);
    }
    for (const placeholder of extractPlaceholders(value)) {
      entry.placeholders.add(placeholder);
    }
  }
  return entries;
}

export function lintI18nCatalogs(dir: string = defaultCatalogDir()): LintReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  const catalogs = new Map<BccLocale, Catalog>();
  for (const locale of SUPPORTED_LOCALES) {
    const catalog = readCatalog(dir, locale, errors);
    if (catalog) {
      catalogs.set(locale, catalog);
    }
  }
  if (catalogs.size !== SUPPORTED_LOCALES.length) {
    // Parity comparisons are meaningless if a catalog failed to load at all.
    return { errors, warnings, logicalKeyCount: 0, containerCount: 0, pluralKeys: [] };
  }

  const logical = new Map<BccLocale, Map<string, LogicalEntry>>();
  for (const [locale, catalog] of catalogs) {
    logical.set(locale, toLogicalEntries(catalog));
  }

  // Compared against the UNION of all locales, not against a designated reference locale.
  // With a reference locale, deleting a key from that one locale reports as "the other two have
  // an extra key", which points a reviewer at the wrong files. The union makes the message name
  // the locale that is actually missing something, and the locale(s) that still have it.
  const allKeys = new Map<string, BccLocale[]>();
  const allContainers = new Map<string, BccLocale[]>();
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of logical.get(locale)!.keys()) {
      allKeys.set(key, [...(allKeys.get(key) ?? []), locale]);
    }
    for (const container of catalogs.get(locale)!.containers) {
      allContainers.set(container, [...(allContainers.get(container) ?? []), locale]);
    }
  }

  /** Placeholder union per logical key, used as the parity target below. */
  const allPlaceholders = new Map<string, Set<string>>();
  for (const locale of SUPPORTED_LOCALES) {
    for (const [key, entry] of logical.get(locale)!) {
      const union = allPlaceholders.get(key) ?? new Set<string>();
      for (const name of entry.placeholders) {
        union.add(name);
      }
      allPlaceholders.set(key, union);
    }
  }

  for (const locale of SUPPORTED_LOCALES) {
    const entries = logical.get(locale)!;
    const containers = catalogs.get(locale)!.containers;

    for (const [key, presentIn] of allKeys) {
      if (!entries.has(key)) {
        errors.push(
          `[${locale}] missing key "${key}" (present in ${presentIn.map((other) => `${other}.json`).join(", ")}).`,
        );
      }
    }
    for (const [container, presentIn] of allContainers) {
      if (!containers.has(container)) {
        errors.push(
          `[${locale}] missing namespace/section "${container}" (present in ${presentIn.map((other) => `${other}.json`).join(", ")}) — even an empty section must exist in every locale.`,
        );
      }
    }

    // A leaf in one locale and a section in another is a structural mismatch that
    // the two loops above would report as "missing key" without saying why.
    for (const key of entries.keys()) {
      if (containers.has(key)) {
        errors.push(`[${locale}] "${key}" is both a section and a translation value.`);
      }
    }

    for (const namespace of I18N_NAMESPACES) {
      if (!containers.has(namespace)) {
        errors.push(
          `[${locale}] canonical namespace "${namespace}" is absent (19_I18N_FR_EN_DE.md §Key structure).`,
        );
      }
    }

    const required = requiredPluralCategories(locale);
    for (const [key, entry] of entries) {
      // A key is pluralised if ANY locale gives it plural forms - so a locale that forgot the
      // suffixes entirely is still held to its own CLDR requirement rather than skipped.
      const isPlural = SUPPORTED_LOCALES.some(
        (other) =>
          logical.get(other)!.get(key)?.categories !== null &&
          logical.get(other)!.get(key)?.categories !== undefined,
      );
      if (isPlural) {
        const present = [...(entry.categories ?? [])].sort();
        const missing = required.filter((category) => !present.includes(category));
        const unexpected = present.filter((category) => !required.includes(category));
        if (missing.length > 0) {
          errors.push(
            `[${locale}] pluralised key "${key}" is missing the ${missing.map((c) => `"${PLURAL_SEPARATOR}${c}"`).join(", ")} form(s) required for ${locale} by Intl.PluralRules.`,
          );
        }
        if (unexpected.length > 0) {
          errors.push(
            `[${locale}] pluralised key "${key}" declares ${unexpected.map((c) => `"${PLURAL_SEPARATOR}${c}"`).join(", ")}, which ${locale} does not use.`,
          );
        }
      }

      const expectedPlaceholders = allPlaceholders.get(key) ?? new Set<string>();
      const missingPlaceholders = [...expectedPlaceholders].filter((name) => !entry.placeholders.has(name));
      if (missingPlaceholders.length > 0) {
        const othersWithIt = SUPPORTED_LOCALES.filter(
          (other) =>
            other !== locale &&
            missingPlaceholders.some((name) => logical.get(other)!.get(key)?.placeholders.has(name)),
        );
        errors.push(
          `[${locale}] "${key}" drops the interpolation placeholder(s) ${missingPlaceholders.map((n) => `{{${n}}}`).join(", ")} used in ${othersWithIt.map((other) => `${other}.json`).join(", ")}.`,
        );
      }
      // A placeholder only ONE locale uses is equally broken: nothing will supply it. Reported
      // against that locale, since it is the outlier.
      const soleOwner = [...entry.placeholders].filter((name) =>
        SUPPORTED_LOCALES.every(
          (other) => other === locale || !logical.get(other)!.get(key)?.placeholders.has(name),
        ),
      );
      if (soleOwner.length > 0 && SUPPORTED_LOCALES.length > 1) {
        errors.push(
          `[${locale}] "${key}" introduces the interpolation placeholder(s) ${soleOwner.map((n) => `{{${n}}}`).join(", ")} absent from the other locales — nothing will supply them.`,
        );
      }
    }

    // Single-brace `{foo}` is the Bunny legacy dashboard's flat-dictionary syntax
    // (ADR-014 §Context) and does nothing in i18next; flag it rather than fail, since
    // a literal brace in copy is legitimate.
    for (const [key, value] of catalogs.get(locale)!.leaves) {
      if (/(^|[^{])\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value)) {
        warnings.push(
          `[${locale}] "${key}" contains a single-brace placeholder; i18next interpolation uses {{double}} braces.`,
        );
      }
    }
  }

  const pluralKeys = [...allKeys.keys()]
    .filter((key) => SUPPORTED_LOCALES.some((locale) => logical.get(locale)!.get(key)?.categories != null))
    .sort();

  return {
    errors,
    warnings,
    logicalKeyCount: allKeys.size,
    containerCount: allContainers.size,
    pluralKeys,
  };
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
  const report = lintI18nCatalogs(dir);
  for (const warning of report.warnings) {
    console.warn(`[i18n] WARN ${warning}`);
  }
  for (const error of report.errors) {
    console.error(`[i18n] ERROR ${error}`);
  }
  if (report.errors.length > 0) {
    console.error(
      `[i18n] FAILED — ${report.errors.length} error(s) across ${SUPPORTED_LOCALES.join(", ")} in ${dir}.`,
    );
    return 1;
  }
  console.log(
    `[i18n] OK — ${report.logicalKeyCount} logical key(s) and ${report.containerCount} section(s) identical across ${SUPPORTED_LOCALES.join(", ")}; ${report.pluralKeys.length} pluralised key(s) validated against Intl.PluralRules (${report.pluralKeys.join(", ") || "none"}).`,
  );
  return 0;
}

// `import.meta.url === \`file://${process.argv[1]}\`` silently evaluates false on
// Windows (the drive letter needs a third slash), which would make this script a
// no-op when run directly - pathToFileURL is the portable comparison.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runCli(process.argv.slice(2)));
}
