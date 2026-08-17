/**
 * Thin `fetch` wrapper the whole app's authenticated API calls go through.
 * Two responsibilities, both security-relevant:
 *
 * 1. Sends `credentials: "include"` (the httpOnly `bcc_session` cookie rides
 *    along automatically — this code never reads or sets it directly, per
 *    07_DISCORD_OAUTH.md "What the browser never receives") and, for
 *    mutating methods, the `X-Requested-With` header
 *    (27_SECURITY.md §CSRF defense-in-depth, matches
 *    `apps/api/src/auth/requireAuth.ts`'s `CSRF_HEADER_VALUE`).
 * 2. Detects a `401` response and notifies every subscriber
 *    (`onSessionExpired`) so the session-expired banner can render globally
 *    (SCREENS/AUTH.md §Session expired: "any API call returning 401 triggers
 *    this state globally via a shared HTTP client interceptor, not
 *    per-screen bespoke handling") — this module owns that one interceptor,
 *    nobody else re-implements 401 handling per call site.
 */
const CSRF_HEADER_NAME = "X-Requested-With";
const CSRF_HEADER_VALUE = "BunnyCommandCenter";
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type SessionExpiredListener = () => void;
const sessionExpiredListeners = new Set<SessionExpiredListener>();

export function onSessionExpired(listener: SessionExpiredListener): () => void {
  sessionExpiredListeners.add(listener);
  return () => sessionExpiredListeners.delete(listener);
}

function notifySessionExpired(): void {
  for (const listener of sessionExpiredListeners) {
    listener();
  }
}

export interface ApiRequestOptions extends Omit<RequestInit, "credentials"> {
  /** Set to true for the initial session bootstrap check, where a 401 is an EXPECTED "not logged in yet" outcome, not an expiry to bannerize. */
  suppressSessionExpiredNotification?: boolean;
}

export async function apiFetch(path: string, options: ApiRequestOptions = {}): Promise<Response> {
  const { suppressSessionExpiredNotification, headers, method, ...rest } = options;
  const finalMethod = method ?? "GET";
  const finalHeaders = new Headers(headers);
  if (MUTATING_METHODS.has(finalMethod.toUpperCase())) {
    finalHeaders.set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
  }

  const response = await fetch(path, {
    ...rest,
    method: finalMethod,
    headers: finalHeaders,
    credentials: "include",
  });

  if (response.status === 401 && !suppressSessionExpiredNotification) {
    notifySessionExpired();
  }

  return response;
}

export interface ApiSuccessEnvelope<T> {
  data: T;
}

export interface ApiErrorEnvelope {
  error_code: string;
  message_key: string;
  parameters: Record<string, unknown>;
}

export async function apiJson<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const response = await apiFetch(path, options);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorEnvelope | null;
    throw new ApiError(response.status, body);
  }
  const body = (await response.json()) as ApiSuccessEnvelope<T>;
  return body.data;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorEnvelope | null,
  ) {
    super(body?.message_key ?? `API request failed with status ${status}`);
    this.name = "ApiError";
  }
}
