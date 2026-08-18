// Thin API calls for the multi-guild model (24_API_CONTRACTS.md), built on
// the shared `apiJson`/`apiFetch` wrapper (features/auth/apiClient.ts) —
// same `{ data }`/`{ error_code, message_key, parameters }` envelope
// convention as every other route in this app, same CSRF header handling.
import { apiJson } from "../auth/apiClient.js";
import type { GuildListResponse, GuildOverview, GuildPreferenceResponse } from "./types.js";

export function fetchGuildList(): Promise<GuildListResponse> {
  return apiJson<GuildListResponse>("/api/users/me/guilds");
}

export function fetchGuildOverview(guildId: string): Promise<GuildOverview> {
  return apiJson<GuildOverview>(`/api/guilds/${encodeURIComponent(guildId)}`);
}

/**
 * EXTERNAL REVIEW CORRECTION (Step 06 correction pass): previously typed as
 * `Promise<GuildListEntry>` — the real backend
 * (`apps/api/src/guilds/routes.ts`) returns the narrower preference-row
 * shape (`GuildPreferenceResponse`: `guildId`/`isFavorite`/`favoritedAt`/
 * `homeVisible`/`lastUsedAt` only — no `name`/`icon`/`botPresent`/`enabled`/
 * `isOwner`/`canAdminister`). No current caller read the missing fields
 * (`useFavoriteGuildMutation`'s `onSuccess` only invalidates the guild-list
 * query), so this was a latent contract lie, not yet an active runtime
 * crash — fixed before a future caller could read `undefined` through a
 * type that claimed those fields always exist.
 */
export function postFavorite(guildId: string, isFavorite: boolean): Promise<GuildPreferenceResponse> {
  return apiJson<GuildPreferenceResponse>(`/api/users/me/guilds/${encodeURIComponent(guildId)}/favorite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isFavorite }),
  });
}

/** See `postFavorite`'s comment — same correction, same real response shape. */
export function patchHomeVisibility(guildId: string, homeVisible: boolean): Promise<GuildPreferenceResponse> {
  return apiJson<GuildPreferenceResponse>(
    `/api/users/me/guilds/${encodeURIComponent(guildId)}/home-visibility`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ homeVisible }),
    },
  );
}
