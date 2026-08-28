// TanStack Query hooks for Step 10's onboarding/lifecycle workflow.
//
// ** Realtime status (corrected, Step 10 external-review correction round,
// Phase 3) **: an earlier draft of this file disclosed that a genuine
// cross-tab/cross-user live push (e.g. a Superadmin approving from a
// different browser while this screen is open) was NOT instant — only this
// screen's own mutations (`invalidateQueries` below) and normal query
// staleness/refocus kept it fresh. That gap is now closed:
// `features/onboarding/realtimeWiring.ts` registers
// `guild_lifecycle.state_changed` (a real, live backend SSE source since an
// earlier correction round, `apps/api/src/lifecycle/lifecycleSseAdapter.ts`)
// into the same generic SSE -> invalidation-registry mechanism Step 09 uses
// for `notification.created` — see that file for the exact wiring.
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type {
  LifecycleTransitionResponse,
  OnboardingChannelCatalogResponse,
  OnboardingRoleCatalogResponse,
  OnboardingSectionSaveRequest,
  OnboardingStateResponse,
  RequestActivationResponse,
} from "@bunny-command-center/shared";
import { ApiError } from "../auth/apiClient.js";
import {
  fetchOnboardingChannelCatalog,
  fetchOnboardingRoleCatalog,
  fetchOnboardingState,
  postGuildLifecycleAction,
  requestActivation,
  saveOnboardingSection,
} from "./api.js";

export function onboardingQueryKey(guildId: string): readonly [string, string, string] {
  return ["guilds", "onboarding", guildId] as const;
}

export function onboardingChannelsQueryKey(guildId: string): readonly [string, string, string, string] {
  return ["guilds", "onboarding", guildId, "channels"] as const;
}

export function useOnboardingState(guildId: string): UseQueryResult<OnboardingStateResponse, ApiError> {
  return useQuery({
    queryKey: onboardingQueryKey(guildId),
    queryFn: () => fetchOnboardingState(guildId),
    staleTime: 5_000,
  });
}

/**
 * Step 10 correction round, Gap 2 — backs the Incoming/Hero/Community
 * channel picker dropdowns. `available: false` (Bunny unreachable/erroring)
 * is a normal SUCCESSFUL response shape (never an ApiError/thrown query
 * error) — the picker components decide how to render that degraded state
 * themselves; this hook never retries aggressively against a Bunny that's
 * genuinely down (`retry: 1`, matching a "try once more, then show the
 * degraded state" UX rather than hammering an unreachable service).
 */
export function useOnboardingChannelCatalog(
  guildId: string,
): UseQueryResult<OnboardingChannelCatalogResponse, ApiError> {
  return useQuery({
    queryKey: onboardingChannelsQueryKey(guildId),
    queryFn: () => fetchOnboardingChannelCatalog(guildId),
    staleTime: 30_000,
    retry: 1,
  });
}

export function onboardingRolesQueryKey(guildId: string): readonly [string, string, string, string] {
  return ["guilds", "onboarding", guildId, "roles"] as const;
}

/**
 * Step 10 external-review Phase 2, Section 13 — backs the Admin Role Policy
 * dropdown. Same degradation contract as `useOnboardingChannelCatalog`:
 * `available: false` is a normal successful shape (never a thrown
 * `ApiError`), `retry: 1` rather than hammering an unreachable Bunny.
 */
export function useOnboardingRoleCatalog(
  guildId: string,
): UseQueryResult<OnboardingRoleCatalogResponse, ApiError> {
  return useQuery({
    queryKey: onboardingRolesQueryKey(guildId),
    queryFn: () => fetchOnboardingRoleCatalog(guildId),
    staleTime: 30_000,
    retry: 1,
  });
}

export function useSaveOnboardingSectionMutation(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation<OnboardingStateResponse, ApiError, OnboardingSectionSaveRequest>({
    mutationFn: (request) => saveOnboardingSection(guildId, request),
    onSuccess: (data) => {
      queryClient.setQueryData(onboardingQueryKey(guildId), data);
    },
  });
}

export function useRequestActivationMutation(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation<RequestActivationResponse, ApiError, void>({
    mutationFn: () => requestActivation(guildId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: onboardingQueryKey(guildId) });
    },
  });
}

export function useGuildLifecycleActionMutation(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation<LifecycleTransitionResponse, ApiError, "pause" | "resume" | "reopen">({
    mutationFn: (action) => postGuildLifecycleAction(guildId, action),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: onboardingQueryKey(guildId) });
    },
  });
}
