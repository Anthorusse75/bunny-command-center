// StatusBadge - the single shared component for showing any state anywhere.
//
// 20_DESIGN_SYSTEM_AND_THEMES.md §Component-level design notes: "a single shared
// `StatusBadge` component (state -> color/icon/label mapping data-driven from
// `packages/shared/constants` [...]) used everywhere a state is shown, never a bespoke
// color choice per screen".
//
// 28_ACCESSIBILITY.md §Color is never the sole state carrier: "Status badges [...] always
// pair color with an icon and a text label - a colorblind user or a screen-reader user
// gets the same information a sighted color-perceiving user does." Hence the label is
// mandatory (there is no icon-only variant) and the accessible name spells out the word
// "status" via the `a11y.*` namespace instead of relying on visual grouping.

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useTranslation } from "react-i18next";
import { STATUS_TONE_ICONS, type StatusDescriptor, type StatusTone } from "@bunny-command-center/shared";
import { useBccIcon, type BccIconName } from "./icons.js";

export interface StatusBadgeProps {
  /** A domain descriptor from `packages/shared/constants`, or a bare tone. */
  descriptor?: StatusDescriptor;
  tone?: StatusTone;
  /** i18n key for the visible label. Required when only a `tone` is given. */
  labelKey?: string;
  /** Interpolation values for `labelKey`. */
  labelValues?: Record<string, string | number>;
  size?: "small" | "medium";
}

function resolve(props: StatusBadgeProps): { tone: StatusTone; labelKey: string; icon: BccIconName } {
  if (props.descriptor) {
    return {
      tone: props.descriptor.tone,
      labelKey: props.descriptor.labelKey,
      icon: props.descriptor.icon ?? STATUS_TONE_ICONS[props.descriptor.tone],
    };
  }
  if (!props.tone || !props.labelKey) {
    throw new Error("StatusBadge requires either a `descriptor` or both `tone` and `labelKey`.");
  }
  return {
    tone: props.tone,
    labelKey: props.labelKey,
    icon: STATUS_TONE_ICONS[props.tone],
  };
}

export function StatusBadge(props: StatusBadgeProps): React.JSX.Element {
  const { t } = useTranslation();
  const { tone, labelKey, icon } = resolve(props);
  const Icon = useBccIcon(icon);
  const label = t(labelKey, props.labelValues ?? {});
  const size = props.size ?? "medium";

  return (
    <Box
      // A status is a piece of information about the page, not a control. `role="status"`
      // would announce it as a live region on every render, which is wrong for a static
      // badge - the accessible name carries it instead.
      component="span"
      data-testid="status-badge"
      data-status-tone={tone}
      aria-label={t("a11y.statusLabel", { status: label })}
      sx={(theme) => ({
        display: "inline-flex",
        alignItems: "center",
        gap: 0.75,
        paddingInline: size === "small" ? 0.75 : 1,
        paddingBlock: size === "small" ? 0.25 : 0.5,
        borderRadius: `${theme.bcc.radius.pill}px`,
        backgroundColor: theme.vars.palette.bcc.status[tone].surface,
        color: theme.vars.palette.bcc.status[tone].onSurface,
        border: `1px solid ${theme.vars.palette.bcc.status[tone].border}`,
        maxWidth: "100%",
      })}
    >
      <Icon
        // The icon repeats what the label already says, so it is decorative to assistive
        // technology (28_ACCESSIBILITY.md: no duplicated announcements) while still
        // carrying the non-colour signal for sighted colourblind users.
        aria-hidden="true"
        sx={{ fontSize: size === "small" ? "1rem" : "1.125rem", flexShrink: 0 }}
      />
      <Typography
        component="span"
        variant={size === "small" ? "caption" : "body2"}
        sx={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
      >
        {label}
      </Typography>
    </Box>
  );
}
