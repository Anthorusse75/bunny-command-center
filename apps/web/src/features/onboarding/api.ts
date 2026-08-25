// Thin API calls for Step 10's guild lifecycle / onboarding / approval
// workflow (IMPLEMENTATION/10_onboarding_approval.md, 24_API_CONTRACTS.md).
// Same `apiJson` envelope-unwrapping convention as `features/guilds/api.ts`.
import { apiJson } from "../auth/apiClient.js";
import type {
  LifecycleTransitionResponse,
  OnboardingSectionSaveRequest,
  OnboardingStateResponse,
  RequestActivationResponse,
} from "@bunny-command-center/shared";

export function fetchOnboardingState(guildId: string): Promise<OnboardingStateResponse> {
  return apiJson<OnboardingStateResponse>(`/api/guilds/${encodeURIComponent(guildId)}/onboarding`);
}

export function saveOnboardingSection(
  guildId: string,
  request: OnboardingSectionSaveRequest,
): Promise<OnboardingStateResponse> {
  return apiJson<OnboardingStateResponse>(`/api/guilds/${encodeURIComponent(guildId)}/onboarding`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
}

export function requestActivation(guildId: string): Promise<RequestActivationResponse> {
  return apiJson<RequestActivationResponse>(`/api/guilds/${encodeURIComponent(guildId)}/request-activation`, {
    method: "POST",
  });
}

/** `pause` | `resume` | `reopen` — the three Guild-Admin-tier lifecycle actions with no request body. */
export function postGuildLifecycleAction(
  guildId: string,
  action: "pause" | "resume" | "reopen",
): Promise<LifecycleTransitionResponse> {
  return apiJson<LifecycleTransitionResponse>(`/api/guilds/${encodeURIComponent(guildId)}/${action}`, {
    method: "POST",
  });
}
