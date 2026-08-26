/**
 * Kysely queries backing the notification mechanism. Every by-id query here
 * that returns a caller-visible row is scoped to `user_id` IN THE SQL
 * PREDICATE ITSELF (never an app-layer post-filter) — the IDOR discipline
 * this step's task brief requires ("Strict per-user ownership enforced in
 * the DB predicate itself").
 */
import { sql, type Kysely, type Transaction } from "kysely";
import type { DB } from "../db/codegen-types.js";
import {
  NOTIFICATION_EVENT_REGISTRY,
  NOTIFICATION_GROUP_EVENT_TYPES,
  type NotificationEventType,
  type NotificationPreferenceGroup,
} from "@bunny-command-center/shared";
import { bindBigIntUnsigned } from "../db/bigIntParam.js";

export type Executor = Kysely<DB> | Transaction<DB>;

export interface CreateNotificationRowInput {
  readonly id: string;
  readonly userId: number;
  readonly eventType: NotificationEventType;
  readonly messageKey: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly guildId: string | null;
  readonly deeplinkPath: string;
}

/**
 * Thrown when a retried `createNotification()` call reuses an existing
 * `notificationId` but with a DIFFERENT logical identity (recipient
 * `userId`, `eventType`/`messageKey`, or `parameters`) — external-review
 * item 6: this aliases a different logical notification under a reused
 * stable id, which `onDuplicateKeyUpdate`'s own no-op below would otherwise
 * let slip through silently (neither creating a second row nor erroring).
 * Fail-closed: the whole `createNotification()` transaction rolls back —
 * never a silent duplicate, never a silent overwrite of the original
 * identity fields.
 */
export class NotificationIdentityConflictError extends Error {
  constructor(id: string, reason: string) {
    super(
      `createNotification: notificationId=${id} already exists with a DIFFERENT identity (${reason}) — retrying with different content under a reused id is rejected`,
    );
    this.name = "NotificationIdentityConflictError";
  }
}

/** Deep, key-order-independent structural equality for two JSON-serializable values — used only to compare `parameters` on a retried `createNotification()` call (see `NotificationIdentityConflictError`), never for anything security-sensitive. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
}

/** Idempotent — a retry with the SAME `id` never overwrites an existing row (the composite "ensure" semantics this step's task brief calls for: "if provided, reuse it (retry-safe)"), but a retry whose CONTENT genuinely differs (different recipient/eventType/parameters) is rejected fail-closed rather than silently aliased or silently overwritten — see `NotificationIdentityConflictError`. */
export async function ensureNotificationRow(db: Executor, input: CreateNotificationRowInput): Promise<void> {
  await db
    .insertInto("dashboard_notifications")
    .values({
      id: input.id,
      user_id: input.userId,
      event_type: input.eventType,
      message_key: input.messageKey,
      parameters_json: JSON.stringify(input.parameters),
      guild_id: input.guildId,
      deeplink_path: input.deeplinkPath,
    })
    .onDuplicateKeyUpdate({ id: sql`id` })
    .execute();

  const existing = await db
    .selectFrom("dashboard_notifications")
    .select(["user_id", "event_type", "message_key", "parameters_json"])
    .where("id", "=", input.id)
    .executeTakeFirstOrThrow(
      () => new Error("ensureNotificationRow: row missing immediately after upsert — should be unreachable"),
    );
  if (existing.user_id !== input.userId) {
    throw new NotificationIdentityConflictError(
      input.id,
      `recipient userId ${existing.user_id} != ${input.userId}`,
    );
  }
  if (existing.event_type !== input.eventType) {
    throw new NotificationIdentityConflictError(
      input.id,
      `eventType ${existing.event_type} != ${input.eventType}`,
    );
  }
  if (existing.message_key !== input.messageKey) {
    throw new NotificationIdentityConflictError(
      input.id,
      `messageKey ${existing.message_key} != ${input.messageKey}`,
    );
  }
  if (canonicalJson(existing.parameters_json) !== canonicalJson(input.parameters)) {
    throw new NotificationIdentityConflictError(input.id, "parameters differ");
  }
}

export type NotificationDeliveryChannel = "IN_APP" | "DISCORD_DM";
export type NotificationDeliveryState = "PENDING" | "SENT" | "FAILED" | "SKIPPED_PREFERENCE";

