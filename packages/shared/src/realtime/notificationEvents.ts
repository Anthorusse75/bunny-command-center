// `notification.created` SSE event (26_REALTIME_SSE_AND_SYNC.md §Event
// schema literal example: `data: {"notificationId":"...","messageKey":"...","parameters":{...}}`).
// The FIRST genuinely feature-specific event type registered through
// apps/api/src/sse/registry.ts's `registerEventType` — registry.ts itself
// stays generic (its own header comment: "must never itself import or
// mention a feature-specific event/table name"); this schema lives here,
// in packages/shared, alongside the two Step-03 generic ones
// (`./envelope.ts`'s heartbeat/resync_required), and is imported by
// `apps/api/src/notifications/sseAdapter.ts` at server startup.
import { z } from "zod";

export const NOTIFICATION_CREATED_EVENT_TYPE = "notification.created" as const;

export const notificationCreatedDataSchema = z
  .object({
    notificationId: z.string().min(1),
    messageKey: z.string().min(1),
    parameters: z.record(z.string(), z.unknown()),
  })
  .strict();
export type NotificationCreatedData = z.infer<typeof notificationCreatedDataSchema>;
