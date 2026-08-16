// Shared offline/degraded-connectivity banner (21_MOBILE_UX.md
// §Offline/reconnect/background: "`navigator.onLine` + a lightweight
// periodic connectivity probe [...] drive a persistent-but-unobtrusive
// 'You're offline' banner, never a silent failure"; 03_realtime_infrastructure.md:
// "The offline banner is built here as a shared component, wired to
// `navigator.onLine`/SSE health - i18n'd from the start.").
//
// Two distinct situations, two distinct (both i18n'd) messages:
//   - genuinely offline (`navigator.onLine === false`)
//   - online, but the SSE connection has degraded past the grace period and
//     the app is running on the polling fallback (mission §40: avoid noisy
//     repeated announcements during a brief reconnect blip - a transient
//     GRACE-period wobble under ~10s never shows this banner at all, only
//     genuine POLLING/RECONNECTING does).
import { useSyncExternalStore } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useTranslation } from "react-i18next";
import { useBccIcon } from "../design-system/icons.js";
import { useRealtimeStatus } from "./SseProvider.js";

function subscribeOnlineStatus(listener: () => void): () => void {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

function getOnlineSnapshot(): boolean {
  return navigator.onLine;
}

function useIsOnline(): boolean {
  return useSyncExternalStore(subscribeOnlineStatus, getOnlineSnapshot, () => true);
}

export function OfflineBanner(): React.JSX.Element | null {
  const { t } = useTranslation();
  const isOnline = useIsOnline();
  const { isPollingFallbackActive } = useRealtimeStatus();
  const AlertIcon = useBccIcon("alert-triangle");
  const SyncIcon = useBccIcon("progress-activity");

  if (isOnline && !isPollingFallbackActive) {
    return null;
  }

  const messageKey = isOnline ? "common.state.reconnecting" : "common.state.offline";
  const Icon = isOnline ? SyncIcon : AlertIcon;

  return (
    <Box
      // `status`/`polite` (not `alert`/`assertive`): informational, never
      // urgent enough to interrupt (mission §40's "avoid noisy repeated
      // live-region announcements during reconnect loops" - a `polite`
      // region only announces on actual text change, and this banner's text
      // only changes between two fixed strings, never re-announcing itself
      // while a state persists).
      role="status"
      aria-live="polite"
      data-testid="offline-banner"
      data-online={isOnline ? "true" : "false"}
      sx={(theme) => ({
        position: "fixed",
        insetInline: 0,
        top: 0,
        zIndex: theme.zIndex.appBar + 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 1,
        padding: 1,
        backgroundColor: theme.vars.palette.bcc.status.warning.surface,
        color: theme.vars.palette.bcc.status.warning.onSurface,
        borderBlockEnd: `1px solid ${theme.vars.palette.bcc.status.warning.border}`,
      })}
    >
      <Icon aria-hidden="true" fontSize="small" />
      <Typography variant="body2">{t(messageKey)}</Typography>
    </Box>
  );
}
