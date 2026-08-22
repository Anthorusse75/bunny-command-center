// `/notifications` — Notification Center (SCREENS/NOTIFICATIONS.md §Center,
// GLOBAL route). Real states (loading/empty/loaded/recoverable-error),
// unread indicated via dot + bold text (never color-only,
// 28_ACCESSIBILITY.md), semantic `<List>`/`<ListItem>` markup, keyboard
// operable, `aria-live` announcement on a live SSE arrival
// (26_REALTIME_SSE_AND_SYNC.md's `notification.created`).
import { useState } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import CircularProgress from "@mui/material/CircularProgress";
import CloseOutlined from "@mui/icons-material/CloseOutlined";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { useRealtimeChannel } from "../realtime/index.js";
import { PageHeading } from "../navigation/PageHeading.js";
import {
  useDismissNotificationMutation,
  useMarkAllReadMutation,
  useMarkNotificationReadMutation,
  useNotificationList,
} from "../features/notifications/useNotifications.js";
import type { NotificationListItem } from "@bunny-command-center/shared";

interface NotificationCreatedPayload {
  notificationId: string;
  messageKey: string;
  parameters: Record<string, unknown>;
  /** External-review item 2 — `false` for a durable row whose IN_APP delivery is SKIPPED_PREFERENCE; must never be announced. */
  inAppVisible: boolean;
}

export function NotificationsScreen(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up("md"));
  const { data, isPending, isError, refetch, isRefetching, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useNotificationList();
  const markRead = useMarkNotificationReadMutation();
  const dismiss = useDismissNotificationMutation();
  const markAllRead = useMarkAllReadMutation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState("");

  // Live arrival announcement — the list/badge queries are invalidated
  // generically via `realtimeWiring.ts`'s `registerQueryInvalidation`; this
  // component additionally renders the human-readable announcement text
  // itself, using the SAME i18next catalog `apps/api`'s server-side
  // `renderMessage` reads (`messageKey`+`parameters` — no server round-trip
  // needed for the announcement string).
  useRealtimeChannel<NotificationCreatedPayload>("notification.created", (payload) => {
    // External-review item 2: a durable row whose IN_APP delivery was
    // SKIPPED_PREFERENCE (recipient turned in-app off for this event type)
    // still wakes the client via SSE (the server-side cursor must advance
    // past it regardless), but must never surface here — no announcement,
    // and (via the SAME query invalidation this handler's sibling
    // registration in realtimeWiring.ts always triggers) the list/badge
    // queries themselves already exclude it server-side.
    if (!payload.inAppVisible) {
      return;
    }
    setLiveAnnouncement(
      t("notifications.center.newAnnouncement", { message: t(payload.messageKey, payload.parameters) }),
    );
  });

  const items = data?.pages.flatMap((page) => page.items) ?? [];

  function openNotification(item: NotificationListItem): void {
    if (!item.readAt) {
      markRead.mutate(item.id);
    }
    if (isDesktop) {
      setSelectedId(item.id);
    } else {
      void navigate(item.deeplinkPath);
    }
  }

  if (isPending) {
    return (
      <Box role="status" aria-live="polite" sx={{ display: "flex", justifyContent: "center", padding: 6 }}>
        <CircularProgress aria-label={t("notifications.center.loading")} />
      </Box>
    );
  }

  if (isError) {
    return (
      <Box sx={{ maxWidth: 480, textAlign: "center", marginInline: "auto", paddingBlockStart: 8 }}>
        <PageHeading text={t("notifications.center.errorTitle")} />
        <Typography variant="body1" color="text.secondary" sx={{ marginBlockEnd: 3 }}>
          {t("notifications.center.errorBody")}
        </Typography>
        <Button variant="contained" onClick={() => void refetch()} disabled={isRefetching}>
          {t("common.actions.retry")}
        </Button>
      </Box>
    );
  }

  const selected = items.find((item) => item.id === selectedId) ?? null;

  return (
    <Box sx={{ display: "flex", gap: 4, alignItems: "flex-start" }}>
      <div
        aria-live="polite"
        role="status"
        className="sr-only"
        data-testid="notification-live-announcement"
        style={visuallyHidden}
      >
        {liveAnnouncement}
      </div>
      <Box sx={{ flex: "1 1 480px", minWidth: 0, maxWidth: 640 }}>
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 2 }}>
          <PageHeading text={t("notifications.center.title")} />
          <Button
            size="small"
            onClick={() => markAllRead.mutate()}
            disabled={markAllRead.isPending || items.every((item) => item.readAt !== null)}
          >
            {t("notifications.center.markAllRead")}
          </Button>
        </Box>

        {items.length === 0 ? (
          <Typography variant="body1" color="text.secondary" sx={{ paddingBlock: 4 }}>
            {t("notifications.center.empty")}
          </Typography>
        ) : (
          <List aria-label={t("notifications.center.listLabel")} sx={{ width: "100%" }}>
            {items.map((item) => {
              const unread = item.readAt === null;
              return (
                <ListItem
                  key={item.id}
                  disablePadding
                  secondaryAction={
                    <IconButton
                      edge="end"
                      aria-label={t("notifications.center.dismiss")}
                      onClick={() => dismiss.mutate(item.id)}
                    >
                      <CloseOutlined fontSize="small" />
                    </IconButton>
                  }
                >
                  <ListItemButton
                    selected={item.id === selectedId}
                    onClick={() => openNotification(item)}
                    aria-label={t(unread ? "a11y.notifications.unreadItem" : "a11y.notifications.readItem", {
                      message: item.message,
                    })}
                  >
                    {/* Unread state: dot + bold text together, never color alone
                        (28_ACCESSIBILITY.md). */}
                    <Box
                      aria-hidden="true"
                      sx={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        marginInlineEnd: 1.5,
                        flexShrink: 0,
                        backgroundColor: unread ? "error.main" : "transparent",
                        border: unread ? "none" : "1px solid transparent",
                      }}
                    />
                    <ListItemText
                      slotProps={{ primary: { sx: { fontWeight: unread ? 700 : 400 } } }}
                      primary={item.message}
                      secondary={new Date(item.createdAt).toLocaleString()}
                    />
                  </ListItemButton>
                </ListItem>
              );
            })}
          </List>
        )}

        {hasNextPage ? (
          <Button
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
            sx={{ marginBlockStart: 2 }}
          >
            {t("common.actions.more")}
          </Button>
        ) : null}

        <Button href="/notifications/preferences" sx={{ marginBlockStart: 2 }}>
          {t("notifications.center.preferencesLink")}
        </Button>
      </Box>

      {isDesktop ? (
        <Box
          data-testid="notification-preview-pane"
          sx={{
            flex: "1 1 320px",
            minWidth: 280,
            borderInlineStart: 1,
            borderColor: "divider",
            paddingInlineStart: 3,
          }}
        >
          {selected ? (
            <>
              <Typography variant="h6" component="h2">
                {selected.message}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ marginBlockEnd: 2 }}>
                {new Date(selected.createdAt).toLocaleString()}
              </Typography>
              <Button variant="contained" onClick={() => void navigate(selected.deeplinkPath)}>
                {t("notifications.center.open")}
              </Button>
            </>
          ) : (
            <Typography variant="body2" color="text.secondary">
              {t("notifications.center.empty")}
            </Typography>
          )}
        </Box>
      ) : null}
    </Box>
  );
}

const visuallyHidden: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};
