// Realtime channel-scope model (DASHBOARD/26_REALTIME_SSE_AND_SYNC.md §Transport).
//
// "On connect, the server subscribes the connection to a channel set derived
// from the caller's identity/tier: user:{userId} ... guild:{guildId} ...
// admin:{guildId} ... platform ... hero_discovery."
//
// Step 03 builds the generic transport before Step 04 (auth) exists, so no
// connection can be authorized into a real user:/guild:/admin: channel yet -
// STEP_03_TEST_SCOPE below is the one scope Step 03 itself uses, wired to a
// synthetic test-only source, never real guild/user data
// (03_realtime_infrastructure.md §SECURITY & RBAC: "this step's placeholder
// identity must be clearly marked as temporary and the real
// subscription-authorization hook point must be an explicit, obvious
// extension point").

export const PLATFORM_SCOPE = "platform" as const;
export const HERO_DISCOVERY_SCOPE = "hero_discovery" as const;

/**
 * TEMPORARY, Step-03-only scope. Step 04/05 introduce real session-derived
 * scopes (`user:{userId}`, `guild:{guildId}`, `admin:{guildId}`) via
 * `resolveSubscriptionScopes` in apps/api/src/sse/route.ts - that is the
 * extension point future steps replace this constant's call site with, not
 * something this constant itself needs to change.
 */
export const STEP_03_TEST_SCOPE = "test" as const;

export type SseChannelScope =
  | typeof PLATFORM_SCOPE
  | typeof HERO_DISCOVERY_SCOPE
  | typeof STEP_03_TEST_SCOPE
  | `guild:${string}`
  | `user:${string}`
  | `admin:${string}`;

export function guildScope(guildId: string): SseChannelScope {
  return `guild:${guildId}`;
}

export function userScope(userId: string): SseChannelScope {
  return `user:${userId}`;
}

export function adminScope(guildId: string): SseChannelScope {
  return `admin:${guildId}`;
}
