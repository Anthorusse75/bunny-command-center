// `/guild/:guildId/admin` — guild-scoped, Guild-Admin-only. Real content is
// Step 12's scope. See OnboardingScreen.tsx's comment for the tier-gating
// rationale shared by every Guild-Admin-only placeholder in this step.
import { PlaceholderScreen } from "./PlaceholderScreen.js";

export function GuildAdminScreen(): React.JSX.Element {
  return <PlaceholderScreen titleKey="adminGuild.placeholder.title" bodyKey="adminGuild.placeholder.body" />;
}
