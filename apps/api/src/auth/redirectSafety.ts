/**
 * Deep-link / post-login redirect target validation (27_SECURITY.md §Open
 * redirect / deep links: "Any internal path used as a deep-link target is
 * validated against the known route table ... rejecting anything that isn't a
 * recognized internal path — prevents the deep-link mechanism itself from
 * becoming an open-redirect vector.").
 *
 * The app has no client-side router yet (Step 06 introduces one) — this is
 * deliberately a structural safety check (same-origin relative path only,
 * never a scheme/host/protocol-relative value), not a route-table allowlist,
 * because there is no route table to check against yet. It is written as an
 * explicit, obvious extension point: a future step wires a real route-table
 * check into this exact function without touching any call site
 * (00_GLOBAL_IMPLEMENTATION_RULES.md's "explicit, obvious extension point"
 * convention, mirroring `apps/api/src/sse/route.ts`'s
 * `resolveSubscriptionScopes`).
 */
const MAX_REDIRECT_PATH_LENGTH = 512;

export function isSafeInternalRedirectPath(candidate: string | undefined | null): candidate is string {
  if (!candidate || candidate.length === 0 || candidate.length > MAX_REDIRECT_PATH_LENGTH) {
    return false;
  }
  // Must start with exactly one "/" - rejects protocol-relative ("//evil.com"),
  // absolute URLs ("https://evil.com"), and backslash tricks some browsers
  // normalize to a protocol-relative URL ("/\evil.com").
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.startsWith("/\\")) {
    return false;
  }
  // Reject anything that looks like it embeds a scheme or control characters
  // (defense in depth beyond the leading-slash check above).
  for (let i = 0; i < candidate.length; i++) {
    const code = candidate.charCodeAt(i);
    if (code <= 0x1f) {
      return false;
    }
  }
  if (/^\/[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) {
    return false;
  }
  return true;
}

export const DEFAULT_POST_LOGIN_PATH = "/";
