// Data-driven notification event registry (Step 09,
// DASHBOARD/18_NOTIFICATIONS_AND_DISCORD_DM.md's event/channel/default/
// rate-limit matrix + §Preferences UX grouping). Single source of truth on
// both apps/api (createNotification's preference-default resolution, the
// server-side DM content renderer) and apps/web (the grouped Preferences
// screen) — neither side hand-duplicates this list.
//
// SCOPE NOTE (00_GLOBAL_IMPLEMENTATION_RULES.md #1 — explicit, not silent):
// this step implements ONLY the registry entries and the generic
// `createNotification()` mechanism that later steps call. It never fires any
// of these events itself — the cooldown/rate-limit metadata below is
// DESCRIPTIVE (documents the intended limiter each owning step must apply
// when it wires the real trigger), not an ENFORCED limiter in this step's
// `createNotification()`, which is deliberately a plain, unconditional
// "create if called" primitive with no rate-limiting state of its own.
//
// GROUP-MAPPING DEVIATION, reported explicitly (00_GLOBAL_IMPLEMENTATION_RULES.md
// #1 / this step's own instructions: "If any event doesn't map unambiguously
// to a documented group ... report it explicitly"): 18_NOTIFICATIONS_AND_DISCORD_DM.md
// §Preferences UX names exactly 5 groups ("Uploads," "Guild needs,"
// "PremiumPlus," "Leaderboard & badges," "Weekly summary"), all framed around
// a Guild Admin/USER's own guild experience. `NEW_GUILD_PENDING` and
// `HERO_DISCOVERY_CANDIDATE_READY` are Superadmin-only, platform-level
// events with no unambiguous fit in any of the 5 — forcing either into an
// existing group would misrepresent what that group's toggle controls, and
// SCREENS/NOTIFICATIONS.md's Preferences mock shows exactly 5 rows, so
// inventing a 6th "Platform/Admin" row would be new, undocumented UX. Chosen
// narrowest-safe behavior: both stay fully registered here (their matrix
// defaults apply, `createNotification()` works for them today) but their
// `group` is `null` — NOT rendered as a togglable row on this step's
// Preferences screen. A real Superadmin preferences surface, if ever
// needed, is left for whichever later step actually builds Superadmin
// settings UI. `ADMIN_ALERT` and `GUILD_APPROVAL_STATE_CHANGE` DO map
// unambiguously — both are guild-admin-facing, guild-operational-health
// notifications, placed under "Guild needs" alongside `URGENT_GUILD_NEED`.
import { z } from "zod";

export const NOTIFICATION_EVENT_TYPES = [
  "UPLOAD_COMPLETED",
  "UPLOAD_PROBLEM",
  "URGENT_GUILD_NEED",
  "PREMIUMPLUS_REACHED",
  "BADGE_EARNED",
  "RANKING_TOP3_CHANGE",
  "WEEKLY_SUMMARY",
  "GUILD_APPROVAL_STATE_CHANGE",
  "NEW_GUILD_PENDING",
  "ADMIN_ALERT",
  "HERO_DISCOVERY_CANDIDATE_READY",
] as const;
export const notificationEventTypeSchema = z.enum(NOTIFICATION_EVENT_TYPES);
export type NotificationEventType = z.infer<typeof notificationEventTypeSchema>;

/** The 5 documented Preferences-screen groups (18_NOTIFICATIONS_AND_DISCORD_DM.md §Preferences UX). */
export const NOTIFICATION_PREFERENCE_GROUPS = [
  "UPLOADS",
  "GUILD_NEEDS",
  "PREMIUMPLUS",
  "LEADERBOARD_BADGES",
  "WEEKLY_SUMMARY",
] as const;
export const notificationPreferenceGroupSchema = z.enum(NOTIFICATION_PREFERENCE_GROUPS);
export type NotificationPreferenceGroup = z.infer<typeof notificationPreferenceGroupSchema>;

/** Descriptive only — see file header. Never enforced by `createNotification()` itself. */
export type NotificationCooldownMetadata =
  | { readonly kind: "NONE" }
  | { readonly kind: "PER_GUILD_PER_HOURS"; readonly hours: number }
  | { readonly kind: "PER_GUILD_PER_SEASON" }
  | { readonly kind: "WEEKLY_OPT_IN" }
  | { readonly kind: "PER_INCIDENT_OPEN" }
  | { readonly kind: "ONCE_THEN_REFIRE_ON_EVIDENCE_GROWTH" };

export interface NotificationEventDefinition {
  readonly eventType: NotificationEventType;
  /** i18n key rendering the notification's one canonical sentence — used both as the in-app list item's primary text AND (server-rendered, apps/api) as the Discord DM `content`. Interpolated with the notification's `parameters`. */
  readonly messageKey: string;
  readonly defaultInAppEnabled: boolean;
  readonly defaultDiscordDmEnabled: boolean;
  /** `null` = not exposed as a togglable Preferences row this step — see file header "GROUP-MAPPING DEVIATION". */
  readonly group: NotificationPreferenceGroup | null;
  readonly cooldown: NotificationCooldownMetadata;
  /** Documents which screen family this event's `deeplinkPath` (set by the calling/owning step at creation time — this registry never computes a concrete path) targets. */
  readonly deeplinkCategory: string;
}

export const NOTIFICATION_EVENT_REGISTRY: Readonly<
  Record<NotificationEventType, NotificationEventDefinition>
