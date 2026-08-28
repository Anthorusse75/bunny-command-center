// TanStack Query hooks for the Superadmin activation-request review screen
// (Step 10 external-review Phase 2, Section 3). Deliberately no
// `invalidateQueries`/`setQueryData` cross-wiring back into the Guild
// Admin's own `onboardingQueryKey` (features/onboarding) — a Superadmin
// reviewing a request is never assumed to share a browser session/cache
// with the guild's own admin; the two surfaces refresh independently, same
// as `useGuildLifecycleActionMutation`'s own guild-scoped invalidation
// pattern in features/onboarding.
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type {
  ActivationDecisionResponse,
  ActivationRequestDetailResponse,
} from "@bunny-command-center/shared";
import { ApiError } from "../auth/apiClient.js";
import {
  approveActivationRequestCall,
  fetchActivationRequestDetail,
  rejectActivationRequestCall,
  requestChangesOnActivationRequestCall,
} from "./api.js";

export function activationRequestDetailQueryKey(requestId: string): readonly [string, string, string] {
  return ["admin", "activation-requests", requestId] as const;
}

export function useActivationRequestDetail(
  requestId: string,
): UseQueryResult<ActivationRequestDetailResponse, ApiError> {
  return useQuery({
    queryKey: activationRequestDetailQueryKey(requestId),
    queryFn: () => fetchActivationRequestDetail(requestId),
  });
}

/**
 * Shared success handling for all 3 decision mutations: re-fetch the detail
 * query so the screen's own "already decided" branch (driven by
 * `data.state`) takes over immediately — this is what "disable further
 * action attempts" actually means here, rather than a separate ad hoc
 * disabled-flag that could drift from the real server state.
 */
function useInvalidateOnDecision(requestId: string): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: activationRequestDetailQueryKey(requestId) });
  };
}

export function useApproveActivationRequestMutation(requestId: string) {
  const invalidate = useInvalidateOnDecision(requestId);
  return useMutation<ActivationDecisionResponse, ApiError, void>({
    mutationFn: () => approveActivationRequestCall(requestId),
    onSuccess: invalidate,
  });
}

export function useRejectActivationRequestMutation(requestId: string) {
  const invalidate = useInvalidateOnDecision(requestId);
  return useMutation<ActivationDecisionResponse, ApiError, string>({
    mutationFn: (reason) => rejectActivationRequestCall(requestId, reason),
    onSuccess: invalidate,
  });
}

export function useRequestChangesOnActivationRequestMutation(requestId: string) {
  const invalidate = useInvalidateOnDecision(requestId);
  return useMutation<ActivationDecisionResponse, ApiError, string>({
    mutationFn: (reason) => requestChangesOnActivationRequestCall(requestId, reason),
    onSuccess: invalidate,
  });
}
