// Toast notifications.
//
// 20_DESIGN_SYSTEM_AND_THEMES.md §Component-level design notes, Toasts row:
//   "bottom-center on mobile (thumb-reachable, doesn't cover the bottom nav), top-right on
//    desktop; queued (max 3 visible, others wait) not stacked infinitely; auto-dismiss 5s
//    for informational, persistent-until-dismissed for errors requiring action."
//
// 28_ACCESSIBILITY.md §Toasts and dialogs:
//   "Toasts are announced via `aria-live="polite"` (or `role="status"`/`role="alert"` for
//    errors) - a screen-reader user is informed of a toast without needing to be focused on
//    it."
//
// Every one of those clauses is a separate assertion in ./__tests__/Toast.test.tsx.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";
import { useTranslation } from "react-i18next";
import { STATUS_TONE_ICONS, type StatusTone } from "@bunny-command-center/shared";
import { useBccIcon } from "./icons.js";

/** "auto-dismiss 5s for informational" - the document's own number. */
export const TOAST_AUTO_DISMISS_MS = 5000;

/** "max 3 visible, others wait" - the document's own number. */
export const MAX_VISIBLE_TOASTS = 3;

export interface ToastRequest {
  tone: StatusTone;
  /** i18n key. A pre-translated string is deliberately not accepted. */
  messageKey: string;
  values?: Record<string, string | number>;
  /**
   * Overrides the tone default. `error` is persistent because
   * 20_DESIGN_SYSTEM_AND_THEMES.md says errors requiring action must not vanish on a timer.
   */
  persistent?: boolean;
}

interface ToastEntry extends ToastRequest {
  id: number;
  persistent: boolean;
}

interface ToastContextValue {
  showToast: (request: ToastRequest) => number;
  dismissToast: (id: number) => void;
  /** Exposed for tests and for the shell's "clear all" affordance. */
  visibleCount: number;
  queuedCount: number;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children?: React.ReactNode }): React.JSX.Element {
  const [visible, setVisible] = useState<ToastEntry[]>([]);
  const [queue, setQueue] = useState<ToastEntry[]>([]);
  const nextId = useRef(1);

  const showToast = useCallback((request: ToastRequest): number => {
    const id = nextId.current++;
    const entry: ToastEntry = {
      ...request,
      id,
      persistent: request.persistent ?? request.tone === "error",
    };
    setVisible((current) => {
      if (current.length < MAX_VISIBLE_TOASTS) {
        return [...current, entry];
      }
      setQueue((waiting) => [...waiting, entry]);
      return current;
    });
    return id;
  }, []);

  const dismissToast = useCallback((id: number) => {
    setVisible((current) => current.filter((entry) => entry.id !== id));
  }, []);

  // Promote from the queue whenever a slot frees up. Kept as an effect rather than doing it
  // inside `dismissToast` so a toast that self-dismisses on its timer promotes the next one
  // through exactly the same path as one the user closed.
  useEffect(() => {
    if (visible.length >= MAX_VISIBLE_TOASTS || queue.length === 0) {
      return;
    }
    const promoted = queue.slice(0, MAX_VISIBLE_TOASTS - visible.length);
    setQueue((current) => current.slice(promoted.length));
    setVisible((current) => [...current, ...promoted]);
  }, [visible.length, queue]);

  const value = useMemo<ToastContextValue>(
    () => ({ showToast, dismissToast, visibleCount: visible.length, queuedCount: queue.length }),
    [showToast, dismissToast, visible.length, queue.length],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastRegion toasts={visible} onDismiss={dismissToast} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (!value) {
    throw new Error("useToast must be used inside <ToastProvider>.");
  }
  return value;
}

function ToastRegion({
  toasts,
  onDismiss,
}: {
  toasts: readonly ToastEntry[];
  onDismiss: (id: number) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const theme = useTheme();
  // `noSsr` so the very first render already knows the viewport, otherwise a mobile test
  // would observe the desktop placement for one frame.
  const isDesktop = useMediaQuery(theme.breakpoints.up("md"), { noSsr: true });

  return (
    <Box
      // A landmark so a screen-reader user can jump to notifications deliberately, in
      // addition to hearing them announced. 28_ACCESSIBILITY.md §Screen reader / ARIA.
      role="region"
      aria-label={t("a11y.notificationRegion")}
      data-testid="toast-region"
      data-placement={isDesktop ? "desktop-top-right" : "mobile-bottom-center"}
      sx={{
        position: "fixed",
        zIndex: theme.zIndex.snackbar,
        display: "flex",
        flexDirection: "column",
        gap: 1,
        pointerEvents: "none",
        ...(isDesktop
          ? { top: 16, right: 16, alignItems: "flex-end", maxWidth: 420 }
          : {
              // Sits above the bottom nav (56px) and the notch inset, so it never covers
              // the nav - 20_DESIGN_SYSTEM_AND_THEMES.md's explicit reason for
              // bottom-center on mobile.
              bottom: "calc(56px + 12px + var(--bcc-safe-area-bottom, 0px))",
              left: 8,
              right: 8,
              alignItems: "center",
            }),
      }}
    >
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </Box>
  );
}

function Toast({
  toast,
  onDismiss,
}: {
  toast: ToastEntry;
  onDismiss: (id: number) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const Icon = useBccIcon(STATUS_TONE_ICONS[toast.tone]);
  const CloseIcon = useBccIcon("close");

  useEffect(() => {
    if (toast.persistent) {
      return;
    }
    const timer = window.setTimeout(() => onDismiss(toast.id), TOAST_AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [toast.persistent, toast.id, onDismiss]);

  return (
    <Box
      // `alert` is assertive and interrupts; `status` is polite. Errors requiring action
      // earn the interruption, informational toasts do not.
      role={toast.tone === "error" ? "alert" : "status"}
      aria-live={toast.tone === "error" ? "assertive" : "polite"}
      data-testid="toast"
      data-status-tone={toast.tone}
      data-persistent={toast.persistent ? "true" : "false"}
      sx={(themeArg) => ({
        pointerEvents: "auto",
        display: "flex",
        alignItems: "flex-start",
        gap: 1,
        padding: 1.5,
        width: "100%",
        maxWidth: 420,
        borderRadius: `${themeArg.bcc.radius.md}px`,
        backgroundColor: themeArg.vars.palette.bcc.status[toast.tone].surface,
        color: themeArg.vars.palette.bcc.status[toast.tone].onSurface,
        border: `1px solid ${themeArg.vars.palette.bcc.status[toast.tone].border}`,
        boxShadow: themeArg.vars.palette.bcc.shadow.overlay,
        "@keyframes bccToastIn": {
          from: { opacity: 0, transform: "translateY(6px)" },
          to: { opacity: 1, transform: "none" },
        },
        animation: `bccToastIn ${themeArg.bcc.motion.duration.fast}ms ${themeArg.bcc.motion.easing.decelerate}`,
      })}
    >
      <Icon aria-hidden="true" sx={{ flexShrink: 0, marginTop: "2px" }} />
      <Typography variant="body2" sx={{ flexGrow: 1 }}>
        {t(toast.messageKey, toast.values ?? {})}
      </Typography>
      <IconButton
        size="small"
        aria-label={t("a11y.closeNotification")}
        onClick={() => onDismiss(toast.id)}
        sx={{ color: "inherit", flexShrink: 0 }}
      >
        <CloseIcon fontSize="small" />
      </IconButton>
    </Box>
  );
}
