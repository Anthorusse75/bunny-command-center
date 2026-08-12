// InfoTooltip - contextual help that is never hover-only.
//
// 20_DESIGN_SYSTEM_AND_THEMES.md §Component-level design notes, Tooltips row:
//   "hover-triggered on desktop; mission §31 explicitly forbids hover-dependency on mobile -
//    mobile equivalent is tap-to-reveal via an info icon button opening a small
//    popover/bottom-sheet, never a hover-only tooltip."
// 28_ACCESSIBILITY.md §Touch and pointer: "no hover-only functionality [...] tap-to-reveal
// equivalent everywhere a desktop surface uses hover."
// 22_DESKTOP_UX.md §Keyboard and pointer: "hover never gates functionality - anything
// reachable via hover on desktop has a tap/focus equivalent on mobile".
//
// The trigger is therefore ALWAYS a real <button>: that single choice is what makes the
// component work with a mouse (hover), a keyboard (focus + Enter/Space), and a fingertip
// (tap) without three code paths. The only thing the breakpoint changes is the container the
// help text appears in - a tooltip bubble on desktop, a popover on mobile - and both are
// wired to the trigger through the same `aria-describedby` relationship, so assistive
// technology sees one behaviour at any width.

import { useId, useRef, useState } from "react";
import IconButton from "@mui/material/IconButton";
import Popover from "@mui/material/Popover";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useTranslation } from "react-i18next";
import { useIsDesktopLayout } from "../theme/useBreakpoints.js";
import { useBccIcon } from "./icons.js";

export interface InfoTooltipProps {
  /** i18n key for the help text. */
  contentKey: string;
  contentValues?: Record<string, string | number>;
  /** i18n key for the trigger's accessible name. Defaults to the generic a11y label. */
  labelKey?: string;
  size?: "small" | "medium";
}

export function InfoTooltip({
  contentKey,
  contentValues,
  labelKey = "a11y.moreInformation",
  size = "small",
}: InfoTooltipProps): React.JSX.Element {
  const { t } = useTranslation();
  const isDesktop = useIsDesktopLayout();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const contentId = useId();
  const HelpIcon = useBccIcon("help");
  const content = t(contentKey, contentValues ?? {});

  const trigger = (
    <IconButton
      ref={anchorRef}
      size={size}
      aria-label={t(labelKey)}
      aria-expanded={open}
      aria-describedby={open ? contentId : undefined}
      data-testid="info-tooltip-trigger"
      // Click works identically for a mouse click, a tap, and Enter/Space on a focused
      // button - the browser synthesises click for all three, which is precisely why the
      // trigger is a button and not a hoverable <span>.
      onClick={() => setOpen((current) => !current)}
      onMouseEnter={isDesktop ? () => setOpen(true) : undefined}
      onMouseLeave={isDesktop ? () => setOpen(false) : undefined}
      onFocus={isDesktop ? () => setOpen(true) : undefined}
      onBlur={isDesktop ? () => setOpen(false) : undefined}
    >
      <HelpIcon fontSize={size === "small" ? "small" : "medium"} />
    </IconButton>
  );

  if (isDesktop) {
    return (
      <Tooltip
        open={open}
        title={content}
        onClose={() => setOpen(false)}
        // Listeners are driven from the trigger above so hover, focus and click all share
        // one state; MUI's own listeners would fight it.
        disableHoverListener
        disableFocusListener
        disableTouchListener
        // The id goes on the POPPER slot, not the tooltip slot: MUI already puts
        // `role="tooltip"` on the popper root, so adding a second `role="tooltip"` inside it
        // would give the page two tooltip elements and leave `aria-describedby` pointing at
        // the one without the role. Putting the id where the role already is keeps exactly one
        // element that is both named by the description and exposed as a tooltip.
        slotProps={{ popper: { id: contentId } }}
      >
        {trigger}
      </Tooltip>
    );
  }

  return (
    <>
      {trigger}
      <Popover
        open={open}
        anchorEl={anchorRef.current}
        onClose={() => setOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        transformOrigin={{ vertical: "top", horizontal: "center" }}
        // MUI's Popover restores focus to the trigger on close and closes on Escape, which
        // is what 28_ACCESSIBILITY.md §Keyboard requires of any transient surface ("a clear,
        // keyboard-reachable close action and returns focus to its trigger on close").
        slotProps={{
          paper: {
            id: contentId,
            role: "tooltip",
            sx: { maxWidth: 320, padding: 1.5 },
          },
        }}
      >
        <Typography variant="body2">{content}</Typography>
      </Popover>
    </>
  );
}
