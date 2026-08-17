// `/guild/:guildId/technical` — guild-scoped, Guild-Admin (own guilds) or
// Superadmin (all). Real content is Step 19's scope.
import { PlaceholderScreen } from "./PlaceholderScreen.js";

export function TechnicalScreen(): React.JSX.Element {
  return <PlaceholderScreen titleKey="technical.placeholder.title" bodyKey="technical.placeholder.body" />;
}
