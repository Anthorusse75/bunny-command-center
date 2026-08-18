// `/guild/:guildId/leaderboard` — guild-scoped, gated by `GuildRouteGuard`
// (real requireTier USER chain). Real content is Step 18's scope.
import { PlaceholderScreen } from "./PlaceholderScreen.js";

export function LeaderboardScreen(): React.JSX.Element {
  return (
    <PlaceholderScreen titleKey="leaderboard.placeholder.title" bodyKey="leaderboard.placeholder.body" />
  );
}
