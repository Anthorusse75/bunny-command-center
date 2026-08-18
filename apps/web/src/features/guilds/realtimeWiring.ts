// Wires the multi-guild model into the EXISTING generic SSE ->
// invalidation-registry mechanism (03_realtime_infrastructure.md's Step-06
// consumer contract: "STEP 06+ EXTENSION POINT" —
// realtime/invalidationRegistry.ts) rather than adding any new realtime
// transport/parsing logic (this step's explicit "Do not rewrite the SSE
// infrastructure").
//
// HONEST WIRING STATUS (this step's HANDOVER): registers the mapping so
// that WHENEVER a future step's backend emits a `permissions_changed` event
// (08_AUTHORIZATION_AND_RBAC.md §Permission freshness: "The SSE channel
// pushes a `permissions_changed` event for that guild so the currently-open
// tab can proactively re-render"), the guild list and that guild's overview
// query are invalidated automatically. No current step (05 or 06) actually
// EMITS this event yet — that lands with whichever later step first ships a
// sensitive guild-admin-policy mutation (Steps 10/12). This registration is
// therefore IMPLEMENTED and inert-but-ready, not yet exercised end-to-end by
// a real emitter — call `initGuildRealtimeWiring()` once at app startup
// either way, so nothing needs to remember to add this later.
import type { QueryKey } from "@tanstack/react-query";
import { registerQueryInvalidation } from "../../realtime/index.js";
import { GUILD_LIST_QUERY_KEY, guildOverviewQueryKey } from "./useGuilds.js";

interface PermissionsChangedPayload {
  guildId?: string;
}

let wired = false;

export function initGuildRealtimeWiring(): void {
  if (wired) {
    return;
  }
  wired = true;
  registerQueryInvalidation<PermissionsChangedPayload>("permissions_changed", (data) => {
    const keys: QueryKey[] = [GUILD_LIST_QUERY_KEY];
    if (typeof data.guildId === "string" && data.guildId.length > 0) {
      keys.push(guildOverviewQueryKey(data.guildId));
    }
    return keys;
  });
}
