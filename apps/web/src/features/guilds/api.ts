// Thin API calls for the multi-guild model (24_API_CONTRACTS.md), built on
// the shared `apiJson`/`apiFetch` wrapper (features/auth/apiClient.ts) —
// same `{ data }`/`{ error_code, message_key, parameters }` envelope
// convention as every other route in this app, same CSRF header handling.
import { apiJson } from "../auth/apiClient.js";
import type { GuildListEntry, GuildListResponse, GuildOverview } from "./types.js";

export function fetchGuildList(): Promise<GuildListResponse> {
  return apiJson<GuildListResponse>("/api/users/me/guilds");
}

export function fetchGuildOverview(guildId: string): Promise<GuildOverview> {
  return apiJson<GuildOverview>(`/api/guilds/${encodeURIComponent(guildId)}`);
}

export function postFavorite(guildId: string, isFavorite: boolean): Promise<GuildListEntry> {
  return apiJson<GuildListEntry>(`/api/users/me/guilds/${encodeURIComponent(guildId)}/favorite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isFavorite }),
  });
}

export function patchHomeVisibility(guildId: string, homeVisible: boolean): Promise<GuildListEntry> {
  return apiJson<GuildListEntry>(`/api/users/me/guilds/${encodeURIComponent(guildId)}/home-visibility`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ homeVisible }),
  });
}
