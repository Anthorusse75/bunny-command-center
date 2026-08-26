// `guild_lifecycle.state_changed` SSE event (Step 10 correction round, Gap
// 3 — DASHBOARD/SCREENS/ONBOARDING.md's "SSE EVENTS: permissions.changed-adjacent
// guild-lifecycle-state event"). Registered via `registerEventType`
// (`apps/api/src/sse/registry.ts`) by `apps/api/src/lifecycle/lifecycleSseAdapter.ts`
// at server startup — mirrors `notificationEvents.ts`'s own convention of
// living here, in packages/shared, alongside the two Step-03 generic event
// schemas.
//
// Named `guild_lifecycle.*`, not `guild.*` — `"guild"` is itself a reserved
// i18n namespace (`packages/shared/src/i18n/namespaces.ts`), and the usage
// linter's namespace-anchored pattern flags ANY quoted string starting with
// a registered namespace, comments included (it has no `t()`-call-site
// awareness, by design — see lint-i18n-usage.ts's own doc comment on why
// key *tables* must be caught too). `notification.created` avoided this by
// coincidence (`"notification"` singular isn't a namespace; only the plural
// `"notifications"` is) — this event type avoids it deliberately instead.
import { z } from "zod";

export const GUILD_LIFECYCLE_STATE_CHANGED_EVENT_TYPE = "guild_lifecycle.state_changed" as const;

export const guildLifecycleStateChangedDataSchema = z
  .object({
    guildId: z.string().min(1),
    previousState: z.string().min(1),
    lifecycleState: z.string().min(1),
  })
  .strict();
export type GuildLifecycleStateChangedData = z.infer<typeof guildLifecycleStateChangedDataSchema>;
