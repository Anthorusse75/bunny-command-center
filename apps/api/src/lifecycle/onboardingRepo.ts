/**
 * Onboarding stepper persistence (Step 10, IMPLEMENTATION/10_onboarding_approval.md,
 * SCREENS/ONBOARDING.md). Two layers, deliberately kept distinct:
 *
 *  1. `dashboard_guild_onboarding_progress.sections_json` (migration 0013) —
 *     the LIVE, order-independent edit buffer every section's auto-save
 *     writes to. This is what makes "jump to any section, any order, no
 *     forced sequence" (mission §12) actually work: several of the real
 *     SHARED sub-tables this data eventually lands in have NOT NULL columns
 *     this step's sections don't individually cover in isolation (e.g.
 *     `guild_config_selfbot.herowarbot_channel_id` is NOT NULL, but
 *     SCREENS/ONBOARDING.md lets a Guild Admin fill in "Community channel"
 *     before "Hero channel") — a real SQL row for that sub-table cannot
 *     exist validly until enough fields are known, so the JSON buffer is the
 *     one place that's ALWAYS immediately write-able regardless of order.
 *
 *  2. The real `guild_configuration_versions` + sub-tables (SHARED,
 *     Self-bot-repo migration authority) — MATERIALIZED from the buffer at
 *     `request-activation` time (`activationRequestsService.ts`), once the
 *     server-side minimum-checklist re-validation has already confirmed
 *     enough fields are known to form a genuinely valid row. This is also
 *     exactly the mechanism the TOCTOU snapshot design needs: once a
 *     version has been materialized and referenced by a non-terminal
 *     `dashboard_guild_activation_requests` row, any FURTHER section save
 *     must rotate onto a NEW draft version rather than mutate the
 *     already-submitted one in place (`rotateDraftIfSubmitted` below) —
 *     `10_GUILD_ONBOARDING_AND_APPROVAL.md`: "the edit creates a new DRAFT
 *     ... it does not touch
 *     dashboard_guild_activation_requests.submitted_config_version_id."
 *
 * ** Explicit, disclosed scope decision ** (00_GLOBAL_IMPLEMENTATION_RULES.md
 * rule 1): this step does not build Step 12's full versioned-config editor —
 * only enough of `guild_configuration_versions`'s mechanism for the 7
 * onboarding sections, per IMPLEMENTATION/10_onboarding_approval.md's own
 * "coordinate scope carefully with Step 12's owner" instruction. Concretely:
 * this step never introduces new `guild_configuration_versions.state`
 * values beyond `DRAFT`/`ACTIVE`/`SUPERSEDED` (no validation sub-states —
 * Step 12's real workflow may need more), and the "Season & quotas"/
 * "Notifications" sections do not yet have a fully real backing store (see
 * `ONBOARDING_NOTIFICATION_POLICY_IS_PROVISIONAL` below and migration
 * 0013's own header comment).
 */
import { sql, type Kysely, type Transaction } from "kysely";
import type { DB } from "../db/codegen-types.js";
import { bindBigIntUnsigned } from "../db/bigIntParam.js";
import type { OnboardingSectionKey, OnboardingSectionSaveRequest } from "@bunny-command-center/shared";
import { ONBOARDING_SECTION_KEYS } from "@bunny-command-center/shared";
import {
  computeMaterializedConfigChecksum,
  type MaterializedConfigValues,
} from "./configChecksum.js";

export type Executor = Kysely<DB> | Transaction<DB>;

/**
 * Thrown by `materializeDraftConfigVersion` on the real concurrency race
 * documented at its `guild_configuration_versions` INSERT below (Step 10
 * correction round, Gap 5) — `activationRequestsService.ts` catches this and
 * maps it onto `ActivationServiceError("CONCURRENT_MODIFICATION", ...)`, the
 * same typed conflict every other guarded write in this step already uses.
 */
export class ConfigVersionRaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigVersionRaceError";
  }
}

/** Narrowly matches ONLY the specific unique-constraint violation this race can produce — any other error (a genuinely different DB failure) is rethrown unchanged by the caller, never mis-mapped onto a spurious "retry" conflict. */
function isDuplicateVersionNoError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; sqlMessage?: unknown };
  return (
    e.code === "ER_DUP_ENTRY" &&
    typeof e.sqlMessage === "string" &&
    e.sqlMessage.includes("uq_guild_configuration_versions_guild_version")
  );
}

interface SectionEntry {
  readonly data: unknown;
  readonly completedAt: string;
}
type SectionsJson = Partial<Record<OnboardingSectionKey, SectionEntry>>;

export interface OnboardingProgressRow {
  readonly guildId: string;
  readonly draftConfigVersionId: number | null;
  readonly sections: SectionsJson;
}

function parseSectionsJson(raw: unknown): SectionsJson {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as SectionsJson;
    } catch {
      return {};
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- `raw`'s narrowed type here (`object`) is not structurally `SectionsJson`; the assertion is required for `tsc`, this lint rule's own narrower analysis disagrees.
  return raw as SectionsJson;
}

/** Idempotent — creates an empty progress row on first touch, never overwrites an existing one. */
export async function ensureOnboardingProgressRow(
  db: Executor,
  guildId: string,
): Promise<OnboardingProgressRow> {
  await db
    .insertInto("dashboard_guild_onboarding_progress")
    .values({ guild_id: guildId, draft_config_version_id: null, sections_json: JSON.stringify({}) })
    .onDuplicateKeyUpdate({ guild_id: sql`guild_id` })
    .execute();
  const row = await db
    .selectFrom("dashboard_guild_onboarding_progress")
    .select(["guild_id", "draft_config_version_id", "sections_json"])
    .where("guild_id", "=", guildId)
    .executeTakeFirstOrThrow();
  return {
    guildId: row.guild_id,
    draftConfigVersionId: row.draft_config_version_id,
    sections: parseSectionsJson(row.sections_json),
  };
}

