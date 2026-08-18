// Resolves which guild the "Guild" nav family should point at
// (09_MULTI_GUILD_MODEL.md §Last-used guild / 03_INFORMATION_ARCHITECTURE.md:
// "'Guild' always resolves to the user's last-used/favorite guild"): the
// CURRENT route's `:guildId` if we're already on a guild-scoped route
// (keeps the sidebar's "Guild" link matching exactly where the user is),
// otherwise the top of the real, live-cross-referenced favorites-first list.
import { useParams } from "react-router";
import { useGuildList } from "../features/guilds/index.js";

export function useDefaultGuildId(): string | undefined {
  const params = useParams<{ guildId?: string }>();
  const { data } = useGuildList();
  if (params.guildId) {
    return params.guildId;
  }
  return data?.guilds[0]?.guildId;
}