/** Idempotent — never regresses an existing delivery row's state on retry (the watcher may already have advanced it past what a re-run of `createNotification` would otherwise re-assert). */
export async function ensureDeliveryRow(
  db: Executor,
  params: {
    readonly notificationId: string;
    readonly channel: NotificationDeliveryChannel;
    readonly state: NotificationDeliveryState;
  },
): Promise<void> {
  await db
    .insertInto("dashboard_notification_deliveries")
    .values({ notification_id: params.notificationId, channel: params.channel, state: params.state })
    .onDuplicateKeyUpdate({ notification_id: sql`notification_id` })
    .execute();
}

/**
 * Sets `operator_command_id` on an existing `DISCORD_DM` delivery row —
 * ONLY if it is still unset (`IS NULL` in the predicate, not an app-layer
 * check), so a retried `createNotification()` call that re-derives the SAME
 * authoritative `operator_commands.command_id` (via `ensureSendDmOperatorCommand`
 * below) is a safe no-op, and the watcher's own concurrent state updates to
 * this same row are never clobbered by a racing retry.
 */
export async function setDeliveryOperatorCommandId(
  db: Executor,
  params: { readonly notificationId: string; readonly operatorCommandId: string },
): Promise<void> {
  await db
    .updateTable("dashboard_notification_deliveries")
    .set({ operator_command_id: params.operatorCommandId })
    .where("notification_id", "=", params.notificationId)
    .where("channel", "=", "DISCORD_DM")
    .where("operator_command_id", "is", null)
    .execute();
}

/**
 * Whether the `DISCORD_DM` delivery row for `notificationId` is ALREADY
 * bound to a real `operator_commands` row (external-review item 6): a
 * retried `createNotification()` call with the SAME `notificationId` but a
 * DIFFERENT `triggeredBy` actor would otherwise slip past the composite
 * `UNIQUE(requested_by_discord_id, target_service, idempotency_key)`
 * constraint entirely — that constraint includes `requested_by_discord_id`,
 * so a different actor on retry does NOT collide with the first insert and
 * would enqueue a genuine SECOND `SEND_DM` command. The caller
 * (`service.ts`) checks this BEFORE attempting to build/enqueue anything on
 * retry: if already bound, the first durable association wins and no
 * second command is ever created or actor mutated.
 */
export async function getDiscordDmDeliveryOperatorCommandId(
  db: Executor,
  notificationId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom("dashboard_notification_deliveries")
    .select("operator_command_id")
    .where("notification_id", "=", notificationId)
    .where("channel", "=", "DISCORD_DM")
    .executeTakeFirst();
  return row?.operator_command_id ?? null;
}

/**
 * Idempotent enqueue of the `SEND_DM` `operator_commands` row (corrections
 * #1/#4). Always returns the AUTHORITATIVE `command_id` for this logical
 * enqueue — on a genuine first insert that is the freshly-generated id
 * passed in; on a retry that collides with the real composite
 * `UNIQUE(requested_by_discord_id, target_service, idempotency_key)`
 * (`0009_operations.up.sql:46`), MySQL applies the no-op
 * `ON DUPLICATE KEY UPDATE command_id = command_id` clause instead of
 * inserting a second row, so the immediate follow-up `SELECT` (below) reads
 * back whichever `command_id` actually won — never trusts
 * `INSERT`'s own `insertId`/local state, which cannot distinguish "I just
 * inserted" from "a duplicate-key update fired" for a non-AUTO_INCREMENT PK.
 */