/** Writes exactly one section's payload into the live edit buffer — never touches the real SHARED sub-tables (see this module's header comment). */
export async function saveOnboardingSectionData(
  db: Executor,
  guildId: string,
  request: OnboardingSectionSaveRequest,
): Promise<OnboardingProgressRow> {
  const current = await ensureOnboardingProgressRow(db, guildId);
  const nextSections: SectionsJson = {
    ...current.sections,
    [request.section]: { data: request.data, completedAt: new Date().toISOString() },
  };
  await db
    .updateTable("dashboard_guild_onboarding_progress")
    .set({ sections_json: JSON.stringify(nextSections) })
    .where("guild_id", "=", guildId)
    .execute();
  return { ...current, sections: nextSections };
}

export async function setDraftConfigVersionId(
  db: Executor,
  guildId: string,
  versionId: number,
): Promise<void> {
  await db
    .updateTable("dashboard_guild_onboarding_progress")
    .set({ draft_config_version_id: versionId })
    .where("guild_id", "=", guildId)
    .execute();
}

export function minimumChecklistPassed(sections: SectionsJson): boolean {
  const incoming = sections.incomingChannel?.data as { channelId?: string } | undefined;
  const hero = sections.heroChannel?.data as { channelId?: string } | undefined;
  const quotas = sections.seasonQuotas?.data as
    { categories?: string[]; acceptPlatformDefaults?: boolean } | undefined;
  const hasIncoming = typeof incoming?.channelId === "string" && incoming.channelId.length > 0;
  const hasHero = typeof hero?.channelId === "string" && hero.channelId.length > 0;
  // SCREENS/ONBOARDING.md: "at least one quota category" OR accepting
  // platform defaults (an explicit alternative the doc names, not a silent
  // simplification).
  const hasQuota = Boolean(quotas?.acceptPlatformDefaults) || (quotas?.categories?.length ?? 0) > 0;
  return hasIncoming && hasHero && hasQuota;
}

export function sectionStatuses(
  sections: SectionsJson,
): Record<OnboardingSectionKey, { completed: boolean; completedAt: string | null }> {
  const result = {} as Record<OnboardingSectionKey, { completed: boolean; completedAt: string | null }>;
  for (const key of ONBOARDING_SECTION_KEYS) {
    const entry = sections[key];
    result[key] = { completed: entry !== undefined, completedAt: entry?.completedAt ?? null };
  }
  return result;
}

/**
 * Step 10 external-review correction round, Section 5: the checksum MUST
 * represent the real materialized `{common, bunny, selfbot, orchestrator}`
 * content that was/will be written to the real sub-tables — NEVER the
 * onboarding form buffer (`sections_json`). The old
 * `computeConfigChecksum(sections)` (hashed the buffer via plain
 * `JSON.stringify`) has been REMOVED — every checksum in this module now
 * goes through `computeMaterializedConfigChecksum` (`configChecksum.ts`),
 * which byte-for-byte matches the canonical Self-bot writer's
 * `guild_config.py::_checksum()`. See that module's header comment for the
 * full rationale (BigInt-precision / ensure_ascii traps a naive
 * `JSON.stringify` port would fall into).
 */

/** Parses a MySQL `JSON` column's value defensively — mysql2 sometimes hands back an already-parsed object/array, sometimes a raw string, depending on driver/version configuration; mirrors `parseSectionsJson`'s own defensive pattern above rather than assuming one shape. */
function parseJsonColumn<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  return raw as T;
}

/**
 * Platform bootstrap defaults for the SHARED sub-table columns the 7
 * onboarding sections do not individually cover (`guild_config_common`'s
 * `timezone`/`operational_enabled`/`locale`/`guild_weight`,
 * `guild_config_bunny`'s ingestion/OCR tuning columns beyond
 * `incoming_channel_id`, `guild_config_selfbot`'s automation-timing columns
 * beyond the two channel ids). ** Explicit, disclosed simplification **
 * (00_GLOBAL_IMPLEMENTATION_RULES.md rule 1): there is no existing
 * `platform_config_bunny`/`platform_config_selfbot` table this step could
 * copy real platform defaults from (verified: only `platform_orchestrator_defaults`/
 * `platform_runtime_config` exist, a different shape) — these are this
 * step's own conservative bootstrap values, meant to produce a genuinely
 * valid, insertable row for the very first onboarding submission, not a
 * product decision about tuning. Flagged for Step 12's owner (the real
 * versioned-config editor) to ratify, override, or supersede with a real
 * platform-defaults mechanism.
 *
 * Step 10 external-review correction round, Section 10: every
 * `guild_config_selfbot` default below is now cited against its REAL
 * canonical source — `01_NEW_SELF_BOTS/src/core/config.py`'s
 * `ConfigManager.DEFAULT_CONFIG` (verified live, lines ~122-142) via its
 * `_JSON_TO_DB_SELFBOT_KEYS` mapping (lines ~55-73) — and 3 real bugs found
 * against that source are fixed (see the individual field comments below).
 */
