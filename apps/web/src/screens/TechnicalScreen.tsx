// `/guild/:guildId/technical` — guild-scoped, Guild-Admin (own guilds) or
// Superadmin (all), gated by `<GuildRouteGuard>` + `<RequireGuildAdmin>` in
// `routes.tsx` (a Superadmin's tier for any guildId already resolves to
// `SUPERADMIN`, so the same `tier !== "USER"` check in `RequireGuildAdmin`
// correctly covers both cases — see that component's header comment). Real
// content is Step 19's scope.
import { PlaceholderScreen } from "./PlaceholderScreen.js";

export function TechnicalScreen(): React.JSX.Element {
  return <PlaceholderScreen titleKey="technical.placeholder.title" bodyKey="technical.placeholder.body" />;
}
