// i18n usage gate: no dangling `t()` references, no silent dead weight.
//
// Implements DASHBOARD/19_I18N_FR_EN_DE.md §Enforcement item 2: "a script
// cross-references every `t('...')`/`message_key` literal found via a static scan of
// `apps/web` and `apps/api` source against the key set - flags keys defined but never
// referenced (dead weight) as a warning, and any `t()` call whose key doesn't exist in
// all 3 locales as a hard failure."
//
// Hard failure  = a referenced key missing from ANY of the three catalogs.
// Warning       = a defined key nothing references (per the doc's own wording).
//
// Template literals (`t(\`common.status.${tone}\`)`) are recognised as a wildcard
// prefix rather than ignored, so a data-driven key family is neither a false
// "unknown key" nor a false "orphan".

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SUPPORTED_LOCALES, type BccLocale } from "../src/i18n/locales.js";
import { I18N_NAMESPACES } from "../src/i18n/namespaces.js";
import { lintI18nCatalogs, splitPluralKey } from "./lint-i18n.js";

const SCANNED_ROOTS = [
  path.join("apps", "web", "src"),
  path.join("apps", "api", "src"),
  // `packages/shared` holds the tone -> label-key tables that screens resolve
  // through (see src/constants/status.ts), so its own references count too.
  path.join("packages", "shared", "src"),
] as const;

const SCANNED_EXTENSIONS = new Set([".ts", ".tsx"]);

/**
 * Prefixes whose keys are resolved from data that does not exist in the frontend
 * source at all, so a static scan can never see a reference:
 * `errors.*` keys arrive as the `message_key` field of a backend error envelope
 * (19_I18N_FR_EN_DE.md §Backend error contract), chosen by `apps/api` route code and
 * by the bots, not written literally in a component.
 */
const DYNAMICALLY_RESOLVED_PREFIXES = ["errors."] as const;

export interface UsageReport {
  errors: string[];
  warnings: string[];
  referencedKeyCount: number;
  definedKeyCount: number;
  orphanKeys: string[];
}

function repoRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function collectSourceFiles(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") {
        continue;
      }
      files.push(...collectSourceFiles(full));
    } else if (SCANNED_EXTENSIONS.has(path.extname(entry))) {
      files.push(full);
    }
  }
  return files;
}

export interface KeyReference {
  key: string;
  /** True for `t(\`prefix.${x}\`)` — matches any defined key under `prefix.`. */
  isPrefix: boolean;
  file: string;
}