const GUILD_CONFIG_COMMON_DEFAULTS = {
  timezone: "Europe/Paris",
  operational_enabled: 1,
  locale: "en",
  guild_weight: "1.000",
};
const GUILD_CONFIG_BUNNY_DEFAULTS = {
  ingestion_enabled: 1,
  source_delete_policy: "KEEP",
  save_processed_copy: 0,
  ocr_engine: "TESSERACT",
  ocr_profile: "DEFAULT",
  per_guild_concurrency: 1,
  max_ocr_attempts: 3,
  retry_base_seconds: 30,
  catchup_interval_seconds: 300,
  max_attachment_bytes: 10485760,
  allowed_mime_json: JSON.stringify(["image/png", "image/jpeg", "image/webp"]),
};
const GUILD_CONFIG_SELFBOT_DEFAULTS = {
  // = config.py DEFAULT_CONFIG['automation_enabled'] (False).
  automation_enabled: 0,
  // No legacy JSON/SQL-level default exists anywhere for this field
  // (confirmed absent from _JSON_TO_DB_SELFBOT_KEYS; migration 0002's
  // guild_config_selfbot CREATE TABLE has no SQL DEFAULT either) — this is
  // Step 10's own reasoned choice, not a sourced value.
  profile_enabled: 0,
  // = config.py DEFAULT_CONFIG['auto_profile_timeout_seconds'] (60).
  // FIXED (Section 10): was 30, a real bug against the canonical source.
  profile_timeout_seconds: 60,
  // No legacy JSON/SQL-level default exists for this field (same
  // verification as profile_enabled above) — Step 10's own reasoned choice.
  profile_stale_seconds: 3600,
  // = config.py DEFAULT_CONFIG['auto_response_timeout_seconds'] (180).
  // FIXED (Section 10): was 60, a real bug against the canonical source.
  hero_response_timeout_seconds: 180,
  // = config.py DEFAULT_CONFIG['auto_retry_limit'] (3) — already correct.
  max_delivery_attempts: 3,
  // = config.py DEFAULT_CONFIG['community_updates_enabled'] (True) —
  // already correct.
  community_updates_enabled: 1,
  // = config.py DEFAULT_CONFIG['community_mentions_enabled'] (True).
  // FIXED (Section 10): was 0 — a real behavioral default flip against the
  // canonical source (the old value silently disabled @everyone mentions
  // by default, the opposite of the legacy self-bot's own default).
  everyone_mentions_enabled: 1,
  // No legacy JSON/SQL-level default exists for this field (same
  // verification as profile_enabled above) — Step 10's own reasoned choice.
  reminder_enabled: 1,
};

/** All 16 `guild_config_orchestrator` override columns, `null` (Python's `orchestrator={}` case — no per-guild override yet, matching the bootstrap DB row's own all-NULL shape). */
const ORCHESTRATOR_BOOTSTRAP_DEFAULTS = {
  max_guild_inflight: null,
  max_channel_inflight: null,
  risk_eval_min_seconds: null,
  risk_eval_max_seconds: null,
  send_min_seconds: null,
  send_max_seconds: null,
  profile_min_seconds: null,
  profile_max_seconds: null,
  reminder_min_seconds: null,
  reminder_max_seconds: null,
  critical_hours_remaining: null,
  hero_latency_circuit_seconds: null,
  error_rate_circuit: null,
  min_sample_size: null,
  fairness_weight: null,
  starvation_seconds: null,
  decision_rules_json: null,
} as const;

/** The bootstrap `MaterializedConfigValues` for a guild's very first onboarding-created version — every field is either a cited canonical default (Section 10) or an explicitly-disclosed Step 10 choice; no orchestrator overrides. */
function bootstrapMaterializedConfigValues(): MaterializedConfigValues {
  return {
    common: {
      timezone: GUILD_CONFIG_COMMON_DEFAULTS.timezone,
      operationalEnabled: GUILD_CONFIG_COMMON_DEFAULTS.operational_enabled === 1,
      locale: GUILD_CONFIG_COMMON_DEFAULTS.locale,
      guildWeight: GUILD_CONFIG_COMMON_DEFAULTS.guild_weight,
    },
    bunny: {
      incomingChannelId: "0",
      processedChannelId: null,
      ingestionEnabled: GUILD_CONFIG_BUNNY_DEFAULTS.ingestion_enabled === 1,
      sourceDeletePolicy: GUILD_CONFIG_BUNNY_DEFAULTS.source_delete_policy,
      saveProcessedCopy: GUILD_CONFIG_BUNNY_DEFAULTS.save_processed_copy === 1,
      ocrEngine: GUILD_CONFIG_BUNNY_DEFAULTS.ocr_engine,
      ocrProfile: GUILD_CONFIG_BUNNY_DEFAULTS.ocr_profile,
      perGuildConcurrency: GUILD_CONFIG_BUNNY_DEFAULTS.per_guild_concurrency,
      maxOcrAttempts: GUILD_CONFIG_BUNNY_DEFAULTS.max_ocr_attempts,
      retryBaseSeconds: GUILD_CONFIG_BUNNY_DEFAULTS.retry_base_seconds,
      catchupIntervalSeconds: GUILD_CONFIG_BUNNY_DEFAULTS.catchup_interval_seconds,
      maxAttachmentBytes: String(GUILD_CONFIG_BUNNY_DEFAULTS.max_attachment_bytes),
      allowedMime: JSON.parse(GUILD_CONFIG_BUNNY_DEFAULTS.allowed_mime_json) as string[],
    },
    selfbot: {
      herowarbotChannelId: "0",
      screenshotsChannelId: null,
      communityChannelId: null,
      automationEnabled: GUILD_CONFIG_SELFBOT_DEFAULTS.automation_enabled === 1,
      profileEnabled: GUILD_CONFIG_SELFBOT_DEFAULTS.profile_enabled === 1,
      profileTimeoutSeconds: GUILD_CONFIG_SELFBOT_DEFAULTS.profile_timeout_seconds,
      profileStaleSeconds: GUILD_CONFIG_SELFBOT_DEFAULTS.profile_stale_seconds,
      heroResponseTimeoutSeconds: GUILD_CONFIG_SELFBOT_DEFAULTS.hero_response_timeout_seconds,
      maxDeliveryAttempts: GUILD_CONFIG_SELFBOT_DEFAULTS.max_delivery_attempts,
      communityUpdatesEnabled: GUILD_CONFIG_SELFBOT_DEFAULTS.community_updates_enabled === 1,
      everyoneMentionsEnabled: GUILD_CONFIG_SELFBOT_DEFAULTS.everyone_mentions_enabled === 1,
      reminderEnabled: GUILD_CONFIG_SELFBOT_DEFAULTS.reminder_enabled === 1,
      nbGcHero: 912,
      nbGcTitan: 380,
      nbHol: 600,
      nbHero: 1200,
      nbTitan: 600,
      autoProfileIntervalSeconds: 1800,
      autoMaxPerCycle: 10,
    },
    orchestrator: {
      maxGuildInflight: ORCHESTRATOR_BOOTSTRAP_DEFAULTS.max_guild_inflight,
      maxChannelInflight: ORCHESTRATOR_BOOTSTRAP_DEFAULTS.max_channel_inflight,
      riskEvalMinSeconds: ORCHESTRATOR_BOOTSTRAP_DEFAULTS.risk_eval_min_seconds,
      riskEvalMaxSeconds: ORCHESTRATOR_BOOTSTRAP_DEFAULTS.risk_eval_max_seconds,
      sendMinSeconds: ORCHESTRATOR_BOOTSTRAP_DEFAULTS.send_min_seconds,
      sendMaxSeconds: ORCHESTRATOR_BOOTSTRAP_DEFAULTS.send_max_seconds,
      profileMinSeconds: ORCHESTRATOR_BOOTSTRAP_DEFAULTS.profile_min_seconds,
      profileMaxSeconds: ORCHESTRATOR_BOOTSTRAP_DEFAULTS.profile_max_seconds,
      reminderMinSeconds: ORCHESTRATOR_BOOTSTRAP_DEFAULTS.reminder_min_seconds,
      reminderMaxSeconds: ORCHESTRATOR_BOOTSTRAP_DEFAULTS.reminder_max_seconds,
      criticalHoursRemaining: ORCHESTRATOR_BOOTSTRAP_DEFAULTS.critical_hours_remaining,
      heroLatencyCircuitSeconds: ORCHESTRATOR_BOOTSTRAP_DEFAULTS.hero_latency_circuit_seconds,
      errorRateCircuit: ORCHESTRATOR_BOOTSTRAP_DEFAULTS.error_rate_circuit,
      minSampleSize: ORCHESTRATOR_BOOTSTRAP_DEFAULTS.min_sample_size,
      fairnessWeight: ORCHESTRATOR_BOOTSTRAP_DEFAULTS.fairness_weight,
      starvationSeconds: ORCHESTRATOR_BOOTSTRAP_DEFAULTS.starvation_seconds,
      decisionRulesJson: ORCHESTRATOR_BOOTSTRAP_DEFAULTS.decision_rules_json,
    },
  };
}

