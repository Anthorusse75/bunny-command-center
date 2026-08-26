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
import { createHash } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { DB } from "../db/codegen-types.js";
import { bindBigIntUnsigned } from "../db/bigIntParam.js";
import type { OnboardingSectionKey, OnboardingSectionSaveRequest } from "@bunny-command-center/shared";
import { ONBOARDING_SECTION_KEYS } from "@bunny-command-center/shared";

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

/** Deterministic SHA-256 over the onboarding buffer's canonical, sorted-key JSON serialization — `guild_configuration_versions.checksum` (BINARY(32)). Content identity only, never used for anything security-sensitive beyond TOCTOU defense-in-depth (10_GUILD_ONBOARDING_AND_APPROVAL.md's "re-verify submitted_config_checksum still matches"). */
export function computeConfigChecksum(sections: SectionsJson): Buffer {
  const keys = Object.keys(sections).sort();
  const canonical: Record<string, unknown> = {};
  for (const k of keys) canonical[k] = sections[k as OnboardingSectionKey]?.data ?? null;
  return createHash("sha256").update(JSON.stringify(canonical)).digest();
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
  automation_enabled: 0,
  profile_enabled: 0,
  profile_timeout_seconds: 30,
  profile_stale_seconds: 3600,
  hero_response_timeout_seconds: 60,
  max_delivery_attempts: 3,
  community_updates_enabled: 1,
  everyone_mentions_enabled: 0,
  reminder_enabled: 1,
};

/**
 * Creates (or reuses) a valid, currently-editable `DRAFT` `guild_configuration_versions`
 * row for `guildId`, then writes the buffer's known values into the real
 * `guild_config_common`/`guild_config_bunny`/`guild_config_selfbot` sub-tables —
 * called ONLY at request-activation time (see this module's header
 * comment), once the server-side checklist has already confirmed
 * `incomingChannelId`/`heroChannelId` are both known (both NOT NULL on
 * their respective sub-tables). Rotates onto a brand-new version (never
 * mutates an existing one already referenced by a non-terminal activation
 * request) — the TOCTOU-closing mechanism.
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
  const checksum = computeConfigChecksum(params.sections);

  let versionId = params.currentDraftVersionId;

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
    await db
      .insertInto("guild_config_common")
      .values({ configuration_version_id: versionId, ...GUILD_CONFIG_COMMON_DEFAULTS })
      .execute();
  } else {
    await db
      .updateTable("guild_configuration_versions")
      .set({ checksum })
      .where("id", "=", versionId!)
      .execute();
  }

  await db
    .insertInto("guild_config_bunny")
    .values({
      configuration_version_id: versionId!,
      incoming_channel_id: bindBigIntUnsigned(incoming.channelId),
      processed_channel_id: null,
      ...GUILD_CONFIG_BUNNY_DEFAULTS,
    })
    .onDuplicateKeyUpdate({ incoming_channel_id: bindBigIntUnsigned(incoming.channelId) })
    .execute();

  await db
    .insertInto("guild_config_selfbot")
    .values({
      configuration_version_id: versionId!,
      herowarbot_channel_id: bindBigIntUnsigned(hero.channelId),
      community_channel_id: community?.channelId ? bindBigIntUnsigned(community.channelId) : null,
      ...GUILD_CONFIG_SELFBOT_DEFAULTS,
    })
    .onDuplicateKeyUpdate({
      herowarbot_channel_id: bindBigIntUnsigned(hero.channelId),
      community_channel_id: community?.channelId ? bindBigIntUnsigned(community.channelId) : null,
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
