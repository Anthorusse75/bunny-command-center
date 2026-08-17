// `/guild/:guildId/onboarding` — guild-scoped, Guild-Admin-only per
// 03_INFORMATION_ARCHITECTURE.md (client-side visibility gate;
// `GuildRouteGuard`'s real requireTier USER chain is the actual auth guard
// — see that module's header comment for why the ADMIN-specific check
// reuses its server-resolved tier rather than a second real endpoint).
// Real content is Step 10's scope.
import { PlaceholderScreen } from "./PlaceholderScreen.js";

export function OnboardingScreen(): React.JSX.Element {
  return <PlaceholderScreen titleKey="onboarding.placeholder.title" bodyKey="onboarding.placeholder.body" />;
}