/**
 * Reads a `guild_configuration_versions` row's REAL, currently-stored
 * content from its 4 real sub-tables — every `BIGINT UNSIGNED` column is
 * explicitly `CAST(... AS CHAR)` in the SQL (never left to Kysely's
 * generated `number` type, which would silently truncate a real Snowflake
 * above `Number.MAX_SAFE_INTEGER` the moment mysql2 parsed it into a JS
 * number — the exact trap this step's checksum work exists to avoid).
 * Returns `null` if `versionId` has no `guild_config_common` row at all
 * (never created, or genuinely nonexistent) — the 3 other sub-tables are
 * then assumed to be in the same state (they are always written together,
 * see `materializeDraftConfigVersion`) and are not separately queried.
 *
 * Used for BOTH (a) carrying forward every unchanged field when
 * materializing a new version based on an existing one (Section 10), and
 * (b) the approval-time checksum recompute against the REAL sub-table rows
 * (Section 5.1) — the same reader for both call sites, so the two can never
 * silently disagree about what "the real row content" means.
 */
export async function loadMaterializedConfigValues(
  db: Executor,
  versionId: number,
): Promise<MaterializedConfigValues | null> {
  const common = await db
    .selectFrom("guild_config_common")
    .select(["timezone", "operational_enabled", "locale", sql<string>`CAST(guild_weight AS CHAR)`.as("guild_weight")])
    .where("configuration_version_id", "=", versionId)
    .executeTakeFirst();
  if (!common) return null;

  const bunny = await db
    .selectFrom("guild_config_bunny")
    .select([
      sql<string>`CAST(incoming_channel_id AS CHAR)`.as("incoming_channel_id"),
      sql<string | null>`CAST(processed_channel_id AS CHAR)`.as("processed_channel_id"),
      "ingestion_enabled",
      "source_delete_policy",
      "save_processed_copy",
      "ocr_engine",
      "ocr_profile",
      "per_guild_concurrency",
      "max_ocr_attempts",
      "retry_base_seconds",
      "catchup_interval_seconds",
      sql<string>`CAST(max_attachment_bytes AS CHAR)`.as("max_attachment_bytes"),
      "allowed_mime_json",
    ])
    .where("configuration_version_id", "=", versionId)
    .executeTakeFirstOrThrow(
      () => new Error(`loadMaterializedConfigValues: guild_config_bunny missing for version ${versionId}`),
    );

  const selfbot = await db
    .selectFrom("guild_config_selfbot")
    .select([
      sql<string>`CAST(herowarbot_channel_id AS CHAR)`.as("herowarbot_channel_id"),
      sql<string | null>`CAST(screenshots_channel_id AS CHAR)`.as("screenshots_channel_id"),
      sql<string | null>`CAST(community_channel_id AS CHAR)`.as("community_channel_id"),
      "automation_enabled",
      "profile_enabled",
      "profile_timeout_seconds",
      "profile_stale_seconds",
      "hero_response_timeout_seconds",
      "max_delivery_attempts",
      "community_updates_enabled",
      "everyone_mentions_enabled",
      "reminder_enabled",
      "nb_gc_hero",
      "nb_gc_titan",
      "nb_hol",
      "nb_hero",
      "nb_titan",
      "auto_profile_interval_seconds",
      "auto_max_per_cycle",
    ])
    .where("configuration_version_id", "=", versionId)
    .executeTakeFirstOrThrow(
      () => new Error(`loadMaterializedConfigValues: guild_config_selfbot missing for version ${versionId}`),
    );

  const orchestrator = await db
    .selectFrom("guild_config_orchestrator")
    .select([
      "max_guild_inflight",
      "max_channel_inflight",
      "risk_eval_min_seconds",
      "risk_eval_max_seconds",
      "send_min_seconds",
      "send_max_seconds",
      "profile_min_seconds",
      "profile_max_seconds",
      "reminder_min_seconds",
      "reminder_max_seconds",
      "critical_hours_remaining",
      "hero_latency_circuit_seconds",
      sql<string | null>`CAST(error_rate_circuit AS CHAR)`.as("error_rate_circuit"),
      "min_sample_size",
      sql<string | null>`CAST(fairness_weight AS CHAR)`.as("fairness_weight"),
      "starvation_seconds",
      "decision_rules_json",
    ])
    .where("configuration_version_id", "=", versionId)
    .executeTakeFirstOrThrow(
      () => new Error(`loadMaterializedConfigValues: guild_config_orchestrator missing for version ${versionId}`),
    );

  return {
    common: {
      timezone: common.timezone,
      operationalEnabled: common.operational_enabled === 1,
      locale: common.locale,
      guildWeight: common.guild_weight,
    },
    bunny: {
      incomingChannelId: bunny.incoming_channel_id,
      processedChannelId: bunny.processed_channel_id,
      ingestionEnabled: bunny.ingestion_enabled === 1,
      sourceDeletePolicy: bunny.source_delete_policy,
      saveProcessedCopy: bunny.save_processed_copy === 1,
      ocrEngine: bunny.ocr_engine,
      ocrProfile: bunny.ocr_profile,
      perGuildConcurrency: bunny.per_guild_concurrency,
      maxOcrAttempts: bunny.max_ocr_attempts,
      retryBaseSeconds: bunny.retry_base_seconds,
      catchupIntervalSeconds: bunny.catchup_interval_seconds,
      maxAttachmentBytes: bunny.max_attachment_bytes,
      allowedMime: parseJsonColumn<string[]>(bunny.allowed_mime_json, []),
    },
    selfbot: {
      herowarbotChannelId: selfbot.herowarbot_channel_id,
      screenshotsChannelId: selfbot.screenshots_channel_id,
      communityChannelId: selfbot.community_channel_id,
      automationEnabled: selfbot.automation_enabled === 1,
      profileEnabled: selfbot.profile_enabled === 1,
      profileTimeoutSeconds: selfbot.profile_timeout_seconds,
      profileStaleSeconds: selfbot.profile_stale_seconds,
      heroResponseTimeoutSeconds: selfbot.hero_response_timeout_seconds,
      maxDeliveryAttempts: selfbot.max_delivery_attempts,
      communityUpdatesEnabled: selfbot.community_updates_enabled === 1,
      everyoneMentionsEnabled: selfbot.everyone_mentions_enabled === 1,
      reminderEnabled: selfbot.reminder_enabled === 1,
      nbGcHero: selfbot.nb_gc_hero,
      nbGcTitan: selfbot.nb_gc_titan,
      nbHol: selfbot.nb_hol,
      nbHero: selfbot.nb_hero,
      nbTitan: selfbot.nb_titan,
      autoProfileIntervalSeconds: selfbot.auto_profile_interval_seconds,
      autoMaxPerCycle: selfbot.auto_max_per_cycle,
    },
    orchestrator: {
      maxGuildInflight: orchestrator.max_guild_inflight,
      maxChannelInflight: orchestrator.max_channel_inflight,
      riskEvalMinSeconds: orchestrator.risk_eval_min_seconds,
      riskEvalMaxSeconds: orchestrator.risk_eval_max_seconds,
      sendMinSeconds: orchestrator.send_min_seconds,
      sendMaxSeconds: orchestrator.send_max_seconds,
      profileMinSeconds: orchestrator.profile_min_seconds,
      profileMaxSeconds: orchestrator.profile_max_seconds,
      reminderMinSeconds: orchestrator.reminder_min_seconds,
      reminderMaxSeconds: orchestrator.reminder_max_seconds,
      criticalHoursRemaining: orchestrator.critical_hours_remaining,
      heroLatencyCircuitSeconds: orchestrator.hero_latency_circuit_seconds,
      errorRateCircuit: orchestrator.error_rate_circuit,
      minSampleSize: orchestrator.min_sample_size,
      fairnessWeight: orchestrator.fairness_weight,
      starvationSeconds: orchestrator.starvation_seconds,
      decisionRulesJson: parseJsonColumn<MaterializedConfigValues["orchestrator"]["decisionRulesJson"]>(
        orchestrator.decision_rules_json,
        null,
      ),
    },
  };
}

