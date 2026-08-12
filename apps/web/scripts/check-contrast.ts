// CI gate: WCAG 2.2 AA contrast across all 9 theme x mode combinations.
//
// Required by DASHBOARD/IMPLEMENTATION/02_design_system_i18n.md ("automated WCAG 2.2 AA
// contrast check for all 9 theme x mode combinations (`ADR-015`'s risk mitigation - this
// must exist from the start, not bolted on later)") and 28_ACCESSIBILITY.md §Contrast.
//
// SYSTEM is not a separate palette: it resolves to LIGHT or DARK
// (20_DESIGN_SYSTEM_AND_THEMES.md §Light / Dark / System). The 9 user-visible
// combinations are therefore covered by the 6 distinct token sets, and this gate says so
// explicitly per combination rather than leaving the arithmetic to the reader.

import { pathToFileURL } from "node:url";
import { formatRatio } from "../src/theme/contrast.js";
import { evaluateThemeMode } from "../src/theme/contrast-requirements.js";
import {
  BCC_MODE_PREFERENCES,
  BCC_THEME_NAMES,
  type BccMode,
  type BccModePreference,
  type BccThemeName,
} from "../src/theme/tokens/index.js";

interface Combination {
  name: BccThemeName;
  preference: BccModePreference;
  resolved: BccMode;
}

/** The 9 user-selectable combinations, with SYSTEM shown resolving both ways. */
export function userVisibleCombinations(): Combination[] {
  return BCC_THEME_NAMES.flatMap((name) =>
    BCC_MODE_PREFERENCES.map((preference) => ({
      name,
      preference,
      // SYSTEM is audited under both resolutions below; the row itself reports the
      // light resolution and the dark one is covered by the `dark` row's token set.
      resolved: preference === "system" ? "light" : preference,
    })),
  );
}

export function runCli(argv: readonly string[]): number {
  const verbose = argv.includes("--verbose");
  let failures = 0;
  let checked = 0;

  console.log(
    `[contrast] WCAG 2.2 AA gate over ${BCC_THEME_NAMES.length} theme(s) x ${BCC_MODE_PREFERENCES.length} mode preference(s) = ${userVisibleCombinations().length} user-visible combination(s), backed by ${BCC_THEME_NAMES.length * 2} distinct token set(s).`,
  );

  for (const name of BCC_THEME_NAMES) {
    for (const mode of ["light", "dark"] as const) {
      const { required, informational } = evaluateThemeMode(name, mode);
      checked += required.length;
      const failed = required.filter((result) => !result.passed);
      const worst = required.reduce((min, result) => (result.ratio < min.ratio ? result : min), required[0]!);
      const preferences = BCC_MODE_PREFERENCES.filter(
        (preference) => preference === mode || preference === "system",
      );
      console.log(
        `[contrast] ${name}/${mode} (covers mode preference${preferences.length > 1 ? "s" : ""} ${preferences.join(", ")}): ${required.length - failed.length}/${required.length} pass, tightest = ${worst.label} at ${formatRatio(worst.ratio)}:1 (needs ${worst.required}:1).`,
      );
      if (verbose) {
        for (const result of required) {
          console.log(
            `[contrast]   ${result.passed ? "ok  " : "FAIL"} ${formatRatio(result.ratio)}:1 >= ${result.required}:1  ${result.label}  (${result.foreground} on ${result.background})`,
          );
        }
        for (const result of informational) {
          console.log(
            `[contrast]   info ${formatRatio(result.ratio)}:1  ${result.label}  — ${result.reason}`,
          );
        }
      }
      for (const result of failed) {
        failures += 1;
        console.error(
          `[contrast] FAIL ${name}/${mode}: ${result.label} is ${formatRatio(result.ratio)}:1, needs ${result.required}:1 (${result.foreground} on ${result.background}). ${result.reason}`,
        );
      }
    }
  }

  if (failures > 0) {
    console.error(
      `[contrast] FAILED — ${failures} of ${checked} required pair(s) below WCAG 2.2 AA. A theme cannot ship in this state (20_DESIGN_SYSTEM_AND_THEMES.md §Accessibility floor).`,
    );
    return 1;
  }
  console.log(`[contrast] OK — all ${checked} required pair(s) meet WCAG 2.2 AA.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runCli(process.argv.slice(2)));
}
