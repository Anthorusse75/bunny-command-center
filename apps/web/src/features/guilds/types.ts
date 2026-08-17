// Mirrors apps/api/src/guilds/guildsService.ts's response shapes
// (IMPLEMENTATION/06_multi_guild_navigation.md). Duplicated rather than
// imported from a shared package — the established convention already used
// by features/auth/AuthProvider.tsx's own `AuthUser` (a lightweight,
// per-side DTO mirror, not a cross-package type share).

export interface GuildListEntry {
  guildId: string;
  name: string | null;
  icon: string | null;
  botPresent: boolean;
  enabled: boolean | null;
  isOwner: boolean;
  canAdminister: boolean;
  isFavorite: boolean;
  favoritedAt: string | null;
  homeVisible: boolean;
  lastUsedAt: string | null;
}

export interface GuildListResponse {
  guilds: GuildListEntry[];
  inviteEligibleGuilds: GuildListEntry[];
  canInviteBunnyAnywhere: boolean;
  inviteUrl: string;
}

export type GuildTier = "USER" | "GUILD_ADMIN" | "SUPERADMIN";

export interface GuildOverview {
  guildId: string;
  tier: GuildTier;
  botPresent: boolean;
  enabled: boolean | null;
  displayName: string | null;
}