async function insertOrchestratorRow(
  db: Executor,
  versionId: number,
  values: MaterializedConfigValues["orchestrator"],
): Promise<void> {
  await db
    .insertInto("guild_config_orchestrator")
    .values({
      configuration_version_id: versionId,
      max_guild_inflight: values.maxGuildInflight,
      max_channel_inflight: values.maxChannelInflight,
      risk_eval_min_seconds: values.riskEvalMinSeconds,
      risk_eval_max_seconds: values.riskEvalMaxSeconds,
      send_min_seconds: values.sendMinSeconds,
      send_max_seconds: values.sendMaxSeconds,
      profile_min_seconds: values.profileMinSeconds,
      profile_max_seconds: values.profileMaxSeconds,
      reminder_min_seconds: values.reminderMinSeconds,
      reminder_max_seconds: values.reminderMaxSeconds,
      critical_hours_remaining: values.criticalHoursRemaining,
      hero_latency_circuit_seconds: values.heroLatencyCircuitSeconds,
      error_rate_circuit: values.errorRateCircuit,
      min_sample_size: values.minSampleSize,
      fairness_weight: values.fairnessWeight,
      starvation_seconds: values.starvationSeconds,
      decision_rules_json: values.decisionRulesJson === null ? null : sql`CAST(${JSON.stringify(values.decisionRulesJson)} AS JSON)`,
    })
    .execute();
}

