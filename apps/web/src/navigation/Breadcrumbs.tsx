// 03_INFORMATION_ARCHITECTURE.md §Depth and breadcrumbs: "Breadcrumbs
// render on desktop for any screen at depth ≥2; on mobile, a single
// '← Back to X' link replaces breadcrumbs (no horizontal breadcrumb trail
// on small screens)." This step's real route tree only reaches depth 2 (the
// guild-scoped sub-routes and Hero Discovery under Superadmin) — deeper
// paths (e.g. `/guild/:id/admin/config/bunny`) are later steps' scope, so
// this is a small, explicit mapping over the ACTUAL routes this step ships,
// not a speculative generic breadcrumb engine for paths that don't exist
// yet.
import Box from "@mui/material/Box";
import MuiBreadcrumbs from "@mui/material/Breadcrumbs";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import ArrowBackOutlined from "@mui/icons-material/ArrowBackOutlined";
import { useTranslation } from "react-i18next";
import { Link as RouterLink, useLocation, useParams } from "react-router";
import { useIsDesktopLayout } from "../theme/useBreakpoints.js";
import { useGuildOverview } from "../features/guilds/index.js";

interface Crumb {
  /** Either a real `t()` key, or the sentinel `"__guildName__"` (rendered via `<GuildNameCrumb>`, since the guild's display name isn't a translatable string). */
  labelKey: string;
  to: string;
}

function useCrumbs(): Crumb[] | undefined {
  const { pathname } = useLocation();
  const guildLeaderboard = /^\/guild\/([^/]+)\/leaderboard$/.exec(pathname);
  const guildOnboarding = /^\/guild\/([^/]+)\/onboarding$/.exec(pathname);
  const guildAdmin = /^\/guild\/([^/]+)\/admin$/.exec(pathname);
  const guildTechnical = /^\/guild\/([^/]+)\/technical$/.exec(pathname);
  const heroDiscovery = pathname === "/admin/platform/hero-discovery";

  if (guildLeaderboard) {
    return [
      { to: `/guild/${guildLeaderboard[1]}`, labelKey: "__guildName__" },
      { to: pathname, labelKey: "common.nav.leaderboard" },
    ];
  }
  if (guildOnboarding) {
    return [
      { to: `/guild/${guildOnboarding[1]}`, labelKey: "__guildName__" },
      { to: pathname, labelKey: "common.nav.onboarding" },
    ];
  }
  if (guildAdmin) {
    return [
      { to: `/guild/${guildAdmin[1]}`, labelKey: "__guildName__" },
      { to: pathname, labelKey: "common.nav.guildAdmin" },
    ];
  }
  if (guildTechnical) {
    return [
      { to: `/guild/${guildTechnical[1]}`, labelKey: "__guildName__" },
      { to: pathname, labelKey: "common.nav.technical" },
    ];
  }
  if (heroDiscovery) {
    return [
      { to: "/admin/platform", labelKey: "common.nav.superadmin" },
      { to: pathname, labelKey: "common.nav.heroDiscovery" },
    ];
  }
  return undefined;
}

export function Breadcrumbs(): React.JSX.Element | null {
  const { t } = useTranslation();
  const isDesktop = useIsDesktopLayout();
  const crumbs = useCrumbs();

  if (!crumbs) {
    return null;
  }

  if (!isDesktop) {
    // Mobile: a single "← Back to X" link, not a full trail.
    const parent = crumbs[0]!;
    return (
      <Box sx={{ marginBlockEnd: 2 }}>
        <Link
          component={RouterLink}
          to={parent.to}
          sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}
        >
          <ArrowBackOutlined fontSize="small" />
          {t("common.actions.back")}
        </Link>
      </Box>
    );
  }

  return (
    <MuiBreadcrumbs aria-label={t("a11y.breadcrumbs")} sx={{ marginBlockEnd: 2 }}>
      <Link component={RouterLink} to="/">
        {t("common.nav.home")}
      </Link>
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1;
        const label = crumb.labelKey === "__guildName__" ? <GuildNameCrumb /> : t(crumb.labelKey);
        return isLast ? (
          <Typography key={crumb.to} color="text.primary">
            {label}
          </Typography>
        ) : (
          <Link key={crumb.to} component={RouterLink} to={crumb.to}>
            {label}
          </Link>
        );
      })}
    </MuiBreadcrumbs>
  );
}

/**
 * DELIBERATELY calls `useGuildOverview` directly, rather than reading the
 * `GuildRouteGuard`-scoped context (`useGuildOverviewContext`) — real-browser
 * testing found that `<Breadcrumbs>` renders as a SIBLING of
 * `<GuildRouteGuard>` in `RootLayout.tsx` (both children of `AppShell`), not
 * a descendant, so no context from the guard is reachable here (React
 * context only flows to descendants of its Provider). This makes an
 * independent call with the SAME query key (`guildOverviewQueryKey`,
 * features/guilds/useGuilds.ts) the guard's own `useGuildOverview` call
 * already populated — TanStack Query serves it from cache, so this is not a
 * second real network request in practice, just a second read of the same
 * cached, already-authorized result.
 */
function GuildNameCrumb(): React.JSX.Element | null {
  const { guildId } = useParams<{ guildId: string }>();
  const { data } = useGuildOverview(guildId);
  if (!data) {
    return null;
  }
  return <>{data.displayName ?? data.guildId}</>;
}