export async function ensureSendDmOperatorCommand(
  db: Executor,
  params: {
    readonly commandId: string;
    readonly idempotencyKey: string;
    readonly guildId: string | null;
    readonly requestedByDiscordId: string;
    readonly requestedByRole: string;
    readonly payloadJsonText: string;
  },
): Promise<string> {
  await db
    .insertInto("operator_commands")
    .values({
      command_id: params.commandId,
      idempotency_key: params.idempotencyKey,
      command_type: "SEND_DM",
      target_service: "bunny_ocr",
      guild_id: params.guildId === null ? null : bindBigIntUnsigned(params.guildId),
      payload_json: sql`CAST(${params.payloadJsonText} AS JSON)`,
      state: "QUEUED",
      priority: 0,
      max_attempts: 5,
      available_at: new Date(),
      requested_by_discord_id: bindBigIntUnsigned(params.requestedByDiscordId),
      requested_by_role: params.requestedByRole,
    })
    .onDuplicateKeyUpdate({ command_id: sql`command_id` })
    .execute();

  const row = await db
    .selectFrom("operator_commands")
    .select("command_id")
    .where("requested_by_discord_id", "=", bindBigIntUnsigned(params.requestedByDiscordId))
    .where("target_service", "=", "bunny_ocr")
    .where("idempotency_key", "=", params.idempotencyKey)
    .executeTakeFirstOrThrow(
      () =>
        new Error(
          "ensureSendDmOperatorCommand: row missing immediately after upsert — should be unreachable",
        ),
    );
  return row.command_id;
}

export interface ResolvedPreference {
  readonly inAppEnabled: boolean;
  readonly discordDmEnabled: boolean;
}

/**
 * Effective preference for one (user, event_type[, guild]) — Step 10
 * external-review correction round, Section 11: extends this function with
 * an optional guild context, implementing exactly this 3-tier precedence:
 *
 *  1. An explicit `dashboard_notification_preferences` row for
 *     (userId, eventType) ALWAYS wins if present — unchanged from before
 *     this correction (migration 0010's header comment: no row is ever
 *     backfilled at signup, absence just means "never explicitly changed").
 *  2. Else, if `guildId` is provided AND the event's registry `group` is
 *     non-null (a real user-visible, GUILD-scoped preference group — e.g.
 *     `GUILD_APPROVAL_STATE_CHANGE`'s `"GUILD_NEEDS"` — never a
 *     platform-only event like `NEW_GUILD_PENDING`, whose `group` is
 *     `null`), look up that guild's `dashboard_guild_notification_defaults`
 *     row — if one exists, use it.
 *  3. Else, fall back to the registry default exactly as before.
 *
 * `group === null` events are NEVER guild-suppressible by design — a
 * platform/Superadmin-only event's delivery is not something any guild's
 * own default policy can affect, regardless of whether a
 * `dashboard_guild_notification_defaults` row happens to exist for that
 * guild. This is a strictly ADDITIVE extension: with no guild default row
 * anywhere (the pre-Section-11 world), behavior is byte-identical to
 * before — see the regression tests re-running every existing Step 09
 * notification preference test.
 */
export async function resolvePreference(
  db: Executor,
  userId: number,
  eventType: NotificationEventType,
  guildId?: string | null,
): Promise<ResolvedPreference> {
  const row = await db
    .selectFrom("dashboard_notification_preferences")
    .select(["in_app_enabled", "discord_dm_enabled"])
    .where("user_id", "=", userId)
    .where("event_type", "=", eventType)
    .executeTakeFirst();
  if (row) {
    return { inAppEnabled: row.in_app_enabled === 1, discordDmEnabled: row.discord_dm_enabled === 1 };
  }

  const def = NOTIFICATION_EVENT_REGISTRY[eventType];
  if (guildId != null && def.group !== null) {
    const guildDefault = await db
      .selectFrom("dashboard_guild_notification_defaults")
      .select(["in_app_enabled", "discord_dm_enabled"])
      .where("guild_id", "=", guildId)
      .executeTakeFirst();
    if (guildDefault) {
      return {
        inAppEnabled: guildDefault.in_app_enabled === 1,
        discordDmEnabled: guildDefault.discord_dm_enabled === 1,
      };
    }
  }

  return { inAppEnabled: def.defaultInAppEnabled, discordDmEnabled: def.defaultDiscordDmEnabled };
}

/**
 * Upserts a guild's default notification policy row (Step 10 external-review
 * correction round, Section 11) — one row per guild, `updated_by` records
 * the Discord user id of whoever last set it. Wired into the onboarding
 * Notifications section's save path (replacing the prior dead-end
 * `sections_json`-only storage — see `onboardingRepo.ts`).
 */