/**
 * Creates (or reuses) a valid, currently-editable `DRAFT` `guild_configuration_versions`
 * row for `guildId`, then writes the buffer's known values into the real
 * `guild_config_common`/`guild_config_bunny`/`guild_config_selfbot`/
 * `guild_config_orchestrator` sub-tables — called ONLY at request-activation
 * time (see this module's header comment), once the server-side checklist
 * has already confirmed `incomingChannelId`/`heroChannelId` are both known
 * (both NOT NULL on their respective sub-tables). Rotates onto a
 * brand-new version (never mutates an existing one already referenced by a
 * non-terminal activation request) — the TOCTOU-closing mechanism.
 *
 * Step 10 external-review correction round, Section 5/10: EVERY field not
 * touched by this call carries forward UNCHANGED from
 * `params.currentDraftVersionId`'s real, currently-stored row content
 * (`loadMaterializedConfigValues`) — never silently reset to a bootstrap
 * default just because a materialization happened. Only a guild's very
 * first version (`currentDraftVersionId === null`) uses
 * `bootstrapMaterializedConfigValues()`. `guild_config_orchestrator` is
 * ALWAYS written now too (a real, separate bug found while wiring this: the
 * table was never inserted into at all before this fix, which would have
 * made `get_active_guild_config`'s real `INNER JOIN guild_config_orchestrator`
 * on the Self-bot side fail to resolve ANY guild config an onboarding save
 * ever created) — carried forward unchanged (no onboarding section maps to
 * an orchestrator override) or all-NULL for a guild's first version.
 */
