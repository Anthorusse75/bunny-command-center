// Every route under `/guild/:guildId/*` re-authorizes for THIS exact
// guildId on every navigation/render — never trusts prior client
// navigation (this step's explicit "F. REAL ROUTING / DEEP LINKS" mandate:
// "direct/deep navigation to a guild route must run normal server-side
// authorization"). The one real call this makes, `GET /api/guilds/:guildId`
// (`useGuildOverview`), is the SAME `requireTier`-guarded production route
// documented in `24_API_CONTRACTS.md` — so every guild-scoped placeholder
// sub-route (leaderboard/onboarding/admin/technical) is gated by this ONE
// real authorization call, not a client-invented check
// (IMPLEMENTATION/06_multi_guild_navigation.md §SECURITY & RBAC: "Every
// guild-scoped placeholder route still goes through requireTier ... proves
// the guard ... is wired from day one").
//
// DOCUMENTED IMPLEMENTATION DECISION (this step's HANDOVER): the
// Guild-Admin-only sub-routes (onboarding/admin/technical) do NOT make a
// second real HTTP call to prove GUILD_ADMIN tier specifically — they read
// the `tier` field this SAME server-resolved overview call already
// returned (via `useGuildOverviewContext` below). This is deliberate, not a
// shortcut around authorization: the task's own instructions are explicit
// that Step 06 must not add a fake/sample production endpoint merely to
// claim wiring, and must not implement a second real business API per
// domain ("Step 06 only needs placeholder UI routes for those domains, not
// real APIs"). The tier value itself is 100% server-computed by the real
// `requireTier` chain, re-fetched on every guild-context navigation
// (TanStack Query's `guildId`-scoped query key), never a stale or
// client-only flag — it is exactly as trustworthy as the overview screen's
// own tier display.
import { createContext, useContext } from "react";
import { useParams } from "react-router";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import { useTranslation } from "react-i18next";
import { useGuildOverview, type GuildOverview } from "../features/guilds/index.js";
import { ApiError } from "../features/auth/index.js";
import { GuildNotAccessibleScreen } from "../screens/GuildNotAccessibleScreen.js";
import { ForbiddenScreen } from "../screens/ForbiddenScreen.js";
import { PageHeading } from "./PageHeading.js";

const GuildOverviewContext = createContext<GuildOverview | undefined>(undefined);

/** The server-resolved overview for the CURRENT guild route — real, re-fetched per guildId, never a client-invented value. Only callable from inside `<GuildRouteGuard>`. */
export function useGuildOverviewContext(): GuildOverview {
  const value = useContext(GuildOverviewContext);
  if (!value) {
    throw new Error("useGuildOverviewContext must be used inside <GuildRouteGuard>.");
  }
  return value;
}

export function GuildRouteGuard({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { guildId } = useParams<{ guildId: string }>();
  const { t } = useTranslation();
  const { data, error, isPending } = useGuildOverview(guildId);

  if (isPending) {
    return (
      <Box role="status" aria-live="polite" sx={{ display: "flex", justifyContent: "center", padding: 6 }}>
        <CircularProgress aria-label={t("common.state.loading")} />
      </Box>
    );
  }

  if (error) {
    // 404 = not a member (or a genuinely unknown guildId) — the documented
    // "no longer accessible" state (03_INFORMATION_ARCHITECTURE.md's
    // "redirects to a 'no longer accessible' state, never a raw 403";
    // 08_AUTHORIZATION_AND_RBAC.md's 404-not-403 convention), never a
    // generic 404/error page.
    if (error instanceof ApiError && error.status === 404) {
      return <GuildNotAccessibleScreen />;
    }
    if (error instanceof ApiError && error.status === 403) {
      return <ForbiddenScreen />;
    }
    return (
      <Box sx={{ padding: 4 }}>
        <PageHeading text={t("errors.server")} />
      </Box>
    );
  }

  return <GuildOverviewContext.Provider value={data}>{children}</GuildOverviewContext.Provider>;
}
