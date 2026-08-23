// Thin API calls for Step 09 (24_API_CONTRACTS.md §Notifications) — same
// `apiJson` wrapper, same `{ data }`/CSRF-header convention as
// `features/guilds/api.ts`.
import { apiJson } from "../auth/apiClient.js";
import type {
  NotificationListResponse,
  NotificationPreferencesResponse,
  NotificationPreferencesUpdateRequest,
} from "@bunny-command-center/shared";

export function fetchNotifications(params: {
  cursor?: string;
  limit?: number;
  includeDismissed?: boolean;
}): Promise<NotificationListResponse> {
  const query = new URLSearchParams();
  if (params.cursor) query.set("cursor", params.cursor);
  if (params.limit) query.set("limit", String(params.limit));
  if (params.includeDismissed) query.set("includeDismissed", "true");
  const qs = query.toString();
  return apiJson<NotificationListResponse>(`/api/notifications${qs ? `?${qs}` : ""}`);
}

export function putNotificationRead(id: string): Promise<{ id: string; read: boolean }> {
  return apiJson(`/api/notifications/${encodeURIComponent(id)}/read`, { method: "PUT" });
}

export function putNotificationDismiss(id: string): Promise<{ id: string; dismissed: boolean }> {
  return apiJson(`/api/notifications/${encodeURIComponent(id)}/dismiss`, { method: "PUT" });
}

export function putMarkAllRead(): Promise<{ markedAllRead: boolean }> {
  return apiJson(`/api/notifications/mark-all-read`, { method: "PUT" });
}

export function fetchNotificationPreferences(): Promise<NotificationPreferencesResponse> {
  return apiJson<NotificationPreferencesResponse>("/api/notifications/preferences");
}

export function putNotificationPreferences(
  body: NotificationPreferencesUpdateRequest,
): Promise<NotificationPreferencesResponse> {
  return apiJson<NotificationPreferencesResponse>("/api/notifications/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