export async function materializeDraftConfigVersion(
  db: Executor,
  params: {
    readonly guildId: string;
    readonly authorDiscordId: string;
    readonly sections: SectionsJson;
    /** The progress row's CURRENT draft id, or `null` if none exists yet. */
    readonly currentDraftVersionId: number | null;
    /**
     * Whether `currentDraftVersionId` must be treated as immutable — a NEW
     * version is created instead of mutating that one whenever EITHER: (a)
     * it is already referenced by a non-terminal (`PENDING`/`CHANGES_REQUESTED`)
     * activation request (the TOCTOU-closing case — a Superadmin might be
     * reviewing it right now), OR (b) its own `guild_configuration_versions.state`
     * is no longer `DRAFT` (already `ACTIVE`/`SUPERSEDED` — critically, once
     * APPROVED a version's own activation request becomes terminal, so (a)
     * alone stops catching it; without (b), a LIVE guild's currently-ACTIVE
     * configuration would be silently mutated in place by the next
     * onboarding save, with no approval step at all — worse than the TOCTOU
     * gap this whole mechanism exists to close). See `isVersionImmutable`.
     */
    readonly currentDraftIsImmutable: boolean;
  },
): Promise<{ versionId: number; checksum: Buffer }> {
  const incoming = params.sections.incomingChannel?.data as { channelId: string };
  const hero = params.sections.heroChannel?.data as { channelId: string };
  const community = params.sections.communityChannel?.data as { channelId: string | null } | undefined;

  let versionId = params.currentDraftVersionId;

  // Section 10: carry forward every field the touched sections don't
  // override, from the CURRENT draft/based-on version's real, currently
  // stored row content — never reset to bootstrap defaults on a
  // materialization that already has a version to carry forward from.
  const baseValues =
    versionId !== null ? await loadMaterializedConfigValues(db, versionId) : null;
  const carriedForward = baseValues ?? bootstrapMaterializedConfigValues();
  const merged: MaterializedConfigValues = {
    common: carriedForward.common,
    bunny: {
      ...carriedForward.bunny,
      incomingChannelId: incoming.channelId,
      processedChannelId: carriedForward.bunny.processedChannelId,
    },
    selfbot: {
      ...carriedForward.selfbot,
      herowarbotChannelId: hero.channelId,
      // `community` is `undefined` iff the section was never saved at all
      // (carry forward); once saved, its `channelId` may itself be `null`
      // (an explicit "clear the community channel") and must NOT fall back
      // to the carried-forward value in that case.
      communityChannelId: community !== undefined ? community.channelId : carriedForward.selfbot.communityChannelId,
    },
    orchestrator: carriedForward.orchestrator,
  };
  const checksum = computeMaterializedConfigChecksum(merged);

  // Real bug found in real-MySQL testing (reject -> reopen -> re-submit with
  // NO edits in between, then request-changes -> re-submit again with still
  // no edits): `guild_configuration_versions` carries `UNIQUE(guild_id,
  // checksum)` (SHARED schema, not this migration's to alter). Rotating
  // onto a brand-new version row whenever `currentDraftIsImmutable` is true
  // — regardless of whether the CONTENT actually changed — collided with
  // that constraint the moment content was unchanged since the immutable
  // version was created. Fix: if the current draft's OWN stored checksum
  // already equals the freshly computed one, the content is byte-identical
  // to what that row already holds — there is nothing to materialize, full
  // stop, whether or not that row happens to be "immutable" right now
  // (immutability only means "do not MUTATE this row," never "do not
  // REFERENCE it again unchanged"). Skips both the rotation AND the
  // no-op UPDATE branch below.
  if (versionId !== null) {
    const existing = await db
      .selectFrom("guild_configuration_versions")
      .select("checksum")
      .where("id", "=", versionId)
      .executeTakeFirst();
    if (existing && Buffer.compare(existing.checksum, checksum) === 0) {
      return { versionId, checksum };
    }
  }

  const needsNewVersion = versionId === null || params.currentDraftIsImmutable;

  if (needsNewVersion) {
    const guildIdBig = bindBigIntUnsigned(params.guildId);
    const maxRow = await db
      .selectFrom("guild_configuration_versions")
      .select((eb) => eb.fn.max("version_no").as("maxVersionNo"))
      .where("guild_id", "=", guildIdBig)
      .executeTakeFirst();
    const nextVersionNo = (maxRow?.maxVersionNo ?? 0) + 1;
    let insertResult;
    try {
      insertResult = await db
        .insertInto("guild_configuration_versions")
        .values({
          guild_id: guildIdBig,
          version_no: nextVersionNo,
          state: "DRAFT",
          based_on_id: versionId,
          author_type: "GUILD_ADMIN",
          author_discord_id: bindBigIntUnsigned(params.authorDiscordId),
          origin: "ONBOARDING",
          checksum,
        })
        .executeTakeFirstOrThrow();
    } catch (err) {
      // Step 10 correction round, Gap 5 (REAL concurrency bug found in
      // real-MySQL, real-server concurrent testing, not a hypothetical): two
      // concurrent request-activation calls for the SAME guild with no
      // existing draft version both compute `nextVersionNo` via this
      // non-atomic "SELECT MAX(version_no)+1 THEN INSERT" — each running in
      // its own transaction, each seeing no rows yet, each computing the
      // SAME `nextVersionNo`. Both INSERTs then race on
      // `guild_configuration_versions`'s real `UNIQUE(guild_id, version_no)`
      // constraint (`uq_guild_configuration_versions_guild_version`); the
      // loser previously surfaced as an unhandled `ER_DUP_ENTRY` — a raw 500,
      // not the documented "clear rejection rather than silent no-op"
      // contract (IMPLEMENTATION/10_onboarding_approval.md §Concurrency)
      // every OTHER guarded write in this step already honors. Mapped here
      // onto `ConfigVersionRaceError`, which `activationRequestsService.ts`
      // catches and turns into the same typed `CONCURRENT_MODIFICATION`
      // conflict (409) the `guilds.row_version` guard already produces for
      // every other racing lifecycle transition — the caller retries
      // exactly like any other optimistic-concurrency conflict, never a
      // silent duplicate version or an opaque 500.
      if (isDuplicateVersionNoError(err)) {
        throw new ConfigVersionRaceError(
          `materializeDraftConfigVersion: guild_configuration_versions(guild_id=${params.guildId}, version_no=${nextVersionNo}) was created concurrently by another request — retry`,
        );
      }
      throw err;
    }
    versionId = Number(insertResult.insertId);
    // Section 10: physically carry forward the FULL merged common values
    // (bootstrap defaults for a guild's very first version, or the real
    // based-on version's own stored values otherwise) — `guild_config_common`
    // is never touched again after this single insert (no onboarding
    // section maps to it), so this is the only write it ever gets.
    await db
      .insertInto("guild_config_common")
      .values({
        configuration_version_id: versionId,
        timezone: merged.common.timezone,
        operational_enabled: merged.common.operationalEnabled ? 1 : 0,
        locale: merged.common.locale,
        guild_weight: merged.common.guildWeight,
      })
      .execute();
    // Section 5 real bug fix: guild_config_orchestrator was never inserted
    // into at all before this fix (see this function's own doc comment) —
    // the Self-bot side's `get_active_guild_config` INNER JOINs this table,
    // so every onboarding-created version would have been unresolvable
    // there. Carries forward the real based-on version's own orchestrator
    // overrides unchanged (bootstrap: all-NULL, `ORCHESTRATOR_BOOTSTRAP_DEFAULTS`'s
    // shape) — no onboarding section maps to an orchestrator override.
    await insertOrchestratorRow(db, versionId, merged.orchestrator);
  } else {
    await db
      .updateTable("guild_configuration_versions")
      .set({ checksum })
      .where("id", "=", versionId!)
      .execute();
  }

  // `guild_config_bunny`/`guild_config_selfbot` are written with the FULL
  // merged row on every call (carry-forward + this call's touched
  // fields) — on a genuine fresh INSERT (needsNewVersion branch above)
  // every column physically lands in the new row; on a mutate-in-place
  // collision (`onDuplicateKeyUpdate`), only the columns explicitly listed
  // there are actually applied — `merged`'s OTHER fields are byte-identical
  // to what that row already holds (loaded from this SAME versionId just
  // above), so supplying the full object in `.values()` is always safe.
  await db
    .insertInto("guild_config_bunny")
    .values({
      configuration_version_id: versionId!,
      incoming_channel_id: bindBigIntUnsigned(merged.bunny.incomingChannelId),
      processed_channel_id:
        merged.bunny.processedChannelId === null ? null : bindBigIntUnsigned(merged.bunny.processedChannelId),
      ingestion_enabled: merged.bunny.ingestionEnabled ? 1 : 0,
      source_delete_policy: merged.bunny.sourceDeletePolicy,
      save_processed_copy: merged.bunny.saveProcessedCopy ? 1 : 0,
      ocr_engine: merged.bunny.ocrEngine,
      ocr_profile: merged.bunny.ocrProfile,
      per_guild_concurrency: merged.bunny.perGuildConcurrency,
      max_ocr_attempts: merged.bunny.maxOcrAttempts,
      retry_base_seconds: merged.bunny.retryBaseSeconds,
      catchup_interval_seconds: merged.bunny.catchupIntervalSeconds,
      max_attachment_bytes: bindBigIntUnsigned(merged.bunny.maxAttachmentBytes),
      allowed_mime_json: sql`CAST(${JSON.stringify(merged.bunny.allowedMime)} AS JSON)`,
    })
    .onDuplicateKeyUpdate({ incoming_channel_id: bindBigIntUnsigned(merged.bunny.incomingChannelId) })
    .execute();

  await db
    .insertInto("guild_config_selfbot")
    .values({
      configuration_version_id: versionId!,
      herowarbot_channel_id: bindBigIntUnsigned(merged.selfbot.herowarbotChannelId),
      screenshots_channel_id:
        merged.selfbot.screenshotsChannelId === null ? null : bindBigIntUnsigned(merged.selfbot.screenshotsChannelId),
      community_channel_id:
        merged.selfbot.communityChannelId === null ? null : bindBigIntUnsigned(merged.selfbot.communityChannelId),
      automation_enabled: merged.selfbot.automationEnabled ? 1 : 0,
      profile_enabled: merged.selfbot.profileEnabled ? 1 : 0,
      profile_timeout_seconds: merged.selfbot.profileTimeoutSeconds,
      profile_stale_seconds: merged.selfbot.profileStaleSeconds,
      hero_response_timeout_seconds: merged.selfbot.heroResponseTimeoutSeconds,
      max_delivery_attempts: merged.selfbot.maxDeliveryAttempts,
      community_updates_enabled: merged.selfbot.communityUpdatesEnabled ? 1 : 0,
      everyone_mentions_enabled: merged.selfbot.everyoneMentionsEnabled ? 1 : 0,
      reminder_enabled: merged.selfbot.reminderEnabled ? 1 : 0,
      nb_gc_hero: merged.selfbot.nbGcHero,
      nb_gc_titan: merged.selfbot.nbGcTitan,
      nb_hol: merged.selfbot.nbHol,
      nb_hero: merged.selfbot.nbHero,
      nb_titan: merged.selfbot.nbTitan,
      auto_profile_interval_seconds: merged.selfbot.autoProfileIntervalSeconds,
      auto_max_per_cycle: merged.selfbot.autoMaxPerCycle,
    })
    .onDuplicateKeyUpdate({
      herowarbot_channel_id: bindBigIntUnsigned(merged.selfbot.herowarbotChannelId),
      community_channel_id:
        merged.selfbot.communityChannelId === null ? null : bindBigIntUnsigned(merged.selfbot.communityChannelId),
    })
    .execute();

  await setDraftConfigVersionId(db, params.guildId, versionId!);
  return { versionId: versionId!, checksum };
}