export async function setGuildNotificationDefault(
  db: Executor,
  params: {
    readonly guildId: string;
    readonly inAppEnabled: boolean;
    readonly discordDmEnabled: boolean;
    readonly updatedBy: string;
  },
): Promise<void> {
  await db
    .insertInto("dashboard_guild_notification_defaults")
    .values({
      guild_id: params.guildId,
      in_app_enabled: params.inAppEnabled ? 1 : 0,
      discord_dm_enabled: params.discordDmEnabled ? 1 : 0,
      updated_by: params.updatedBy,
    })
    .onDuplicateKeyUpdate({
      in_app_enabled: params.inAppEnabled ? 1 : 0,
      discord_dm_enabled: params.discordDmEnabled ? 1 : 0,
      updated_by: params.updatedBy,
    })
    .execute();
}

/** Every event type's EFFECTIVE preference for one user (`GET /api/notifications/preferences`) — registry defaults merged with any materialized override rows. */
export async function resolveAllPreferences(
  db: Executor,
  userId: number,
): Promise<
  ReadonlyArray<
    { eventType: NotificationEventType; group: NotificationPreferenceGroup | null } & ResolvedPreference
  >
> {
  const rows = await db
    .selectFrom("dashboard_notification_preferences")
    .select(["event_type", "in_app_enabled", "discord_dm_enabled"])
    .where("user_id", "=", userId)
    .execute();
  const overrides = new Map(rows.map((r) => [r.event_type, r]));
  return Object.values(NOTIFICATION_EVENT_REGISTRY).map((def) => {
    const override = overrides.get(def.eventType);
    return {
      eventType: def.eventType,
      group: def.group,
      inAppEnabled: override ? override.in_app_enabled === 1 : def.defaultInAppEnabled,
      discordDmEnabled: override ? override.discord_dm_enabled === 1 : def.defaultDiscordDmEnabled,
    };
  });
}

/** Expands one grouped Preferences-screen toggle into its underlying per-event_type rows (18_NOTIFICATIONS_AND_DISCORD_DM.md §Preferences UX) and upserts every one — affects future notifications only, never mutates a historical delivery row (this function never touches `dashboard_notifications`/`dashboard_notification_deliveries` at all). */
export async function upsertPreferenceGroup(
  db: Executor,
  userId: number,
  group: NotificationPreferenceGroup,
  values: { readonly inAppEnabled: boolean; readonly discordDmEnabled: boolean },
): Promise<void> {
  const eventTypes = NOTIFICATION_GROUP_EVENT_TYPES[group];
  for (const eventType of eventTypes) {
    await db
      .insertInto("dashboard_notification_preferences")
      .values({
        user_id: userId,
        event_type: eventType,
        in_app_enabled: values.inAppEnabled ? 1 : 0,
        discord_dm_enabled: values.discordDmEnabled ? 1 : 0,
      })
      .onDuplicateKeyUpdate({
        in_app_enabled: values.inAppEnabled ? 1 : 0,
        discord_dm_enabled: values.discordDmEnabled ? 1 : 0,
      })
      .execute();
  }
}

export interface NotificationListRow {
  readonly id: string;
  readonly event_type: string;
  readonly message_key: string;
  readonly parameters_json: unknown;
  readonly guild_id: string | null;
  readonly deeplink_path: string;
  readonly read_at: Date | null;
  readonly dismissed_at: Date | null;
  readonly created_at: Date;
  readonly discord_dm_state: string | null;
}

/**
 * IDOR-safe (WHERE user_id = :userId in the predicate) cursor-paginated
 * list, newest first (ULID `id` is time-sortable).
 *
 * External-review item 2/8: INNER-joins `dashboard_notification_deliveries`
 * on `channel='IN_APP' AND state='SENT'` — a notification whose recipient
 * had `in_app_enabled=false` at creation time gets an `IN_APP` delivery row
 * permanently stuck at `SKIPPED_PREFERENCE` (`service.ts`'s
 * `createNotification`, step 4). That row is durable truth (never deleted —
 * `18_NOTIFICATIONS_AND_DISCORD_DM.md`'s durable-row-first contract), but
 * per that same contract it must never render as a Notification Center
 * item — the INNER join (not a LEFT join) excludes it structurally, the
 * same way the query already excludes dismissed rows by default.
 */
