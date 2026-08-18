// `/guild/:guildId/onboarding` — guild-scoped, Guild-Admin-only per
// 03_INFORMATION_ARCHITECTURE.md. `routes.tsx` wraps this screen in
// `<GuildRouteGuard>` (real `requireTier` USER-membership chain) AND
// `<RequireGuildAdmin>` (the real server-resolved tier check — see that
// component's header comment for why this second guard reuses the SAME
// overview call rather than a second real endpoint). Real content is Step
// 10's scope.
import { PlaceholderScreen } from "./PlaceholderScreen.js";

export function OnboardingScreen(): React.JSX.Element {
  return <PlaceholderScreen titleKey="onboarding.placeholder.title" bodyKey="onboarding.placeholder.body" />;
}
