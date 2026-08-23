// `/notifications/preferences` (SCREENS/NOTIFICATIONS.md §Preferences).
// Grouped toggles — data-driven via
// `packages/shared/src/constants/notifications.ts`'s
// `NOTIFICATION_GROUP_EVENT_TYPES`, never a raw per-event matrix.
//
// ROLE-AWARE VISIBILITY (the "Separate admin alert notification
// preferences" correction, Step 09): this screen renders exactly
// `data.visibleGroups` — the subset of `NOTIFICATION_PREFERENCE_GROUPS`
// `GET /api/notifications/preferences` reports as visible for THIS caller
// (`apps/api/src/notifications/routes.ts`'s `resolveVisibleGroups`, which
// gates `ADMIN_ONLY_PREFERENCE_GROUPS` — currently only `ADMIN_ALERTS` —
// behind `isGuildAdminCapableAnywhere`) — never the full static
// `NOTIFICATION_PREFERENCE_GROUPS` array directly, and never a
// second/duplicated role check here. An ordinary caller who cannot
// administer any guild simply never receives `ADMIN_ALERTS` in
// `visibleGroups` and so never sees an "Admin alerts" row at all.
//
// GROUP-DEFAULT NON-UNIFORMITY, flagged explicitly
// (00_GLOBAL_IMPLEMENTATION_RULES.md #1): within "Guild needs", `URGENT_GUILD_NEED`
// and `GUILD_APPROVAL_STATE_CHANGE` both default Discord-DM ON
// (18_NOTIFICATIONS_AND_DISCORD_DM.md's own matrix), while single-event
// groups like "Admin alerts" (`ADMIN_ALERT` alone, DM default OFF) don't
// exhibit this at all — the grouped UI necessarily collapses a MULTI-event
// group's members into ONE visible toggle pair per group (the documented
// UX, SCREENS/NOTIFICATIONS.md's original mock). This screen shows a
// group's toggle as ON if ANY member event type currently has that channel
// enabled (an accurate "you still get at least one thing from this group"
// signal), and toggling it writes uniformly across every member event type
// in the group — a deliberate, documented simplification, not a silently
// narrower one.
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Switch from "@mui/material/Switch";
import FormControlLabel from "@mui/material/FormControlLabel";
import CircularProgress from "@mui/material/CircularProgress";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import { useTranslation } from "react-i18next";
import {
  NOTIFICATION_GROUP_EVENT_TYPES,
  type NotificationPreferenceGroup,
} from "@bunny-command-center/shared";
import { PageHeading } from "../navigation/PageHeading.js";
import {
  useNotificationPreferences,
  useUpdateNotificationPreferencesMutation,
} from "../features/notifications/useNotifications.js";

export function NotificationPreferencesScreen(): React.JSX.Element {
  const { t } = useTranslation();
  const { data, isPending, isError, refetch } = useNotificationPreferences();
  const update = useUpdateNotificationPreferencesMutation();

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
        <Button variant="contained" onClick={() => void refetch()}>
          {t("common.actions.retry")}
        </Button>
      </Box>
    );
  }

  const byEventType = new Map(data.preferences.map((row) => [row.eventType, row]));

  function groupValue(
    group: NotificationPreferenceGroup,
    channel: "inAppEnabled" | "discordDmEnabled",
  ): boolean {
    return NOTIFICATION_GROUP_EVENT_TYPES[group].some(
      (eventType) => byEventType.get(eventType)?.[channel] === true,
    );
  }

  function onToggle(
    group: NotificationPreferenceGroup,
    channel: "inAppEnabled" | "discordDmEnabled",
    value: boolean,
  ): void {
    update.mutate({
      groups: [
        {
          group,
          inAppEnabled: channel === "inAppEnabled" ? value : groupValue(group, "inAppEnabled"),
          discordDmEnabled: channel === "discordDmEnabled" ? value : groupValue(group, "discordDmEnabled"),
        },
      ],
    });
  }

  return (
    <Box sx={{ maxWidth: 640 }}>
      <PageHeading text={t("notifications.preferences.title")} />
      <Box sx={{ overflowX: "auto" }}>
        <Table size="small" aria-label={t("notifications.preferences.title")}>
          <TableHead>
            <TableRow>
              <TableCell component="th" scope="col" />
              <TableCell component="th" scope="col" align="center">
                {t("notifications.preferences.inAppColumn")}
              </TableCell>
              <TableCell component="th" scope="col" align="center">
                {t("notifications.preferences.dmColumn")}
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {data.visibleGroups.map((group) => (
              <TableRow key={group}>
                <TableCell component="th" scope="row">
                  {t(`notifications.preferences.groups.${group}`)}
                </TableCell>
                <TableCell align="center">
                  <FormControlLabel
                    label=""
                    sx={{ marginInline: 0 }}
                    control={
                      <Switch
                        checked={groupValue(group, "inAppEnabled")}
                        onChange={(_event, checked) => onToggle(group, "inAppEnabled", checked)}
                        slotProps={{
                          input: {
                            "aria-label": `${t(`notifications.preferences.groups.${group}`)} — ${t("notifications.preferences.inAppColumn")}`,
                          },
                        }}
                      />
                    }
                  />
                </TableCell>
                <TableCell align="center">
                  <FormControlLabel
                    label=""
                    sx={{ marginInline: 0 }}
                    control={
                      <Switch
                        checked={groupValue(group, "discordDmEnabled")}
                        onChange={(_event, checked) => onToggle(group, "discordDmEnabled", checked)}
                        slotProps={{
                          input: {
                            "aria-label": `${t(`notifications.preferences.groups.${group}`)} — ${t("notifications.preferences.dmColumn")}`,
                          },
                        }}
                      />
                    }
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>
      <Typography
        role="status"
        aria-live="polite"
        variant="body2"
        color="text.secondary"
        sx={{ marginBlockStart: 2 }}
      >
        {update.isSuccess ? t("notifications.preferences.saved") : ""}
      </Typography>
    </Box>
  );
}
