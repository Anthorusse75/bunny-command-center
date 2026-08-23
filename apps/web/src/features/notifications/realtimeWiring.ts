// Wires `notification.created` into the EXISTING generic SSE ->
// invalidation-registry mechanism (03_realtime_infrastructure.md's "STEP 06+
// EXTENSION POINT", already used by `features/guilds/realtimeWiring.ts`) —
// this step's task brief: "on receipt, invalidate/update the notification
// query + unread badge only (never a full app refetch)". Unlike Step 06's
// still-inert `permissions_changed` wiring, this one has a REAL server-side
// emitter as of this step (`apps/api/src/notifications/sseAdapter.ts`).
import { registerQueryInvalidation } from "../../realtime/index.js";
import { NOTIFICATIONS_LIST_QUERY_KEY, NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY } from "./useNotifications.js";

let wired = false;

export function initNotificationsRealtimeWiring(): void {
  if (wired) {
    return;
  }
  wired = true;
  registerQueryInvalidation("notification.created", () => [
    [...NOTIFICATIONS_LIST_QUERY_KEY],
    [...NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY],
  ]);
}
