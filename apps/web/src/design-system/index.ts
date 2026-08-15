// The design-system barrel. Screens import primitives from here, never from a file path
// inside it, so a primitive can be restructured without touching every screen.

export { StatusBadge, type StatusBadgeProps } from "./StatusBadge.js";
export {
  ToastProvider,
  useToast,
  MAX_VISIBLE_TOASTS,
  TOAST_AUTO_DISMISS_MS,
  type ToastRequest,
} from "./ToastProvider.js";
export { InfoTooltip, type InfoTooltipProps } from "./InfoTooltip.js";
export { ICON_PAIRS, useBccIcon, type BccIconName } from "./icons.js";
