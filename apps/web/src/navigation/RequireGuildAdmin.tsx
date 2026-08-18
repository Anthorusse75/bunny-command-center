// Guild-Admin-only sub-route guard (Onboarding/Guild Admin/Technical —
// 03_INFORMATION_ARCHITECTURE.md's domain table). Must be rendered INSIDE
// `<GuildRouteGuard>`, which has already resolved the caller's real,
// server-computed tier for the exact route guildId via
// `GET /api/guilds/:guildId` (`requireTier(guildIdParam, 'USER')`) before
// this component ever runs.
//
// EXTERNAL REVIEW CORRECTION (Step 06 correction pass, Finding 1 —
// BLOCKING): `GuildRouteGuard.tsx`'s own header comment already claimed
// "the Guild-Admin-only sub-routes ... read the tier field this SAME
// server-resolved overview call already returned" — but no component
// actually did this. `routes.tsx` rendered `OnboardingScreen`/
// `GuildAdminScreen`/`TechnicalScreen` directly as `<GuildRouteGuard>`
// children with no further check, and none of those three placeholder
// screens called `useGuildOverviewContext()` themselves — so an ordinary
// USER-tier member of a guild could reach all three Guild-Admin-only
// placeholder routes by direct URL, contradicting their documented
// semantics. This component is the ONE reusable guard `routes.tsx` now
// wraps all three in, closing that gap with the real, already-fetched tier
// — no second HTTP call, no client-computed tier, no second Discord/admin-
// resolution implementation (exactly the constraint the original comment
// described but never wired).
//
// GUILD_ADMIN and SUPERADMIN pass (Technical is documented as
// "Guild Admin (own guilds), Superadmin (all)" — a Superadmin's tier for
// ANY guildId already resolves to `SUPERADMIN`, per
// `08_AUTHORIZATION_AND_RBAC.md`'s explicit platform bypass, proven by
// `apps/api/test/guilds/routes.test.ts`'s "Superadmin bypasses
// assertGuildMembership" case — so the same `tier !== "USER"` check is
// correct for all three routes uniformly, never a fourth Superadmin-only
// carve-out).
//
// Switching guild while on one of these routes re-runs `GuildRouteGuard`'s
// own `useGuildOverview(guildId)` for the NEW guildId (TanStack Query's
// guildId-scoped key) BEFORE this component ever sees a tier — an admin of
// guild A who switches to guild B where they are only USER gets B's real,
// freshly-resolved tier here, never A's carried over (proven by
// `e2e/multi-guild.spec.ts`'s admin-route-switch regression test).
import { useGuildOverviewContext } from "./GuildRouteGuard.js";
import { ForbiddenScreen } from "../screens/ForbiddenScreen.js";

export function RequireGuildAdmin({ children }: { children: React.ReactNode }): React.JSX.Element {
  const overview = useGuildOverviewContext();
  if (overview.tier === "USER") {
    return <ForbiddenScreen />;
  }
  return <>{children}</>;
}
