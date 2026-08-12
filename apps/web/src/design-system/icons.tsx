// Icon registry: the bridge between `packages/shared`'s framework-free icon *names* and
// real components, honouring each theme's icon token.
//
// 20_DESIGN_SYSTEM_AND_THEMES.md's Icons row: "Heroic: filled/bold icon set; Premium:
// outlined/light icon set; Fusion: outlined by default, filled for primary actions". That
// makes the filled/outlined choice a theme token, not a per-call-site decision - so every
// icon in the product is looked up through here with an `isPrimaryAction` flag, and no
// screen imports a specific filled-or-outlined icon directly.

import CheckCircle from "@mui/icons-material/CheckCircle";
import CheckCircleOutlined from "@mui/icons-material/CheckCircleOutlined";
import Warning from "@mui/icons-material/Warning";
import WarningOutlined from "@mui/icons-material/WarningOutlined";
import ErrorIcon from "@mui/icons-material/Error";
import ErrorOutlined from "@mui/icons-material/ErrorOutlined";
import Info from "@mui/icons-material/Info";
import InfoOutlined from "@mui/icons-material/InfoOutlined";
import AccessTimeFilled from "@mui/icons-material/AccessTimeFilled";
import ScheduleOutlined from "@mui/icons-material/ScheduleOutlined";
import Autorenew from "@mui/icons-material/Autorenew";
import AutorenewOutlined from "@mui/icons-material/AutorenewOutlined";
import Circle from "@mui/icons-material/Circle";
import CircleOutlined from "@mui/icons-material/CircleOutlined";
import Help from "@mui/icons-material/Help";
import HelpOutlined from "@mui/icons-material/HelpOutlined";
import Close from "@mui/icons-material/Close";
import CloseOutlined from "@mui/icons-material/CloseOutlined";
import type { SvgIconComponent } from "@mui/icons-material";
import { useTheme } from "@mui/material/styles";
import type { StatusToneIcon } from "@bunny-command-center/shared";
import { prefersFilledIcon } from "../theme/createBccTheme.js";

/** Every icon this design system can render, in both weights. */
export const ICON_PAIRS = {
  "check-circle": { filled: CheckCircle, outlined: CheckCircleOutlined },
  "alert-triangle": { filled: Warning, outlined: WarningOutlined },
  "alert-octagon": { filled: ErrorIcon, outlined: ErrorOutlined },
  "info-circle": { filled: Info, outlined: InfoOutlined },
  clock: { filled: AccessTimeFilled, outlined: ScheduleOutlined },
  "progress-activity": { filled: Autorenew, outlined: AutorenewOutlined },
  "circle-dot": { filled: Circle, outlined: CircleOutlined },
  help: { filled: Help, outlined: HelpOutlined },
  close: { filled: Close, outlined: CloseOutlined },
} as const satisfies Record<string, { filled: SvgIconComponent; outlined: SvgIconComponent }>;

export type BccIconName = keyof typeof ICON_PAIRS;

/** Compile-time proof every shared status icon name has a component pair here. */
const _statusIconsAreCovered: Record<StatusToneIcon, { filled: SvgIconComponent }> = ICON_PAIRS;
void _statusIconsAreCovered;

export function useBccIcon(name: BccIconName, isPrimaryAction = false): SvgIconComponent {
  const theme = useTheme();
  const pair = ICON_PAIRS[name];
  return prefersFilledIcon(theme.bcc.icons.variant, isPrimaryAction) ? pair.filled : pair.outlined;
}
