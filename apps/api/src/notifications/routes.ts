/**
 * `/api/notifications*` (24_API_CONTRACTS.md §Notifications). Session auth +
 * CSRF header on every mutation, Zod-validated params/query/body, `{ data }`
 * success envelope — same conventions as `apps/guilds/routes.ts`. Every
 * by-id mutation is IDOR-safe in the DB predicate itself (`repo.ts`'s own
 * `WHERE user_id = :userId` on every by-id query/update — never an
 * app-layer post-filter).
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { DB } from "../db/codegen-types.js";
import type { AppConfig } from "../config.js";
import {
  ADMIN_ONLY_PREFERENCE_GROUPS,
  FALLBACK_LOCALE,
  isSupportedLocale,
  NOTIFICATION_PREFERENCE_GROUPS,
  notificationIdParamSchema,
  notificationListQuerySchema,
  notificationPreferencesUpdateRequestSchema,
  type NotificationPreferenceGroup,
} from "@bunny-command-center/shared";
import { buildRequireAuth, requireCsrfHeader } from "../auth/requireAuth.js";
import { createGuildAuthDeps, isGuildAdminCapableAnywhere, type GuildAuthDeps } from "../auth/index.js";
import { renderMessage } from "./render.js";
import {
  countUnreadForUser,
  listNotificationsForUser,
  markAllReadForUser,
  markNotificationDismissed,
  markNotificationRead,
  notificationBelongsToUser,
  resolveAllPreferences,
  upsertPreferenceGroup,
  type NotificationDeliveryState,
} from "./repo.js";

/**
 * Resolves exactly which `NOTIFICATION_PREFERENCE_GROUPS` this caller should
 * be shown as a togglable Preferences-screen row (role-aware visibility
 * correction, "Separate admin alert notification preferences") —
 * `ADMIN_ONLY_PREFERENCE_GROUPS` (packages/shared) is the ONE static list of
 * WHICH groups need gating; this function is the ONE place that resolves it
 * against a real caller's live RBAC state
 * (`isGuildAdminCapableAnywhere`, Step 05's existing Guild Admin Resolution
 * machinery — never a second, parallel authorization model). Never throws —
 * `isGuildAdminCapableAnywhere` itself fails closed to `false` on any error
 * resolving the caller's guild list.
 */
async function resolveVisibleGroups(
  guildAuthDeps: GuildAuthDeps,
  caller: { id: number; discordUserId: string },
): Promise<NotificationPreferenceGroup[]> {
  const isAdminCapable = await isGuildAdminCapableAnywhere(guildAuthDeps, caller);
  return NOTIFICATION_PREFERENCE_GROUPS.filter(
    (group) => isAdminCapable || !ADMIN_ONLY_PREFERENCE_GROUPS.includes(group),
  );
}

async function validationError(reply: FastifyReply): Promise<void> {
  await reply.code(400).send({ error_code: "VALIDATION_ERROR", message_key: "errors.validation", parameters: {} });
}

async function notFound(reply: FastifyReply): Promise<void> {
  await reply.code(404).send({
    error_code: "NOTIFICATION_NOT_FOUND",
    message_key: "errors.notifications.notFound",
    parameters: {},
  });
}

