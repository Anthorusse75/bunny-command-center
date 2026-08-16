/**
 * Single shared `bcc_session` cookie contract (name/HttpOnly/Secure/SameSite/
 * Path) used by BOTH session creation (login, routes.ts) and sliding-TTL
 * renewal (requireAuth.ts's onSend hook) — kept in one place specifically so
 * the two call sites cannot drift apart on a security-relevant attribute
 * over time (correction-pass review finding: the sliding session was only
 * ever sliding server-side; the browser cookie's own Max-Age never renewed).
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";

/**
 * `maxAgeMs` is the caller's responsibility to have already clamped to the
 * session's absolute expiry where relevant (requireAuth.ts's renewal path
 * does this; routes.ts's login path passes the plain sliding TTL, since a
 * brand-new session's absolute cap is always farther away than one sliding
 * window per config's own DASHBOARD_SESSION_*_TTL_DAYS invariant).
 */
export function setSessionCookie(
  reply: FastifyReply,
  config: AppConfig,
  rawToken: string,
  maxAgeMs: number,
): void {
  reply.setCookie(config.session.cookieName, rawToken, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: Math.max(0, Math.floor(maxAgeMs / 1000)),
  });
}

/**
 * Also marks the request as "session cookie cleared" so
 * `registerSessionCookieRenewal`'s onSend hook (requireAuth.ts) never
 * re-issues a renewed cookie in the SAME response — logout/logout-all/
 * revoke-current must produce an unambiguous cleared cookie, never a
 * conflicting renew-then-clear (or clear-then-renew) pair for the same
 * `bcc_session` name (correction-pass review finding D).
 */
export function clearSessionCookie(reply: FastifyReply, config: AppConfig, request: FastifyRequest): void {
  request.pendingSessionRenewal = undefined;
  request.sessionCookieCleared = true;
  reply.clearCookie(config.session.cookieName, { path: "/" });
}