export async function listNotificationsForUser(
  db: Executor,
  userId: number,
  params: { readonly cursor: string | undefined; readonly limit: number; readonly includeDismissed: boolean },
): Promise<NotificationListRow[]> {
  let query = db
    .selectFrom("dashboard_notifications as n")
    .innerJoin("dashboard_notification_deliveries as in_app", (join) =>
      join
        .onRef("in_app.notification_id", "=", "n.id")
        .on("in_app.channel", "=", "IN_APP")
        .on("in_app.state", "=", "SENT"),
    )
    .leftJoin("dashboard_notification_deliveries as d", (join) =>
      join.onRef("d.notification_id", "=", "n.id").on("d.channel", "=", "DISCORD_DM"),
    )
    .select([
      "n.id",
      "n.event_type",
      "n.message_key",
      "n.parameters_json",
      "n.guild_id",
      "n.deeplink_path",
      "n.read_at",
      "n.dismissed_at",
      "n.created_at",
      "d.state as discord_dm_state",
    ])
    .where("n.user_id", "=", userId)
    .orderBy("n.id", "desc")
    .limit(params.limit);
  if (!params.includeDismissed) {
    query = query.where("n.dismissed_at", "is", null);
  }
  if (params.cursor !== undefined) {
    query = query.where("n.id", "<", params.cursor);
  }
  return query.execute();
}

/**
 * Unread count = `read_at IS NULL AND dismissed_at IS NULL AND` the
 * `IN_APP` delivery's state is `SENT` (never `SKIPPED_PREFERENCE` —
 * external-review item 2/8's exact documented predicate). The `INNER JOIN`
 * mirrors `listNotificationsForUser`'s own IN_APP-visibility gate so the
 * nav badge and the Notification Center list can never disagree about
 * which rows are "visible."
 */