export function buildNotificationRoutes(
  db: Kysely<DB>,
  config: AppConfig,
  guildAuthDepsOverride?: GuildAuthDeps,
): FastifyPluginAsync {
  const requireAuth = buildRequireAuth(db, config);
  // Mirrors `apps/api/src/guilds/routes.ts`'s own `guildAuthDepsOverride`
  // convention — `server.ts` passes the ONE shared `GuildAuthDeps` instance
  // (one `GuildAuthCache`) it already builds for the guild routes, so this
  // module's `isGuildAdminCapableAnywhere` calls share the same 60s
  // micro-cache rather than standing up a second, independent one.
  const guildAuthDeps = guildAuthDepsOverride ?? createGuildAuthDeps(db, config);

  // eslint-disable-next-line @typescript-eslint/require-await -- FastifyPluginAsync's contract
  return async (fastify) => {
    // -----------------------------------------------------------------
    // GET /api/notifications — cursor-paginated, newest first. Renders
    // message_key+parameters into the CALLER's current locale server-side
    // (18_NOTIFICATIONS_AND_DISCORD_DM.md §Localization: "rendered ... at
    // delivery/render time, never at creation time") — the client never
    // re-renders a template itself.
    // -----------------------------------------------------------------
    fastify.get("/api/notifications", { preHandler: [requireAuth] }, async (request, reply) => {
      const parsedQuery = notificationListQuerySchema.safeParse(request.query);
      if (!parsedQuery.success) {
        return validationError(reply);
      }
      const userId = request.authUser!.id;
      const locale = isSupportedLocale(request.authUser!.locale) ? request.authUser!.locale : FALLBACK_LOCALE;
      const limit = parsedQuery.data.limit ?? 25;
      const rows = await listNotificationsForUser(db, userId, {
        cursor: parsedQuery.data.cursor,
        limit,
        includeDismissed: parsedQuery.data.includeDismissed ?? false,
      });
      const unreadCount = await countUnreadForUser(db, userId);
      const items = rows.map((row) => ({
        id: row.id,
        eventType: row.event_type,
        message: renderMessage(locale, row.message_key, (row.parameters_json ?? {}) as Record<string, unknown>),
        guildId: row.guild_id,
        deeplinkPath: row.deeplink_path,
        readAt: row.read_at ? row.read_at.toISOString() : null,
        dismissedAt: row.dismissed_at ? row.dismissed_at.toISOString() : null,
        createdAt: row.created_at.toISOString(),
        discordDmState: (row.discord_dm_state as NotificationDeliveryState | null) ?? null,
      }));
      const nextCursor = rows.length === limit ? (rows[rows.length - 1]?.id ?? null) : null;
      return { data: { items, nextCursor, unreadCount } };
    });

    // -----------------------------------------------------------------
    // PUT /api/notifications/:id/read
    // -----------------------------------------------------------------
    fastify.put(
      "/api/notifications/:id/read",
      { preHandler: [requireAuth, requireCsrfHeader] },
      async (request: FastifyRequest, reply: FastifyReply) => {
        if (reply.sent) return undefined;
        const parsedParams = notificationIdParamSchema.safeParse(request.params);
        if (!parsedParams.success) {
          return validationError(reply);
        }
        const userId = request.authUser!.id;
        const changed = await markNotificationRead(db, userId, parsedParams.data.id);
        if (!changed && !(await notificationBelongsToUser(db, userId, parsedParams.data.id))) {
          return notFound(reply);
        }
        return { data: { id: parsedParams.data.id, read: true } };
      },
    );

    // -----------------------------------------------------------------
    // PUT /api/notifications/:id/dismiss
    // -----------------------------------------------------------------
    fastify.put(
      "/api/notifications/:id/dismiss",
      { preHandler: [requireAuth, requireCsrfHeader] },
      async (request: FastifyRequest, reply: FastifyReply) => {
        if (reply.sent) return undefined;
        const parsedParams = notificationIdParamSchema.safeParse(request.params);
        if (!parsedParams.success) {
          return validationError(reply);
        }
        const userId = request.authUser!.id;
        const changed = await markNotificationDismissed(db, userId, parsedParams.data.id);
        if (!changed && !(await notificationBelongsToUser(db, userId, parsedParams.data.id))) {
          return notFound(reply);
        }
        return { data: { id: parsedParams.data.id, dismissed: true } };
      },
    );

    // -----------------------------------------------------------------
    // PUT /api/notifications/mark-all-read
    // -----------------------------------------------------------------
    fastify.put(
      "/api/notifications/mark-all-read",
      { preHandler: [requireAuth, requireCsrfHeader] },
      async (request, reply) => {
        if (reply.sent) return undefined;
        await markAllReadForUser(db, request.authUser!.id);
        return { data: { markedAllRead: true } };
      },
    );

    // -----------------------------------------------------------------
    // GET /api/notifications/preferences — grouped for the UI
    // (18_NOTIFICATIONS_AND_DISCORD_DM.md §Preferences UX), but returns the
    // full per-event_type resolution too (`group: null` rows included) so
    // nothing is silently hidden from a caller that wants the precise data.
    // `visibleGroups` (role-aware visibility correction) additionally
    // reports which of `NOTIFICATION_PREFERENCE_GROUPS` this exact caller
    // should be shown as a togglable row — `preferences` itself is NEVER
    // narrowed by this (a non-admin-capable caller's `ADMIN_ALERT` row is
    // still present and correct in `preferences`, only absent from
    // `visibleGroups` — presentation/authorization-gating only, never a
    // data-model change).
    // -----------------------------------------------------------------
    fastify.get("/api/notifications/preferences", { preHandler: [requireAuth] }, async (request) => {
      const authUser = request.authUser!;
      const [preferences, visibleGroups] = await Promise.all([
        resolveAllPreferences(db, authUser.id),
        resolveVisibleGroups(guildAuthDeps, { id: authUser.id, discordUserId: authUser.discordUserId }),
      ]);
      return { data: { preferences, visibleGroups } };
    });

    // -----------------------------------------------------------------
    // PUT /api/notifications/preferences — grouped update (never a raw
    // per-event body from the client, task brief: "the client never sends a
    // raw per-event body"). Affects future notifications only — this route
    // never touches dashboard_notifications/dashboard_notification_deliveries.
    // Deliberately NOT gated by `ADMIN_ONLY_PREFERENCE_GROUPS`/`visibleGroups`
    // — role-aware visibility is a presentation concern only (which rows the
    // real UI renders); a caller writing a group's preference directly
    // (e.g. `ADMIN_ALERTS`) is still accepted exactly as every other group
    // already is. This matches the product decision's own framing:
    // preference PERSISTENCE stays per-event-type underneath exactly as it
    // already was, unchanged by this correction.
    // -----------------------------------------------------------------
    fastify.put(
      "/api/notifications/preferences",
      { preHandler: [requireAuth, requireCsrfHeader] },
      async (request, reply) => {
        if (reply.sent) return undefined;
        const parsedBody = notificationPreferencesUpdateRequestSchema.safeParse(request.body);
        if (!parsedBody.success) {
          return validationError(reply);
        }
        const authUser = request.authUser!;
        const userId = authUser.id;
        for (const groupUpdate of parsedBody.data.groups) {
          await upsertPreferenceGroup(db, userId, groupUpdate.group, {
            inAppEnabled: groupUpdate.inAppEnabled,
            discordDmEnabled: groupUpdate.discordDmEnabled,
          });
        }
        const [preferences, visibleGroups] = await Promise.all([
          resolveAllPreferences(db, userId),
          resolveVisibleGroups(guildAuthDeps, { id: userId, discordUserId: authUser.discordUserId }),
        ]);
        return { data: { preferences, visibleGroups } };
      },
    );
  };
}
