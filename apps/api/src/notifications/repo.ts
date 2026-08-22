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

/** Idempotent — a retry with the SAME `id` never overwrites an existing row (the composite "ensure" semantics this step's task brief calls for: "if provided, reuse it (retry-safe)"). */
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
      () => new Error("ensureSendDmOperatorCommand: row missing immediately after upsert — should be unreachable"),
    );
  return row.command_id;
}

export interface ResolvedPreference {
  readonly inAppEnabled: boolean;
  readonly discordDmEnabled: boolean;
}

/** Effective preference for one (user, event_type) — a materialized row wins; absent falls back to the registry default (migration 0010's header comment: no row is ever backfilled at signup). */
export async function resolvePreference(
  db: Executor,
  userId: number,
  eventType: NotificationEventType,
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
  return { inAppEnabled: def.defaultInAppEnabled, discordDmEnabled: def.defaultDiscordDmEnabled };
}

/** Every event type's EFFECTIVE preference for one user (`GET /api/notifications/preferences`) — registry defaults merged with any materialized override rows. */
export async function resolveAllPreferences(
  db: Executor,
  userId: number,
): Promise<ReadonlyArray<{ eventType: NotificationEventType; group: NotificationPreferenceGroup | null } & ResolvedPreference>> {
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

/** IDOR-safe (WHERE user_id = :userId in the predicate) cursor-paginated list, newest first (ULID `id` is time-sortable). */
export async function listNotificationsForUser(
  db: Executor,
  userId: number,
  params: { readonly cursor: string | undefined; readonly limit: number; readonly includeDismissed: boolean },
): Promise<NotificationListRow[]> {
  let query = db
    .selectFrom("dashboard_notifications as n")
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

export async function countUnreadForUser(db: Executor, userId: number): Promise<number> {
  const row = await db
    .selectFrom("dashboard_notifications")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("user_id", "=", userId)
    .where("read_at", "is", null)
    .where("dismissed_at", "is", null)
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

/** SSE `SourceAdapter.fetchSince` backing query — global (not user-scoped); the caller (`sseAdapter.ts`) derives each row's channel scope from `user_id` per row, never trusts a query-level filter to do authorization. */
export async function fetchNotificationsSinceSseSeq(
  db: Kysely<DB>,
  sinceOrdinal: number,
  limit: number,
): Promise<Array<{ sse_seq: number; id: string; user_id: number; message_key: string; parameters_json: unknown; created_at: Date }>> {
  const rows = await db
    .selectFrom("dashboard_notifications")
    .select(["sse_seq", "id", "user_id", "message_key", "parameters_json", "created_at"])
    .where("sse_seq", ">", sinceOrdinal)
    .orderBy("sse_seq", "asc")
    .limit(limit)
    .execute();
  return rows;
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
