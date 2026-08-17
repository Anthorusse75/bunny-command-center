// TanStack Query hooks for the multi-guild model (04_discord_oauth_sessions.md's
// ADR-003 TanStack Query integration, IMPLEMENTATION/06_multi_guild_navigation.md).
// `useRealtimeAwareQueryOptions` (03_realtime_infrastructure.md's Step-06
// consumer contract) supplies the polling-fallback interval so this data
// stays current even if the SSE transport degrades, without any
// screen-local `setInterval`.
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useRealtimeAwareQueryOptions } from "../../realtime/index.js";
import { fetchGuildList, fetchGuildOverview, postFavorite, patchHomeVisibility } from "./api.js";
import type { GuildListResponse, GuildOverview } from "./types.js";
import { ApiError } from "../auth/apiClient.js";

/** Query-key roots — reused by `realtimeWiring.ts`'s invalidation mapping so both stay in lockstep. */
export const GUILD_LIST_QUERY_KEY = ["guilds", "me"] as const;
export function guildOverviewQueryKey(guildId: string): readonly [string, string, string] {
  return ["guilds", "overview", guildId] as const;
}

/** 09_MULTI_GUILD_MODEL.md's guild list — favorites first, then alphabetical, plus the invite-eligible set. Polls every 30s only while the realtime transport has degraded to fallback mode. */
export function useGuildList(): UseQueryResult<GuildListResponse, ApiError> {
  return useQuery(
    useRealtimeAwareQueryOptions(
      {
        queryKey: GUILD_LIST_QUERY_KEY,
        queryFn: fetchGuildList,
        staleTime: 15_000,
      },
      30_000,
    ),
  );
}

/**
 * The real, `requireTier`-guarded guild overview — also the entrypoint every
 * guild-scoped ROUTE (not just the overview screen) uses to authorize
 * itself (`GuildRouteGuard.tsx`): a 404 means "not a member" (renders the
 * "no longer accessible" state, `SCREENS/ERROR_STATES.md`), and the
 * resolved `tier` in a successful response is what gates the Guild-Admin
 * placeholder sub-routes client-side — see `GuildRouteGuard.tsx`'s own
 * comment for why this is a real, server-derived decision and not a
 * client-invented one.
 */
export function useGuildOverview(guildId: string | undefined): UseQueryResult<GuildOverview, ApiError> {
  return useQuery({
    queryKey: guildOverviewQueryKey(guildId ?? ""),
    queryFn: () => fetchGuildOverview(guildId!),
    enabled: guildId !== undefined,
    staleTime: 15_000,
    retry: (failureCount, error) => {
      // A 404 (not a member) or 403 (insufficient tier) is a real,
      // authoritative answer — retrying would just ask the same real
      // question again, never a transient-failure recovery.
      if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
        return false;
      }
      return failureCount < 2;
    },
  });
}

export function useFavoriteGuildMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ guildId, isFavorite }: { guildId: string; isFavorite: boolean }) =>
      postFavorite(guildId, isFavorite),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: GUILD_LIST_QUERY_KEY });
    },
  });
}

export function useHomeVisibilityMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ guildId, homeVisible }: { guildId: string; homeVisible: boolean }) =>
      patchHomeVisibility(guildId, homeVisible),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: GUILD_LIST_QUERY_KEY });
    },
  });
}
