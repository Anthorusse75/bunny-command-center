/**
 * The single Superadmin check (ADR-008, 08_AUTHORIZATION_AND_RBAC.md
 * §Superadmin check: `isSuperadmin(discordUserId) := discordUserId ===
 * env.PLATFORM_SUPERADMIN_DISCORD_ID`). This is the ONE implementation --
 * every Superadmin gate anywhere in this codebase (the `assertGuildMembership`
 * bypass, `resolveGuildAuthorization`'s Owner/Superadmin branch, the future
 * platform-scoped `requireTier('SUPERADMIN')`) calls this function. Never
 * re-derived inline per-route (grep for a second `=== .*[Ss]uperadmin`-shaped
 * comparison anywhere else in `apps/api/src` should find none -- see this
 * step's HANDOVER for the actual grep proof).
 *
 * Config validation (`requiredSnowflakeSuperadminEnv`, apps/api/src/config.ts)
 * is the OTHER half of ADR-008's contract: production startup fails loudly if
 * `PLATFORM_SUPERADMIN_DISCORD_ID` is unset or not a syntactically valid
 * Discord Snowflake -- by the time `isSuperadmin` ever runs, `config.superadmin
 * .discordUserId` is already guaranteed non-empty and Snowflake-shaped, so this
 * function itself stays a single, trivial, exact string comparison -- no
 * runtime validation, no numeric coercion, no way to escalate via a malformed
 * comparison operand.
 */
export interface SuperadminConfig {
  discordUserId: string;
}

export function isSuperadmin(discordUserId: string, config: { superadmin: SuperadminConfig }): boolean {
  return discordUserId === config.superadmin.discordUserId;
}
