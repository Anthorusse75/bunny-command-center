// Step 09 (Notifications) shared request/response shapes
// (24_API_CONTRACTS.md §Notifications, ADR-014's "validated by Zod schemas
// in packages/shared"). Mirrors the pattern `./guilds.ts` established in
// Step 06 — `apps/api` validates inbound params/bodies against these same
// schemas, `apps/web` uses the inferred types instead of a second,
// independently-maintained copy.
import { z } from "zod";
import {
  notificationEventTypeSchema,
  notificationPreferenceGroupSchema,
} from "../constants/notifications.js";
import { discordSnowflakeSchema } from "./guilds.js";

/** CHAR26 id shape (`apps/api/src/notifications/id.ts`'s ULID generator) — reused for both notification and (value-referenced) `operator_commands` command ids. */
export const notificationIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "must be a CHAR26 id");

export const notificationDeliveryChannelSchema = z.enum(["IN_APP", "DISCORD_DM"]);
export type NotificationDeliveryChannel = z.infer<typeof notificationDeliveryChannelSchema>;

export const notificationDeliveryStateSchema = z.enum(["PENDING", "SENT", "FAILED", "SKIPPED_PREFERENCE"]);
export type NotificationDeliveryState = z.infer<typeof notificationDeliveryStateSchema>;

/** One row in `GET /api/notifications`'s list — mirrors `apps/api/src/notifications/repo.ts`'s `NotificationListItem`, already rendered into the caller's current locale (`messageKey`+`parameters` resolved server-side into `message`, never shipped raw to the client — SCREENS/NOTIFICATIONS.md never re-renders a template client-side). */
export const notificationListItemSchema = z
  .object({
    id: notificationIdSchema,
    eventType: notificationEventTypeSchema,
    message: z.string(),
    guildId: discordSnowflakeSchema.nullable(),
    deeplinkPath: z.string(),
    readAt: z.string().nullable(),
    dismissedAt: z.string().nullable(),
    createdAt: z.string(),
    discordDmState: notificationDeliveryStateSchema.nullable(),
  })
  .strict();
export type NotificationListItem = z.infer<typeof notificationListItemSchema>;

export const notificationListQuerySchema = z
  .object({
    cursor: notificationIdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25).optional(),
    includeDismissed: z.coerce.boolean().default(false).optional(),
  })
  .strict();
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

export const notificationListResponseSchema = z
  .object({
    items: z.array(notificationListItemSchema),
    nextCursor: notificationIdSchema.nullable(),
    unreadCount: z.number().int().nonnegative(),
  })
  .strict();
export type NotificationListResponse = z.infer<typeof notificationListResponseSchema>;

export const notificationIdParamSchema = z.object({ id: notificationIdSchema }).strict();

/** `GET /api/notifications/preferences` response — one row per event type the caller has an EFFECTIVE resolved preference for (registry default when no `dashboard_notification_preferences` row exists yet — 18_NOTIFICATIONS_AND_DISCORD_DM.md never requires materializing a row per user per event at signup). */
export const notificationPreferenceRowSchema = z
  .object({
    eventType: notificationEventTypeSchema,
    group: notificationPreferenceGroupSchema.nullable(),
    inAppEnabled: z.boolean(),
    discordDmEnabled: z.boolean(),
  })
  .strict();
export type NotificationPreferenceRow = z.infer<typeof notificationPreferenceRowSchema>;

/**
 * `visibleGroups` — exactly the subset of `NOTIFICATION_PREFERENCE_GROUPS`
 * the CALLER should be shown as a togglable Preferences-screen row, resolved
 * server-side against the caller's live RBAC state (role-aware visibility
 * correction, "Separate admin alert notification preferences" —
 * `ADMIN_ONLY_PREFERENCE_GROUPS` in `../constants/notifications.js`). The
 * `preferences` array itself is UNCHANGED by this — it still reports every
 * event type's full effective resolution regardless of group visibility
 * (this is a presentation/authorization-gating concern only, never a
 * narrowing of the underlying per-event-type data). `apps/web`'s Preferences
 * screen renders exactly `visibleGroups`, never the full static
 * `NOTIFICATION_PREFERENCE_GROUPS` list directly.
 */
export const notificationPreferencesResponseSchema = z
  .object({
    preferences: z.array(notificationPreferenceRowSchema),
    visibleGroups: z.array(notificationPreferenceGroupSchema),
  })
  .strict();
export type NotificationPreferencesResponse = z.infer<typeof notificationPreferencesResponseSchema>;

/**
 * `PUT /api/notifications/preferences` request — GROUPED, per
 * 18_NOTIFICATIONS_AND_DISCORD_DM.md §Preferences UX ("a `dashboard_notification_preferences`
 * 'group' mapping ... expands one UI toggle into however many underlying
 * `event_type` rows it covers"). The client never sends a raw per-event
 * body; `apps/api` expands `group` -> `NOTIFICATION_GROUP_EVENT_TYPES[group]`
 * server-side (single source of truth, `constants/notifications.ts`) before
 * writing individual `(user_id, event_type)` rows.
 */
export const notificationPreferenceGroupUpdateSchema = z
  .object({
    group: notificationPreferenceGroupSchema,
    inAppEnabled: z.boolean(),
    discordDmEnabled: z.boolean(),
  })
  .strict();
export const notificationPreferencesUpdateRequestSchema = z
  .object({ groups: z.array(notificationPreferenceGroupUpdateSchema).min(1) })
  .strict();
export type NotificationPreferencesUpdateRequest = z.infer<typeof notificationPreferencesUpdateRequestSchema>;
