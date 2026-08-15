// The one place the product asks "am I on a phone or a desktop?".
//
// 21_MOBILE_UX.md §Breakpoints defines mobile < 600px, tablet 600-959px, desktop >= 960px,
// and §Tablet-specific decisions settles the ambiguous middle band: "Tablet defaults to the
// mobile navigation pattern (bottom nav) below 960px". So there is exactly ONE swap point -
// 960px / MUI's `md` - and `isDesktopLayout` is the single boolean every layout decision
// keys off, rather than each component re-deciding what "mobile" means.
//
// `noSsr: true` on every query: this is a client-rendered SPA (there is no server render to
// hydrate), and without it MUI returns the fallback on first render and corrects in an
// effect, which makes a component test observe the wrong layout for one frame.

import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";

export function useIsDesktopLayout(): boolean {
  const theme = useTheme();
  return useMediaQuery(theme.breakpoints.up("md"), { noSsr: true });
}

/** True only on the primary mobile target (< 600px), for density decisions. */
export function useIsNarrowMobile(): boolean {
  const theme = useTheme();
  return useMediaQuery(theme.breakpoints.down("sm"), { noSsr: true });
}
