// The route tree's root element: wraps every screen in the extended
// AppShell (real sidebar/bottom-nav content, guild switcher in the sidebar
// header) plus the desktop breadcrumb / mobile back-link for depth≥2
// screens. `<Outlet>` is where React Router renders the matched route.
import { Outlet } from "react-router";
import { AppShell } from "../shell/AppShell.js";
import { SidebarNav } from "./SidebarNav.js";
import { BottomNav } from "./BottomNav.js";
import { GuildSwitcher } from "./GuildSwitcher.js";
import { Breadcrumbs } from "./Breadcrumbs.js";

export function RootLayout(): React.JSX.Element {
  return (
    <AppShell
      sidebarHeader={<GuildSwitcher />}
      sidebarContent={(collapsed) => <SidebarNav collapsed={collapsed} />}
      bottomNavContent={<BottomNav />}
    >
      <Breadcrumbs />
      <Outlet />
    </AppShell>
  );
}