const STATIC_PATTERNS: readonly RegExp[] = [
  // t("key") / t('key')  — also matches i18n.t(...) and tFoo is excluded by \b(t)\(
  /(?<![\w$])t\(\s*(["'])([^"'\n]+)\1/g,
  // <Trans i18nKey="key">
  /i18nKey\s*=\s*(?:\{\s*)?(["'])([^"'\n]+)\1/g,
  // labelKey: "key" / labelKey="key" / message_key: "key" / messageKey: "key"
  /\b(?:labelKey|message_key|messageKey|descriptionKey|titleKey)\s*[:=]\s*(?:\{\s*)?(["'])([^"'\n]+)\1/g,
];

// t(`common.status.${tone}`) -> prefix "common.status."
const TEMPLATE_PATTERN = /(?<![\w$])t\(\s*`([^`$]*)\$\{/g;

/**
 * Any string literal anchored on a canonical namespace and shaped like a dotted key
 * counts as a reference, wherever it appears. This is what catches key *tables* -
 * `STATUS_TONE_LABEL_KEYS` in packages/shared/src/constants/status.ts maps tones to
 * `"common.status.*"` strings that a screen later hands to `StatusBadge`, so the
 * reference exists in the table, not at a `t()` call site. Anchoring on the namespace
 * list keeps this from matching arbitrary dotted strings (versions, file paths).
 */
function buildNamespaceAnchoredPattern(): RegExp {
  const alternation = I18N_NAMESPACES.join("|");
  return new RegExp(`(["'\`])((?:${alternation})(?:\\.[A-Za-z][\\w-]*)+)\\1`, "g");
}

const NAMESPACE_ANCHORED_PATTERN = buildNamespaceAnchoredPattern();

export function extractReferences(source: string, file: string): KeyReference[] {
  const references: KeyReference[] = [];
  for (const match of source.matchAll(NAMESPACE_ANCHORED_PATTERN)) {
    references.push({ key: match[2]!, isPrefix: false, file });
  }
  for (const pattern of STATIC_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const key = match[2]!;
      // Skip obvious non-keys (URLs, sentences, formats) — a real key is dotted
      // identifiers only. This keeps `t(someVariable)` and stray matches out.
      if (/^[A-Za-z][\w-]*(\.[A-Za-z][\w-]*)*$/.test(key)) {
        references.push({ key, isPrefix: false, file });
      }
    }
  }
  for (const match of source.matchAll(TEMPLATE_PATTERN)) {
    const prefix = match[1]!;
    if (prefix.length > 0) {
      references.push({ key: prefix, isPrefix: true, file });
    }
  }
  return references;
}

function definedLogicalKeys(dir: string): { keys: Set<string>; perLocale: Map<BccLocale, Set<string>> } {
  const perLocale = new Map<BccLocale, Set<string>>();
  for (const locale of SUPPORTED_LOCALES) {
    const raw: unknown = JSON.parse(readFileSync(path.join(dir, `${locale}.json`), "utf-8"));
    const keys = new Set<string>();
    const walk = (value: unknown, prefix: string): void => {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          walk(child, prefix ? `${prefix}.${key}` : key);
        }
        return;
      }
      keys.add(splitPluralKey(prefix).logical);
    };
    walk(raw, "");
    perLocale.set(locale, keys);
  }
  const union = new Set<string>();
  for (const keys of perLocale.values()) {
    for (const key of keys) {
      union.add(key);
    }
  }
  return { keys: union, perLocale };
}

export function lintI18nUsage(root: string = repoRoot()): UsageReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const catalogDir = path.join(root, "packages", "shared", "src", "i18n");

  // A structurally broken catalog makes every downstream conclusion unreliable.
  const catalogReport = lintI18nCatalogs(catalogDir);
  if (catalogReport.errors.length > 0) {
    return {
      errors: [
        `catalog lint must pass before usage can be checked (${catalogReport.errors.length} catalog error(s)).`,
      ],
      warnings,
      referencedKeyCount: 0,
      definedKeyCount: 0,
      orphanKeys: [],
    };
  }

  const { keys: defined, perLocale } = definedLogicalKeys(catalogDir);

  const references: KeyReference[] = [];
  for (const relativeRoot of SCANNED_ROOTS) {
    for (const file of collectSourceFiles(path.join(root, relativeRoot))) {
      references.push(...extractReferences(readFileSync(file, "utf-8"), path.relative(root, file)));
    }
  }

  const referencedExact = new Set<string>();
  const referencedPrefixes = new Set<string>();

  for (const reference of references) {
    if (reference.isPrefix) {
      referencedPrefixes.add(reference.key);
      const anyMatch = [...defined].some((key) => key.startsWith(reference.key));
      if (!anyMatch) {
        errors.push(
          `${reference.file}: dynamic key prefix "${reference.key}" matches no key in any locale catalog.`,
        );
      }
      continue;
    }
    referencedExact.add(reference.key);
    const missingIn = SUPPORTED_LOCALES.filter((locale) => !perLocale.get(locale)!.has(reference.key));
    if (missingIn.length === SUPPORTED_LOCALES.length) {
      errors.push(`${reference.file}: t("${reference.key}") refers to a key that no locale defines.`);
    } else if (missingIn.length > 0) {
      errors.push(
        `${reference.file}: t("${reference.key}") is missing from ${missingIn.join(", ")} — a key must exist in all 3 locales.`,
      );
    }
  }

  const orphanKeys = [...defined]
    .filter((key) => !referencedExact.has(key))
    .filter((key) => ![...referencedPrefixes].some((prefix) => key.startsWith(prefix)))
    .filter((key) => !DYNAMICALLY_RESOLVED_PREFIXES.some((prefix) => key.startsWith(prefix)))
    .sort();

  for (const key of orphanKeys) {
    warnings.push(`"${key}" is defined in all locales but never referenced (dead weight).`);
  }

  return {
    errors,
    warnings,
    referencedKeyCount: referencedExact.size,
    definedKeyCount: defined.size,
    orphanKeys,
  };
}

export function runCli(argv: readonly string[]): number {
  const rootIndex = argv.indexOf("--root");
  const root = rootIndex === -1 ? repoRoot() : path.resolve(argv[rootIndex + 1] ?? ".");
  const report = lintI18nUsage(root);
  for (const warning of report.warnings) {
    console.warn(`[i18n-usage] WARN ${warning}`);
  }
  for (const error of report.errors) {
    console.error(`[i18n-usage] ERROR ${error}`);
  }
  if (report.errors.length > 0) {
    console.error(`[i18n-usage] FAILED — ${report.errors.length} dangling key reference(s).`);
    return 1;
  }
  console.log(
    `[i18n-usage] OK — ${report.referencedKeyCount} referenced key(s) all resolve in fr, en, de; ${report.definedKeyCount} defined key(s); ${report.orphanKeys.length} unreferenced (warning only).`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runCli(process.argv.slice(2)));
}