> = {
  UPLOAD_COMPLETED: {
    eventType: "UPLOAD_COMPLETED",
    messageKey: "notifications.events.uploadCompleted.message",
    defaultInAppEnabled: true,
    defaultDiscordDmEnabled: true,
    group: "UPLOADS",
    cooldown: { kind: "NONE" },
    deeplinkCategory: "CONTRIBUTIONS_BATCH",
  },
  UPLOAD_PROBLEM: {
    eventType: "UPLOAD_PROBLEM",
    messageKey: "notifications.events.uploadProblem.message",
    defaultInAppEnabled: true,
    defaultDiscordDmEnabled: true,
    group: "UPLOADS",
    cooldown: { kind: "NONE" },
    deeplinkCategory: "UPLOAD_RESUME",
  },
  URGENT_GUILD_NEED: {
    eventType: "URGENT_GUILD_NEED",
    messageKey: "notifications.events.urgentGuildNeed.message",
    defaultInAppEnabled: true,
    defaultDiscordDmEnabled: true,
    group: "GUILD_NEEDS",
    cooldown: { kind: "PER_GUILD_PER_HOURS", hours: 24 },
    deeplinkCategory: "GUILD_OVERVIEW",
  },
  PREMIUMPLUS_REACHED: {
    eventType: "PREMIUMPLUS_REACHED",
    messageKey: "notifications.events.premiumPlusReached.message",
    defaultInAppEnabled: true,
    defaultDiscordDmEnabled: true,
    group: "PREMIUMPLUS",
    cooldown: { kind: "PER_GUILD_PER_SEASON" },
    deeplinkCategory: "GUILD_PREMIUMPLUS",
  },
  BADGE_EARNED: {
    eventType: "BADGE_EARNED",
    messageKey: "notifications.events.badgeEarned.message",
    defaultInAppEnabled: true,
    defaultDiscordDmEnabled: false,
    group: "LEADERBOARD_BADGES",
    cooldown: { kind: "NONE" },
    deeplinkCategory: "PROFILE_BADGES",
  },
  RANKING_TOP3_CHANGE: {
    eventType: "RANKING_TOP3_CHANGE",
    messageKey: "notifications.events.rankingTop3Change.message",
    defaultInAppEnabled: true,
    defaultDiscordDmEnabled: false,
    group: "LEADERBOARD_BADGES",
    cooldown: { kind: "PER_GUILD_PER_HOURS", hours: 24 },
    deeplinkCategory: "GUILD_LEADERBOARD",
  },
  WEEKLY_SUMMARY: {
    eventType: "WEEKLY_SUMMARY",
    messageKey: "notifications.events.weeklySummary.message",
    defaultInAppEnabled: false,
    defaultDiscordDmEnabled: false,
    group: "WEEKLY_SUMMARY",
    cooldown: { kind: "WEEKLY_OPT_IN" },
    deeplinkCategory: "CONTRIBUTIONS",
  },
  GUILD_APPROVAL_STATE_CHANGE: {
    eventType: "GUILD_APPROVAL_STATE_CHANGE",
    messageKey: "notifications.events.guildApprovalStateChange.message",
    defaultInAppEnabled: true,
    defaultDiscordDmEnabled: true,
    group: "GUILD_NEEDS",
    cooldown: { kind: "NONE" },
    deeplinkCategory: "GUILD_ONBOARDING_OR_REVIEW",
  },
  NEW_GUILD_PENDING: {
    eventType: "NEW_GUILD_PENDING",
    messageKey: "notifications.events.newGuildPending.message",
    defaultInAppEnabled: true,
    defaultDiscordDmEnabled: true,
    group: null,
    cooldown: { kind: "NONE" },
    deeplinkCategory: "ADMIN_GUILD_REVIEW",
  },
  ADMIN_ALERT: {
    eventType: "ADMIN_ALERT",
    messageKey: "notifications.events.adminAlert.message",
    defaultInAppEnabled: true,
    defaultDiscordDmEnabled: false,
    group: "GUILD_NEEDS",
    cooldown: { kind: "PER_INCIDENT_OPEN" },
    deeplinkCategory: "GUILD_TECHNICAL",
  },
  HERO_DISCOVERY_CANDIDATE_READY: {
    eventType: "HERO_DISCOVERY_CANDIDATE_READY",
    messageKey: "notifications.events.heroDiscoveryCandidateReady.message",
    defaultInAppEnabled: true,
    defaultDiscordDmEnabled: true,
    group: null,
    cooldown: { kind: "ONCE_THEN_REFIRE_ON_EVIDENCE_GROWTH" },
    deeplinkCategory: "ADMIN_HERO_DISCOVERY_CANDIDATE",
  },
};

/** Every event whose `group` is non-null, grouped — this IS the "one data-driven group→event_types mapping" the Preferences screen expands (18_NOTIFICATIONS_AND_DISCORD_DM.md §Preferences UX), never hardcoded per-screen. */
export const NOTIFICATION_GROUP_EVENT_TYPES: Readonly<
  Record<NotificationPreferenceGroup, readonly NotificationEventType[]>
> = NOTIFICATION_PREFERENCE_GROUPS.reduce(
  (acc, group) => {
    acc[group] = NOTIFICATION_EVENT_TYPES.filter(
      (eventType) => NOTIFICATION_EVENT_REGISTRY[eventType].group === group,
    );
    return acc;
  },
  {} as Record<NotificationPreferenceGroup, readonly NotificationEventType[]>,
);

/** i18n key for the common DM footer line, every event shares this one (18_NOTIFICATIONS_AND_DISCORD_DM.md §First-DM footer) — interpolated with `{ url }`. */
export const NOTIFICATION_DM_FOOTER_KEY = "notifications.dm.footer";

export function getNotificationEventDefinition(
  eventType: NotificationEventType,
): NotificationEventDefinition {
  return NOTIFICATION_EVENT_REGISTRY[eventType];
}
