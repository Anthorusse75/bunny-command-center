// Wires `guild_lifecycle.state_changed` into the EXISTING generic SSE ->
// invalidation-registry mechanism (03_realtime_infrastructure.md's "STEP 06+
// EXTENSION POINT", the same mechanism `features/guilds/realtimeWiring.ts`
// and `features/notifications/realtimeWiring.ts` already use).
//
// Step 10 external-review correction round, Phase 3: closes a real,
// previously-disclosed gap — `useOnboarding.ts`'s own header comment
// documented that this screen only refetched on its OWN mutations, never on
// a genuine cross-tab/cross-user push (e.g. a Superadmin approving from a
// different browser while a Guild Admin has this screen open), because "no
// new SSE source is named" in Step 10's original scope list. That backend
// source (`guild_lifecycle.state_changed`, `apps/api/src/lifecycle/
// lifecycleSseAdapter.ts`) was in fact built in an earlier correction round
// and has been live ever since — this file is the missing frontend half,
// registering the mapping so a real lifecycle transition invalidates the
// exact onboarding query for the affected guild, automatically, the moment
// the event arrives — no polling, no manual refresh.
import type { QueryKey } from "@tanstack/react-query";
import { registerQueryInvalidation } from "../../realtime/index.js";
import { onboardingQueryKey } from "./useOnboarding.js";

interface GuildLifecycleStateChangedPayload {
  guildId?: string;
}

let wired = false;

export function initOnboardingRealtimeWiring(): void {
  if (wired) {
    return;
  }
  wired = true;
  registerQueryInvalidation<GuildLifecycleStateChangedPayload>("guild_lifecycle.state_changed", (data) => {
    const keys: QueryKey[] = [];
    if (typeof data.guildId === "string" && data.guildId.length > 0) {
      keys.push(onboardingQueryKey(data.guildId));
    }
    return keys;
  });
}
