// The authoritative route table (03_INFORMATION_ARCHITECTURE.md's domain
// table, used verbatim by the router config per that document's own
// "the authoritative route list ... lives in IMPLEMENTATION/ step that
// builds routing" pointer). Real browser paths (React Router v7 data
// router, `createBrowserRouter`) — never hash routes (D-057, this step's
// explicit REJECTION CRITERIA).
import { createBrowserRouter } from "react-router";
import { RootLayout } from "./RootLayout.js";
import { GuildRouteGuard } from "./GuildRouteGuard.js";
import { RequireGuildAdmin } from "./RequireGuildAdmin.js";
import { SuperadminRouteGuard } from "./SuperadminRouteGuard.js";
import { HomeScreen } from "../screens/HomeScreen.js";
import { UploadScreen } from "../screens/UploadScreen.js";
import { GuildOverviewScreen } from "../screens/GuildOverviewScreen.js";
import { LeaderboardScreen } from "../screens/LeaderboardScreen.js";
import { OnboardingScreen } from "../screens/OnboardingScreen.js";
import { GuildAdminScreen } from "../screens/GuildAdminScreen.js";
import { TechnicalScreen } from "../screens/TechnicalScreen.js";
import { ContributionsScreen } from "../screens/ContributionsScreen.js";
import { NotificationsScreen } from "../screens/NotificationsScreen.js";
import { NotificationPreferencesScreen } from "../screens/NotificationPreferencesScreen.js";
import { SuperadminScreen } from "../screens/SuperadminScreen.js";
import { HeroDiscoveryScreen } from "../screens/HeroDiscoveryScreen.js";
import { ActivationRequestReviewScreen } from "../screens/ActivationRequestReviewScreen.js";
import { ProfileScreen } from "../screens/ProfileScreen.js";
import { NotFoundScreen } from "../screens/NotFoundScreen.js";
import { DesignSystemShowcase } from "../showcase/DesignSystemShowcase.js";

export function createAppRouter(): ReturnType<typeof createBrowserRouter> {
  return createBrowserRouter([
    {
      element: <RootLayout />,
      children: [
        { path: "/", element: <HomeScreen /> },
        { path: "/upload", element: <UploadScreen /> },
        // Step 02's design-system showcase — deliberately NOT part of
        // 03_INFORMATION_ARCHITECTURE.md's domain table (that document's own
        // scope note: "no product feature, no route, no data fetch"), kept
        // reachable at this dedicated, non-nav-linked path SOLELY so the
        // existing Step 01-03 Playwright coverage of the design-system
        // primitives themselves (theme/mode/locale switching, toasts,
        // tooltips, contrast, keyboard operation —
        // apps/web/e2e/{theme-matrix,responsive,i18n,accessibility}.spec.ts)
        // keeps exercising real primitives in a real route tree, rather than
        // losing that coverage now that "/" is real Home content instead of
        // the showcase (this step's own "Do not reduce existing test
        // coverage" rule). Not linked from any nav chrome, not part of the
        // product's real information architecture.
        { path: "/__showcase__", element: <DesignSystemShowcase /> },
        { path: "/contributions", element: <ContributionsScreen /> },
        { path: "/notifications", element: <NotificationsScreen /> },
        { path: "/notifications/preferences", element: <NotificationPreferencesScreen /> },
        { path: "/profile", element: <ProfileScreen /> },
        {
          path: "/guild/:guildId",
          element: (
            <GuildRouteGuard>
              <GuildOverviewScreen />
            </GuildRouteGuard>
          ),
        },
        {
          path: "/guild/:guildId/leaderboard",
          element: (
            <GuildRouteGuard>
              <LeaderboardScreen />
            </GuildRouteGuard>
          ),
        },
        {
          // EXTERNAL REVIEW CORRECTION (Finding 1, BLOCKING): the three
          // Guild-Admin-only routes below now wrap their screen in
          // `<RequireGuildAdmin>`, in addition to `<GuildRouteGuard>`'s
          // membership check — see that component's header comment for why
          // this closes a real gap (these routes were previously reachable
          // by any USER-tier member, despite their documented Guild-Admin-
          // only semantics).
          path: "/guild/:guildId/onboarding",
          element: (
            <GuildRouteGuard>
              <RequireGuildAdmin>
                <OnboardingScreen />
              </RequireGuildAdmin>
            </GuildRouteGuard>
          ),
        },
        {
          path: "/guild/:guildId/admin",
          element: (
            <GuildRouteGuard>
              <RequireGuildAdmin>
                <GuildAdminScreen />
              </RequireGuildAdmin>
            </GuildRouteGuard>
          ),
        },
        {
          path: "/guild/:guildId/technical",
          element: (
            <GuildRouteGuard>
              <RequireGuildAdmin>
                <TechnicalScreen />
              </RequireGuildAdmin>
            </GuildRouteGuard>
          ),
        },
        {
          path: "/admin/platform",
          element: (
            <SuperadminRouteGuard>
              <SuperadminScreen />
            </SuperadminRouteGuard>
          ),
        },
        {
          path: "/admin/platform/hero-discovery",
          element: (
            <SuperadminRouteGuard>
              <HeroDiscoveryScreen />
            </SuperadminRouteGuard>
          ),
        },
        {
          // Step 10 external-review Phase 2, Section 3: the deep-link
          // activationRequestsService.ts:102 generates on request-activation
          // (surfaced to the Superadmin via the NEW_GUILD_PENDING
          // notification) — previously a dead end with no matching route.
          path: "/admin/platform/guilds/:guildId/review/:requestId",
          element: (
            <SuperadminRouteGuard>
              <ActivationRequestReviewScreen />
            </SuperadminRouteGuard>
          ),
        },
        { path: "*", element: <NotFoundScreen /> },
      ],
    },
  ]);
}
