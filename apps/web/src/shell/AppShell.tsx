// The base responsive shell: chrome only, no navigation items.
//
// 02_design_system_i18n.md §ÉTAT ATTENDU APRÈS:
//   "Base responsive shell: empty bottom nav (mobile, <600px) and empty collapsible sidebar
//    (desktop, >=960px) per `../21_MOBILE_UX.md`/`../22_DESKTOP_UX.md` breakpoints - no real
//    nav items yet (Step 06 adds real navigation once routing/guilds exist), just the chrome
//    and breakpoint-swap mechanism proven to work."
// and §ACCEPTANCE CRITERIA: "the shell correctly swaps bottom-nav/sidebar at the 960px
// breakpoint".
//
// On the two widths quoted above: 21_MOBILE_UX.md §Tablet-specific decisions resolves the
// 600-959px band explicitly ("Tablet defaults to the mobile navigation pattern (bottom nav)
// below 960px"), so there is one swap point at 960 and the bottom nav covers everything
// below it. <600px is the primary *design* target, not a second swap point.
//
// The item slots that stay empty here are the domains listed in
// 03_INFORMATION_ARCHITECTURE.md (bottom nav: Home / Upload / Guild / Leaderboard / More;
// sidebar: the full domain list). They are named in the comments below so Step 06 fills a
// documented slot instead of reinventing the ordering.

import { useCallback, useState } from "react";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import ChevronLeft from "@mui/icons-material/ChevronLeftOutlined";
import ChevronRight from "@mui/icons-material/ChevronRightOutlined";
import { useTranslation } from "react-i18next";
import { useIsDesktopLayout } from "../theme/useBreakpoints.js";

/** 22_DESKTOP_UX.md §Layout: "Persistent left sidebar (collapsible to icon rail)". */
export const SIDEBAR_EXPANDED_WIDTH = 248;
export const SIDEBAR_COLLAPSED_WIDTH = 72;
export const BOTTOM_NAV_HEIGHT = 56;

/**
 * 22_DESKTOP_UX.md §Layout: "Sidebar state (expanded/collapsed) persists per user
 * (`dashboard_home_layout`-adjacent preference, `25_DATA_MODEL.md`)". No user and no
 * database exist in Step 02, so it persists locally under a key Step 12 can mirror
 * server-side without renaming - never a silently forgotten preference.
 */
export const SIDEBAR_STORAGE_KEY = "bcc.sidebarCollapsed";

function readStoredCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export interface AppShellProps {
  children?: React.ReactNode;
  /**
   * Step 06 fills these three slots (`03_INFORMATION_ARCHITECTURE.md`'s
   * navigation, this file's own comments below name the exact ordering) —
   * AppShell itself stays domain-agnostic chrome, it never imports
   * `navigation/`, so this Step 02 file is EXTENDED, not forked.
   */
  sidebarHeader?: React.ReactNode;
  /** A plain node, or a render-prop receiving the sidebar's current collapsed state (icon-rail nav rows render differently collapsed vs expanded). */
  sidebarContent?: React.ReactNode | ((collapsed: boolean) => React.ReactNode);
  bottomNavContent?: React.ReactNode;
}

