/**
 * Step 10 external-review correction round, Section 9 — the real "Season &
 * quotas" model: `{ acceptPlatformDefaults: boolean, quotaOverrides: {
 * gcHero?, gcTitan?, hol?, hero?, titan? } }` (packages/shared/src/types/lifecycle.ts),
 * replacing the prior fake category-string shape that had no numeric value
 * at all.
 *
 * Canonical defaults VERIFIED LIVE via
 * `01_NEW_SELF_BOTS/database/migrations/0014_guild_config_selfbot_legacy_fields.up.sql`
 * (copied verbatim from `src/core/config.py`'s `ConfigManager.DEFAULT_CONFIG`):
 * `nb_gc_hero=912, nb_gc_titan=380, nb_hol=600, nb_hero=1200, nb_titan=600`.
 */
import type { OnboardingSectionSaveRequest } from "@bunny-command-center/shared";

export type SeasonQuotasData = Extract<
  OnboardingSectionSaveRequest,
  { section: "seasonQuotas" }
>["data"];

export interface EffectiveQuotas {
  readonly gcHero: number;
  readonly gcTitan: number;
  readonly hol: number;
  readonly hero: number;
  readonly titan: number;
}

/** The 5 canonical, confirmed-live platform defaults — see this module's header comment for the exact source. */
export const CANONICAL_QUOTA_DEFAULTS: EffectiveQuotas = {
  gcHero: 912,
  gcTitan: 380,
  hol: 600,
  hero: 1200,
  titan: 600,
};

export function hasAnyQuotaOverride(data: SeasonQuotasData): boolean {
  return Object.keys(data.quotaOverrides).length > 0;
}

/** Effective quota = the canonical default + any explicit override. */
export function computeEffectiveQuotas(data: SeasonQuotasData): EffectiveQuotas {
  return {
    gcHero: data.quotaOverrides.gcHero ?? CANONICAL_QUOTA_DEFAULTS.gcHero,
    gcTitan: data.quotaOverrides.gcTitan ?? CANONICAL_QUOTA_DEFAULTS.gcTitan,
    hol: data.quotaOverrides.hol ?? CANONICAL_QUOTA_DEFAULTS.hol,
    hero: data.quotaOverrides.hero ?? CANONICAL_QUOTA_DEFAULTS.hero,
    titan: data.quotaOverrides.titan ?? CANONICAL_QUOTA_DEFAULTS.titan,
  };
}
