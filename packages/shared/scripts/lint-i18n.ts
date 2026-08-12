// Fails CI if the FR/EN/DE locale catalogs don't expose exactly the same set
// of keys (00_GLOBAL_IMPLEMENTATION_RULES.md #12: i18n completeness is a hard
// merge gate, not a follow-up task).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const LOCALES = ["fr", "en", "de"] as const;
const i18nDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "i18n");

function flattenKeys(obj: unknown, prefix = ""): string[] {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return [prefix];
  }
  return Object.entries(obj as Record<string, unknown>).flatMap(([key, value]) =>
    flattenKeys(value, prefix ? `${prefix}.${key}` : key),
  );
}

function loadKeys(locale: string): Set<string> {
  const filePath = path.join(i18nDir, `${locale}.json`);
  const raw = readFileSync(filePath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  return new Set(flattenKeys(parsed));
}

function main(): void {
  const keySets = new Map(LOCALES.map((locale) => [locale, loadKeys(locale)]));
  const reference = keySets.get(LOCALES[0])!;
  let hasError = false;

  for (const locale of LOCALES) {
    const keys = keySets.get(locale)!;
    const missing = [...reference].filter((key) => !keys.has(key));
    const extra = [...keys].filter((key) => !reference.has(key));
    if (missing.length > 0) {
      hasError = true;
      console.error(`[i18n] ${locale}.json is missing keys: ${missing.join(", ")}`);
    }
    if (locale !== LOCALES[0] && extra.length > 0) {
      hasError = true;
      console.error(`[i18n] ${locale}.json has keys not present in ${LOCALES[0]}.json: ${extra.join(", ")}`);
    }
  }

  if (hasError) {
    console.error("[i18n] Locale catalogs are not in sync.");
    process.exit(1);
  }

  console.log(`[i18n] OK — ${reference.size} key(s) present and identical across ${LOCALES.join(", ")}.`);
}

main();