/** Whether `versionId` is currently referenced by a non-terminal activation request — half of the TOCTOU-rotation check (see `isVersionImmutable`). */
export async function isVersionSubmittedNonTerminally(db: Executor, versionId: number): Promise<boolean> {
  const row = await db
    .selectFrom("dashboard_guild_activation_requests")
    .select("request_id")
    .where("submitted_config_version_id", "=", versionId)
    .where("state", "in", ["PENDING", "CHANGES_REQUESTED"])
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * The FULL rotation check `materializeDraftConfigVersion`'s `currentDraftIsImmutable`
 * param needs: `versionId` must never be mutated in place again if EITHER
 * it's referenced by a non-terminal activation request (a Superadmin may be
 * reviewing it right now) OR its own `guild_configuration_versions.state` is
 * no longer `DRAFT` (already `ACTIVE`/`SUPERSEDED` — the case
 * `isVersionSubmittedNonTerminally` alone misses, since APPROVAL makes the
 * REQUEST terminal while the underlying version becomes `ACTIVE`: without
 * this second check, the very next onboarding save would silently rewrite a
 * LIVE guild's currently-active configuration with no approval step at
 * all).
 */
export async function isVersionImmutable(db: Executor, versionId: number): Promise<boolean> {
  const [submittedNonTerminally, versionRow] = await Promise.all([
    isVersionSubmittedNonTerminally(db, versionId),
    db
      .selectFrom("guild_configuration_versions")
      .select("state")
      .where("id", "=", versionId)
      .executeTakeFirst(),
  ]);
  return submittedNonTerminally || versionRow?.state !== "DRAFT";
}

/** Snapshot read for the Superadmin review screen — genuinely frozen once materialized (further onboarding saves rotate onto a NEW version id, never mutate this one). */
export async function getMaterializedConfigSnapshot(
  db: Executor,
  versionId: number,
): Promise<{
  incomingChannelId: string | null;
  heroChannelId: string | null;
  communityChannelId: string | null;
  checksum: Buffer;
} | null> {
  const version = await db
    .selectFrom("guild_configuration_versions")
    .select("checksum")
    .where("id", "=", versionId)
    .executeTakeFirst();
  if (!version) return null;
  const bunny = await db
    .selectFrom("guild_config_bunny")
    .select([sql<string>`CAST(incoming_channel_id AS CHAR)`.as("incomingChannelId")])
    .where("configuration_version_id", "=", versionId)
    .executeTakeFirst();
  const selfbot = await db
    .selectFrom("guild_config_selfbot")
    .select([
      sql<string>`CAST(herowarbot_channel_id AS CHAR)`.as("heroChannelId"),
      sql<string | null>`CAST(community_channel_id AS CHAR)`.as("communityChannelId"),
    ])
    .where("configuration_version_id", "=", versionId)
    .executeTakeFirst();
  return {
    incomingChannelId: bunny?.incomingChannelId ?? null,
    heroChannelId: selfbot?.heroChannelId ?? null,
    communityChannelId: selfbot?.communityChannelId ?? null,
    checksum: version.checksum,
  };
}
