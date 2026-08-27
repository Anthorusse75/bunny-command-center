// Thin API calls for the Superadmin activation-request review screen (Step
// 10 external-review Phase 2, Section 3). Same `apiJson` envelope-unwrapping
// convention as `features/onboarding/api.ts`.
import { apiJson } from "../auth/apiClient.js";
import type {
  ActivationDecisionResponse,
  ActivationRequestDetailResponse,
} from "@bunny-command-center/shared";

export function fetchActivationRequestDetail(requestId: string): Promise<ActivationRequestDetailResponse> {
  return apiJson<ActivationRequestDetailResponse>(
    `/api/admin/activation-requests/${encodeURIComponent(requestId)}`,
  );
}

export function approveActivationRequestCall(requestId: string): Promise<ActivationDecisionResponse> {
  return apiJson<ActivationDecisionResponse>(
    `/api/admin/activation-requests/${encodeURIComponent(requestId)}/approve`,
    { method: "POST" },
  );
}

export function rejectActivationRequestCall(
  requestId: string,
  reason: string,
): Promise<ActivationDecisionResponse> {
  return apiJson<ActivationDecisionResponse>(
    `/api/admin/activation-requests/${encodeURIComponent(requestId)}/reject`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    },
  );
}

export function requestChangesOnActivationRequestCall(
  requestId: string,
  reason: string,
): Promise<ActivationDecisionResponse> {
  return apiJson<ActivationDecisionResponse>(
    `/api/admin/activation-requests/${encodeURIComponent(requestId)}/request-changes`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    },
  );
}
