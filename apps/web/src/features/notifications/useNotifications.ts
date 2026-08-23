// TanStack Query hooks for Step 09 (mirrors `features/guilds/useGuilds.ts`'s
// conventions: `useRealtimeAwareQueryOptions` for the polling fallback,
// `useMutation`+`invalidateQueries` for writes).
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRealtimeAwareQueryOptions } from "../../realtime/index.js";
import {
  fetchNotificationPreferences,
  fetchNotifications,
  putMarkAllRead,
  putNotificationDismiss,
  putNotificationPreferences,
  putNotificationRead,
} from "./api.js";
import type {
  NotificationListResponse,
  NotificationPreferencesUpdateRequest,
} from "@bunny-command-center/shared";

export const NOTIFICATIONS_LIST_QUERY_KEY = ["notifications", "list"] as const;
export const NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY = ["notifications", "unreadCount"] as const;
export const NOTIFICATIONS_PREFERENCES_QUERY_KEY = ["notifications", "preferences"] as const;

const PAGE_SIZE = 25;

/** Cursor-paginated Notification Center list (`GET /api/notifications`, 24_API_CONTRACTS.md). SSE-driven live updates invalidate this key (`realtimeWiring.ts`); polls every 30s only while the realtime transport has degraded to fallback mode, same threshold as `useGuildList`. */
export function useNotificationList() {
  return useInfiniteQuery(
    useRealtimeAwareQueryOptions(
      {
        queryKey: NOTIFICATIONS_LIST_QUERY_KEY,
        queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
          fetchNotifications(
            pageParam === undefined ? { limit: PAGE_SIZE } : { cursor: pageParam, limit: PAGE_SIZE },
          ),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (lastPage: NotificationListResponse) => lastPage.nextCursor ?? undefined,
        staleTime: 15_000,
      },
      30_000,
    ),
  );
}

/** A lightweight, dedicated query for the nav-chrome unread badge (`SidebarNav.tsx`/`MoreSheet.tsx`) — independent query key from the full list so the badge can update without the Notification Center screen being mounted. */
export function useUnreadNotificationsCount() {
  return useQuery(
    useRealtimeAwareQueryOptions(
      {
        queryKey: NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY,
        queryFn: async () => (await fetchNotifications({ limit: 1 })).unreadCount,
        staleTime: 15_000,
      },
      30_000,
    ),
  );
}

function useInvalidateNotifications() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_LIST_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY });
  };
}

export function useMarkNotificationReadMutation() {
  const invalidate = useInvalidateNotifications();
  return useMutation({ mutationFn: (id: string) => putNotificationRead(id), onSuccess: invalidate });
}

export function useDismissNotificationMutation() {
  const invalidate = useInvalidateNotifications();
  return useMutation({ mutationFn: (id: string) => putNotificationDismiss(id), onSuccess: invalidate });
}

export function useMarkAllReadMutation() {
  const invalidate = useInvalidateNotifications();
  return useMutation({ mutationFn: putMarkAllRead, onSuccess: invalidate });
}

export function useNotificationPreferences() {
  return useQuery({
    queryKey: NOTIFICATIONS_PREFERENCES_QUERY_KEY,
    queryFn: fetchNotificationPreferences,
    staleTime: 15_000,
  });
}

export function useUpdateNotificationPreferencesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: NotificationPreferencesUpdateRequest) => putNotificationPreferences(body),
    onSuccess: (data) => {
      queryClient.setQueryData(NOTIFICATIONS_PREFERENCES_QUERY_KEY, data);
    },
  });
}
