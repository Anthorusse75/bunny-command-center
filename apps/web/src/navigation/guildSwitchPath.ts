// 03_INFORMATION_ARCHITECTURE.md §Inter-guild navigation: "Switching guilds
// preserves the current domain (e.g. switching guild while on
// `/guild/:id/leaderboard` navigates to the new guild's leaderboard, not
// back to Home)". Pure function, unit-tested directly — the ONE place this
// rule is implemented, both `GuildSwitcher` (desktop) and
// `GuildPickerSheet` (mobile) call it.
const GUILD_ROUTE_RE = /^\/guild\/[^/]+(\/.*)?$/;

export function buildGuildSwitchPath(currentPathname: string, newGuildId: string): string {
  const match = GUILD_ROUTE_RE.exec(currentPathname);
  if (!match) {
    // Not currently on a guild-scoped screen — the switcher's default
    // target is the new guild's overview (mission's "Guild" destination
    // resolving to a real guild, never a dead link).
    return `/guild/${newGuildId}`;
  }
  const suffix = match[1] ?? "";
  return `/guild/${newGuildId}${suffix}`;
}
