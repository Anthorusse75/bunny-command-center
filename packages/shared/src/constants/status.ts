// Semantic status tones - the single vocabulary every `StatusBadge` in the product
// resolves through.
//
// DASHBOARD/20_DESIGN_SYSTEM_AND_THEMES.md §Component-level design notes requires
// "a single shared `StatusBadge` component (state -> color/icon/label mapping
// data-driven from `packages/shared/constants`, mirroring the actual DB enum values
// [...]) used everywhere a state is shown, never a bespoke color choice per screen",
// and DASHBOARD/28_ACCESSIBILITY.md §Color is never the sole state carrier requires
// every badge to pair colour with an icon AND a text label.
//
// IMPORTANT SCOPE NOTE (read before adding domain states here):
// The domain state sets themselves (capture_cases.state, operator_commands.state,
// upload_items.state, guilds.lifecycle_state) are NOT mirrored in Step 02, for two
// concrete reasons:
//  1. The real shared schema stores them as VARCHAR with no ENUM/CHECK constraint
//     (vendor/self-bot-schema/database/migrations/0005_captures.up.sql:28,
//     0009_operations.up.sql:27) - the authoritative value list lives in the bots'
//     Python code, which this repo does not vendor, so "mirroring the actual DB enum
//     values" is not verifiable from anything available here yet.
//  2. `upload_items`/`guilds.lifecycle_state` are created by later steps (15 / 07),
//     which own their own state->tone maps.
// Step 02 therefore ships the tone vocabulary and the presentation contract; each
// later step adds its own `Record<DomainState, StatusDescriptor>` in this same
// directory, so the mapping stays data-driven and centralised rather than inlined
// per screen.

export const STATUS_TONES = [
  "success",
  "warning",
  "error",
  "info",
  "pending",
  "progress",
  "neutral",
] as const;

export type StatusTone = (typeof STATUS_TONES)[number];

/**
 * The icon slot is a semantic name, not a component reference: `packages/shared`
 * must stay framework-free (it is imported by `apps/api` too), so the mapping from
 * icon name to an actual React icon lives in `apps/web`'s design system.
 */
export const STATUS_TONE_ICONS = {
  success: "check-circle",
  warning: "alert-triangle",
  error: "alert-octagon",
  info: "info-circle",
  pending: "clock",
  progress: "progress-activity",
  neutral: "circle-dot",
} as const satisfies Record<StatusTone, string>;

export type StatusToneIcon = (typeof STATUS_TONE_ICONS)[StatusTone];

/**
 * Default i18n key per tone, in the `common.*` namespace. A domain descriptor
 * normally overrides `labelKey` with its own domain wording (e.g.
 * a lifecycle-state key under the guild namespace); these generic labels are the fallback and are
 * what the Step-02 showcase renders.
 */
export const STATUS_TONE_LABEL_KEYS = {
  success: "common.status.success",
  warning: "common.status.warning",
  error: "common.status.error",
  info: "common.status.info",
  pending: "common.status.pending",
  progress: "common.status.progress",
  neutral: "common.status.neutral",
} as const satisfies Record<StatusTone, string>;

/**
 * What a screen hands to `StatusBadge`. `labelKey` is an i18n key, never a
 * pre-translated string - the badge translates it itself so the same descriptor is
 * reusable across locales and so the no-hardcoded-string gate stays meaningful.
 */
export interface StatusDescriptor {
  tone: StatusTone;
  labelKey: string;
  /** Overrides the tone's default icon when a domain state needs a specific one. */
  icon?: StatusToneIcon;
}

export function isStatusTone(value: unknown): value is StatusTone {
  return typeof value === "string" && (STATUS_TONES as readonly string[]).includes(value);
}

/**
 * Resolves a bare tone into a full descriptor using the generic `common.status.*`
 * label. Domain state maps should build descriptors explicitly instead of calling
 * this, so their wording is reviewed like any other product copy.
 */
export function statusDescriptorForTone(tone: StatusTone): StatusDescriptor {
  return { tone, labelKey: STATUS_TONE_LABEL_KEYS[tone], icon: STATUS_TONE_ICONS[tone] };
}