export function AppShell({
  children,
  sidebarHeader,
  sidebarContent,
  bottomNavContent,
}: AppShellProps): React.JSX.Element {
  const { t } = useTranslation();
  const isDesktop = useIsDesktopLayout();
  const [collapsed, setCollapsed] = useState<boolean>(() => readStoredCollapsed());

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
      } catch {
        /* storage disabled; the in-session state still changes */
      }
      return next;
    });
  }, []);

  return (
    <Box
      data-testid="app-shell"
      data-layout={isDesktop ? "desktop" : "mobile"}
      sx={{ display: "flex", minHeight: "100dvh", width: "100%" }}
    >
      {/*
        28_ACCESSIBILITY.md §Keyboard: the first tab stop on every page skips the chrome.
        Visually hidden until focused, never `display: none` (which would make it
        unreachable by the keyboard it exists for).
      */}
      <Box
        component="a"
        href="#bcc-main-content"
        data-testid="skip-link"
        sx={(theme) => ({
          position: "absolute",
          left: 8,
          top: -64,
          zIndex: theme.zIndex.tooltip + 1,
          padding: 1,
          borderRadius: `${theme.bcc.radius.sm}px`,
          backgroundColor: theme.vars.palette.bcc.surface.elevated,
          color: theme.vars.palette.text.primary,
          border: `1px solid ${theme.vars.palette.bcc.border}`,
          textDecoration: "none",
          "&:focus-visible": { top: 8 },
        })}
      >
        {t("a11y.skipToContent")}
      </Box>

      {isDesktop ? (
        <DesktopSidebar
          collapsed={collapsed}
          onToggle={toggleCollapsed}
          header={sidebarHeader}
          content={sidebarContent}
        />
      ) : null}

      <Box
        sx={{
          flexGrow: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Box
          component="main"
          id="bcc-main-content"
          data-testid="main-content"
          // 28_ACCESSIBILITY.md §Focus management: route changes will move focus here in
          // Step 06, which requires the element to be programmatically focusable.
          tabIndex={-1}
          sx={(theme) => ({
            flexGrow: 1,
            minWidth: 0,
            paddingInline: {
              xs: `${theme.bcc.space.page.mobile}px`,
              md: `${theme.bcc.space.page.desktop}px`,
            },
            paddingBlockStart: {
              xs: `${theme.bcc.space.page.mobile}px`,
              md: `${theme.bcc.space.page.desktop}px`,
            },
            // Room for the bottom nav plus the notch inset, so content is never hidden
            // behind the nav on a phone.
            paddingBlockEnd: {
              xs: `calc(${BOTTOM_NAV_HEIGHT + 24}px + var(--bcc-safe-area-bottom, 0px))`,
              md: `${theme.bcc.space.page.desktop}px`,
            },
            outline: "none",
          })}
        >
          {children}
        </Box>
      </Box>

      {!isDesktop ? <MobileBottomNav>{bottomNavContent}</MobileBottomNav> : null}
    </Box>
  );
}

function DesktopSidebar({
  collapsed,
  onToggle,
  header,
  content,
}: {
  collapsed: boolean;
  onToggle: () => void;
  header?: React.ReactNode;
  content?: React.ReactNode | ((collapsed: boolean) => React.ReactNode);
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Box
      component="nav"
      data-testid="sidebar"
      data-collapsed={collapsed ? "true" : "false"}
      aria-label={t("a11y.sidebar.label")}
      sx={(theme) => ({
        flexShrink: 0,
        width: collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_EXPANDED_WIDTH,
        transition: theme.transitions.create("width", {
          duration: theme.bcc.motion.duration.normal,
          easing: theme.bcc.motion.easing.standard,
        }),
        display: "flex",
        flexDirection: "column",
        gap: 1,
        padding: 1,
        backgroundColor: theme.vars.palette.bcc.surface.paper,
        borderInlineEnd: `1px solid ${theme.vars.palette.divider}`,
        minHeight: "100dvh",
      })}
    >
      <Box sx={{ display: "flex", justifyContent: collapsed ? "center" : "flex-end" }}>
        <IconButton
          onClick={onToggle}
          aria-label={collapsed ? t("a11y.sidebar.expand") : t("a11y.sidebar.collapse")}
          aria-expanded={!collapsed}
          data-testid="sidebar-toggle"
        >
          {collapsed ? <ChevronRight /> : <ChevronLeft />}
        </IconButton>
      </Box>
      {/*
        22_DESKTOP_UX.md/09_MULTI_GUILD_MODEL.md: "the switcher lives in the
        sidebar header, always visible". Hidden while collapsed (icon-rail
        mode has no room for the switcher's text/search UI — a collapsed
        sidebar's Guild nav item, in `sidebar-items` below, remains the
        reachable equivalent).
      */}
      {!collapsed ? <Box data-testid="sidebar-header">{header}</Box> : null}
      {/*
        Slot for the real sidebar groups, in the order 03_INFORMATION_ARCHITECTURE.md
        §Desktop navigation fixes: Home, Upload, Guild (with guild switcher on top),
        Contributions, Leaderboard, Notifications, divider, conditional Onboarding /
        Guild Admin / Technical, divider, conditional Superadmin + Hero Discovery, then
        Profile pinned at the bottom. Filled by Step 06.
      */}
      <Box
        data-testid="sidebar-items"
        sx={{ flexGrow: 1, display: "flex", flexDirection: "column", minHeight: 0 }}
      >
        {typeof content === "function" ? content(collapsed) : content}
      </Box>
    </Box>
  );
}

function MobileBottomNav({ children }: { children?: React.ReactNode }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Box
      component="nav"
      data-testid="bottom-nav"
      aria-label={t("a11y.bottomNavigation")}
      sx={(theme) => ({
        position: "fixed",
        insetInline: 0,
        bottom: 0,
        zIndex: theme.zIndex.appBar,
        height: `calc(${BOTTOM_NAV_HEIGHT}px + var(--bcc-safe-area-bottom, 0px))`,
        // 21_MOBILE_UX.md §Navigation: "safe-area-inset-aware (`env(safe-area-inset-bottom)`
        // for notched devices)".
        paddingBlockEnd: "var(--bcc-safe-area-bottom, 0px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-around",
        backgroundColor: theme.vars.palette.bcc.surface.paper,
        borderBlockStart: `1px solid ${theme.vars.palette.divider}`,
      })}
    >
      {/*
        Slot for the five destinations 03_INFORMATION_ARCHITECTURE.md §Mobile navigation
        fixes: Home, Upload, Guild, Leaderboard, More. Filled by Step 06.
      */}
      <Box data-testid="bottom-nav-items" sx={{ display: "flex", flexGrow: 1, height: "100%" }}>
        {children}
      </Box>
    </Box>
  );
}
