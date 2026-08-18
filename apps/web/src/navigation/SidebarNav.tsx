// Fills AppShell's `sidebar-items` slot with the real, grouped desktop nav
// (03_INFORMATION_ARCHITECTURE.md §Desktop navigation: "Home, Upload, Guild
// (with a guild switcher at the top ...), Contributions, Leaderboard,
// Notifications, then a divider, then (conditionally) Onboarding / Guild
// Admin / Technical, then a second divider, then (conditionally) Superadmin
// and Hero Discovery ..., then Profile pinned at the bottom").
import Box from "@mui/material/Box";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Divider from "@mui/material/Divider";
import Badge from "@mui/material/Badge";
import { useTranslation } from "react-i18next";
import { NavLink, useLocation } from "react-router";
import { sidebarGroups, type NavItem } from "./navConfig.js";
import { useNavContext } from "./useNavContext.js";

export function SidebarNav({ collapsed }: { collapsed: boolean }): React.JSX.Element {
  const ctx = useNavContext();
  const location = useLocation();
  const groups = sidebarGroups(ctx);

  // "Profile pinned at the bottom" — every other group flows normally above
  // it inside the flex-grow slot AppShell already provides; the profile
  // group renders last and this component's own flex layout pushes it down
  // via `marginBlockStart: "auto"` on that one group.
  const profileGroup = groups.find((g) => g.group === "profile");
  const otherGroups = groups.filter((g) => g.group !== "profile");

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      {otherGroups.map((group, index) => (
        <Box key={group.group}>
          {index > 0 ? <Divider sx={{ marginBlock: 1 }} /> : null}
          <List dense disablePadding>
            {group.items.map((item) => (
              <SidebarRow
                key={item.key}
                item={item}
                ctx={ctx}
                collapsed={collapsed}
                currentPath={location.pathname}
              />
            ))}
          </List>
        </Box>
      ))}
      {profileGroup ? (
        <Box sx={{ marginBlockStart: "auto" }}>
          <Divider sx={{ marginBlock: 1 }} />
          <List dense disablePadding>
            {profileGroup.items.map((item) => (
              <SidebarRow
                key={item.key}
                item={item}
                ctx={ctx}
                collapsed={collapsed}
                currentPath={location.pathname}
              />
            ))}
          </List>
        </Box>
      ) : null}
    </Box>
  );
}

function SidebarRow({
  item,
  ctx,
  collapsed,
  currentPath,
}: {
  item: NavItem;
  ctx: ReturnType<typeof useNavContext>;
  collapsed: boolean;
  currentPath: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const Icon = item.icon;
  const path = item.path(ctx);
  const label = t(item.labelKey);
  const isActive = path !== undefined && (currentPath === path || currentPath.startsWith(`${path}/`));

  const iconNode =
    item.key === "notifications" ? (
      // 24_API_CONTRACTS.md/IMPLEMENTATION file: "badge count placeholder on
      // notifications bell (real count arrives Step 09)" — the badge exists
      // and is wired to render a count, but no real unread-count data
      // source exists yet in this step, so it's deliberately never shown
      // (badgeContent=0 -> MUI hides it) rather than displaying a fabricated
      // number.
      <Badge badgeContent={0} color="error" aria-label={t("a11y.nav.notificationsBadge", { count: 0 })}>
        <Icon fontSize="small" />
      </Badge>
    ) : (
      <Icon fontSize="small" />
    );

  // 28_ACCESSIBILITY.md / WCAG 2.2 AA "list" rule (found by the real axe-core
  // scan, apps/web/e2e/multi-guild.spec.ts): a `<List>` (`<ul>`) must
  // directly contain only real listitems. `ListItemButton` alone renders a
  // plain `<div>`/`component`, not an `<li>` — wrapping it in `<ListItem
  // disablePadding>` (which DOES render `<li>`) is MUI's own documented
  // pattern for an interactive list row, satisfying the list/listitem ARIA
  // relationship without changing any visual spacing (`disablePadding`
  // hands all padding control back to the inner `ListItemButton`, exactly
  // as before this fix).
  return (
    <ListItem disablePadding>
      <ListItemButton
        component={path ? NavLink : "button"}
        to={path}
        disabled={!path}
        selected={isActive}
        data-testid={`sidebar-item-${item.key}`}
        aria-current={isActive ? "page" : undefined}
        aria-label={collapsed ? label : undefined}
        sx={{ minHeight: 44, justifyContent: collapsed ? "center" : "flex-start" }}
      >
        <ListItemIcon sx={{ minWidth: collapsed ? "auto" : 40, justifyContent: "center" }}>
          {iconNode}
        </ListItemIcon>
        {!collapsed ? <ListItemText primary={label} /> : null}
      </ListItemButton>
    </ListItem>
  );
}