export async function countUnreadForUser(db: Executor, userId: number): Promise<number> {
  const row = await db
    .selectFrom("dashboard_notifications as n")
    .innerJoin("dashboard_notification_deliveries as in_app", (join) =>
      join
        .onRef("in_app.notification_id", "=", "n.id")
        .on("in_app.channel", "=", "IN_APP")
        .on("in_app.state", "=", "SENT"),
    )
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("n.user_id", "=", userId)
    .where("n.read_at", "is", null)
    .where("n.dismissed_at", "is", null)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

/** IDOR-safe: the UPDATE's own WHERE clause scopes to `user_id`, so an id belonging to another user matches zero rows rather than relying on a prior app-layer ownership check. Returns whether a row was actually affected. */
export async function markNotificationRead(db: Executor, userId: number, id: string): Promise<boolean> {
  const result = await db
    .updateTable("dashboard_notifications")
    .set({ read_at: new Date() })
    .where("id", "=", id)
    .where("user_id", "=", userId)
    .where("read_at", "is", null)
    .executeTakeFirst();
  return (result.numUpdatedRows ?? 0n) > 0n;
}

export async function markNotificationDismissed(db: Executor, userId: number, id: string): Promise<boolean> {
  const result = await db
    .updateTable("dashboard_notifications")
    .set({ dismissed_at: new Date() })
    .where("id", "=", id)
    .where("user_id", "=", userId)
    .where("dismissed_at", "is", null)
    .executeTakeFirst();
  return (result.numUpdatedRows ?? 0n) > 0n;
}

/** Whether `id` exists at all AND belongs to `userId` — used by the routes to distinguish 404 (no such notification / not yours, IDOR-safe: identical response either way) from "already in the target state" (200 idempotent no-op). */
export async function notificationBelongsToUser(db: Executor, userId: number, id: string): Promise<boolean> {
  const row = await db
    .selectFrom("dashboard_notifications")
    .select("id")
    .where("id", "=", id)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return row !== undefined;
}

export async function markAllReadForUser(db: Executor, userId: number): Promise<void> {
  await db
    .updateTable("dashboard_notifications")
    .set({ read_at: new Date() })
    .where("user_id", "=", userId)
    .where("read_at", "is", null)
    .execute();
}

/**
 * SSE `SourceAdapter.fetchSince` backing query — global (not user-scoped);
 * the caller (`sseAdapter.ts`) derives each row's channel scope from
 * `user_id` per row, never trusts a query-level filter to do authorization.
 *
 * External-review item 2: LEFT-joins the `IN_APP` delivery row to report
 * `in_app_visible` (`state = 'SENT'`) per row, WITHOUT excluding any row
 * from the returned set — every `dashboard_notifications` row newer than
 * `sinceOrdinal` is still returned here regardless of preference, so the
 * SSE poller's own cursor-advancement logic (`sse/poller.ts`: `maxOrdinal`
 * is computed from `fetchSince`'s RETURNED rows) keeps advancing past a
 * `SKIPPED_PREFERENCE` row exactly like any other row — filtering it out of
 * this array instead would starve the cursor: the next tick would refetch
 * the SAME skipped row forever and never reach anything newer.
 * `sseAdapter.ts` uses `in_app_visible` to decide the SSE payload's
 * `inAppVisible` flag; the frontend uses that flag (never a raw
 * `notification.created` arrival) to decide whether to render a list
 * item/increment the badge/announce via `aria-live`.
 */
export async function fetchNotificationsSinceSseSeq(
  db: Kysely<DB>,
  sinceOrdinal: number,
  limit: number,
): Promise<
  Array<{
    sse_seq: number;
    id: string;
    user_id: number;
    message_key: string;
    parameters_json: unknown;
    created_at: Date;
    in_app_visible: boolean;
  }>
> {
  const rows = await db
    .selectFrom("dashboard_notifications as n")
    .leftJoin("dashboard_notification_deliveries as in_app", (join) =>
      join.onRef("in_app.notification_id", "=", "n.id").on("in_app.channel", "=", "IN_APP"),
    )
    .select([
      "n.sse_seq",
      "n.id",
      "n.user_id",
      "n.message_key",
      "n.parameters_json",
      "n.created_at",
      "in_app.state as in_app_state",
    ])
    .where("n.sse_seq", ">", sinceOrdinal)
    .orderBy("n.sse_seq", "asc")
    .limit(limit)
    .execute();
  return rows.map((row) => ({
    sse_seq: row.sse_seq,
    id: row.id,
    user_id: row.user_id,
    message_key: row.message_key,
    parameters_json: row.parameters_json,
    created_at: row.created_at,
    in_app_visible: row.in_app_state === "SENT",
  }));
}

export async function oldestNotificationSseSeq(db: Kysely<DB>): Promise<number | null> {
  const row = await db
    .selectFrom("dashboard_notifications")
    .select((eb) => eb.fn.min("sse_seq").as("min_seq"))
    .executeTakeFirst();
  return row?.min_seq === null || row?.min_seq === undefined ? null : Number(row.min_seq);
}

/** Reconciliation watcher's own scan — every `DISCORD_DM` delivery still `PENDING` with a known `operator_command_id` (correction #2: observation-only, never re-enqueues). */
export async function findPendingDiscordDmDeliveries(
  db: Kysely<DB>,
  limit: number,
): Promise<Array<{ notification_id: string; operator_command_id: string }>> {
  const rows = await db
    .selectFrom("dashboard_notification_deliveries")
    .select(["notification_id", "operator_command_id"])
    .where("channel", "=", "DISCORD_DM")
    .where("state", "=", "PENDING")
    .where("operator_command_id", "is not", null)
    .limit(limit)
    .execute();
  return rows as Array<{ notification_id: string; operator_command_id: string }>;
}

export async function findOperatorCommandStateById(
  db: Kysely<DB>,
  commandId: string,
): Promise<{ state: string; last_error_code: string | null } | undefined> {
  return db
    .selectFrom("operator_commands")
    .select(["state", "last_error_code"])
    .where("command_id", "=", commandId)
    .executeTakeFirst();
}

export async function updateDiscordDmDeliveryState(
  db: Kysely<DB>,
  notificationId: string,
  newState: "SENT" | "FAILED",
): Promise<void> {
  await db
    .updateTable("dashboard_notification_deliveries")
    .set({ state: newState, attempt_count: sql`attempt_count + 1`, last_attempted_at: new Date() })
    .where("notification_id", "=", notificationId)
    .where("channel", "=", "DISCORD_DM")
    .where("state", "=", "PENDING")
    .execute();
}
