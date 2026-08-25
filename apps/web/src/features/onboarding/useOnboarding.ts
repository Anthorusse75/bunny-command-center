// TanStack Query hooks for Step 10's onboarding/lifecycle workflow.
//
// ** Disclosed scope note ** (00_GLOBAL_IMPLEMENTATION_RULES.md rule 1):
// SCREENS/ONBOARDING.md's own §SSE EVENTS line calls for a live
// `permissions.changed`-adjacent guild-lifecycle-state SSE event so an
// approval/rejection arriving updates this screen without a manual refresh.
// That requires a NEW SSE source-adapter registration on the backend
// (03_realtime_infrastructure.md's extension point, the same mechanism Step
// 09 used for `notification.created`) — genuinely new backend wiring beyond
// this step's own SCOPE list ("Create: ... lifecycle-state-write service,
// state-machine service, onboarding stepper screens, snapshot-based
// approval API endpoints" — no new SSE source is named). Not built in this
// pass; this screen instead refetches on every mutation it performs itself
// (`invalidateQueries` below) and on normal query staleness/refocus, so a
// Guild Admin who took the action themselves always sees the fresh result —
// only a truly cross-tab/cross-user live push (e.g. a Superadmin approving
// from a different browser while this screen is open) is not instant. Left
// as an explicit, disclosed gap for a follow-up step rather than silently
// claimed as done.
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type {
  LifecycleTransitionResponse,
  OnboardingSectionSaveRequest,
  OnboardingStateResponse,
  RequestActivationResponse,
} from "@bunny-command-center/shared";
import { ApiError } from "../auth/apiClient.js";
import {
  fetchOnboardingState,
  postGuildLifecycleAction,
  requestActivation,
  saveOnboardingSection,
} from "./api.js";

export function onboardingQueryKey(guildId: string): readonly [string, string, string] {
  return ["guilds", "onboarding", guildId] as const;
}

export function useOnboardingState(guildId: string): UseQueryResult<OnboardingStateResponse, ApiError> {
  return useQuery({
    queryKey: onboardingQueryKey(guildId),
    queryFn: () => fetchOnboardingState(guildId),
    staleTime: 5_000,
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
