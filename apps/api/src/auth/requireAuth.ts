/**
 * The one place a session cookie is turned into a trusted identity
 * (08_AUTHORIZATION_AND_RBAC.md's single-process trust-boundary rationale:
 * "authorization happens once, in-process, directly against the session" —
 * no route re-derives this itself). Every guild/tier check Step 05 adds
 * builds on top of `request.authUser` this module sets, never re-parsing the
 * cookie itself.
 *
 * Fails closed on every ambiguous case (missing cookie, hashed token not
 * found, expired sliding/absolute TTL, corrupt row) — never assumes "no
 * session" is the same as "some default guest identity."
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { DB } from "../db/codegen-types.js";
import type { AppConfig } from "../config.js";
import { findValidSessionByRawToken, touchSession, type DashboardSessionRow } from "./sessionRepo.js";
import { findDashboardUserById } from "./userRepo.js";
import { setSessionCookie } from "./sessionCookie.js";

export interface AuthenticatedUser {
  id: number;
  discordUserId: string;
  username: string;
  avatarHash: string | null;
  locale: string;
  themeName: string;
  themeMode: string;
}

/** The SAME raw token re-emitted with a fresh (absolute-cap-clamped) Max-Age — sliding renewal never rotates the token itself (ADR-020: rotation is a login-only event). */
export interface PendingSessionRenewal {
  rawToken: string;
  maxAgeMs: number;
}

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthenticatedUser;
    authSessionId?: string;
    pendingSessionRenewal?: PendingSessionRenewal | undefined;
    /** Set by `clearSessionCookie` (sessionCookie.ts) — tells the onSend renewal hook below to stand down so logout/logout-all/revoke-current can never be raced by a re-issued cookie in the same response. */
    sessionCookieCleared?: boolean;
  }
}

/**
 * PURE, read-only session lookup — validates the raw token, loads the
 * session, checks sliding + absolute expiry, and loads the exact user
 * identity. Deliberately performs NO write of any kind: no `touchSession`,
 * no cookie-renewal side effect. Used both by the mandatory `requireAuth`
 * gate below (which layers its OWN sliding-renewal step on top — see
 * `touchSessionAndPrepareRenewal`) AND by the SSE route's optional identity
 * upgrade (apps/api/src/sse/route.ts) for scope resolution only.
 *
 * This split exists specifically because `/api/stream` uses
 * `reply.hijack()` + a manual `writeHead()`, so Fastify's ordinary `onSend`
 * cookie-renewal hook never runs for it — before this split, calling the
 * combined lookup+touch+renew function from the SSE route still slid
 * `dashboard_sessions.expires_at` forward (and cost a DB write) on every
 * authenticated stream connect/reconnect, while the browser cookie could
 * never actually be renewed to match, silently reintroducing exactly the
 * browser/DB divergence the sliding-cookie correction pass closed
 * everywhere else (Copilot review, Step 04 review pass). A connection
 * without a valid session simply gets `undefined` back here, never an
 * error, since `/api/stream` does not yet require authentication (see this
 * step's HANDOVER "Step 03 compatibility" deviation note).
 */
export async function resolveAuthenticatedUser(
  db: Kysely<DB>,
  config: AppConfig,
  request: FastifyRequest,
): Promise<
  { user: AuthenticatedUser; sessionId: string; session: DashboardSessionRow; rawToken: string } | undefined
> {
  const rawToken = request.cookies?.[config.session.cookieName];
  if (!rawToken) {
    return undefined;
  }
  const session = await findValidSessionByRawToken(db, rawToken);
  if (!session) {
    return undefined;
  }
  const userRow = await findDashboardUserById(db, session.user_id);
  if (!userRow) {
    return undefined;
  }
  return {
    sessionId: session.id,
    session,
    rawToken,
    user: {
      id: userRow.id,
      // Already the exact string Discord returned / the DB stored (VARCHAR,
      // never a numeric column) — no conversion, no wrapping, no risk of
      // precision loss (userRepo.ts's DashboardUserRow.discord_user_id doc
      // comment has the full rationale).
      discordUserId: userRow.discord_user_id,
      username: userRow.username,
      avatarHash: userRow.avatar_hash,
      locale: userRow.locale,
      themeName: userRow.theme_name,
      themeMode: userRow.theme_mode,
    },
  };
}

/**
 * The ONLY place `touchSession` (a real DB write) is called — deliberately
 * NOT inside `resolveAuthenticatedUser` (see that function's own doc
 * comment for why). The DB-side write and the browser-cookie renewal it
 * enables are treated as ONE unit, not two independent best-effort steps:
 * if `touchSession` fails, this returns `undefined` so the onSend hook
 * (`createSessionCookieRenewalHook`) never re-issues `bcc_session` this
 * request — re-emitting a cookie whose Max-Age implies a DB-side renewal
 * that never actually happened would let the browser and DB sliding
 * expiries silently diverge. The caller's own session lookup already
 * succeeded, so the request remains authenticated and completes normally
 * either way — a transient renewal-write failure must never become a login
 * outage.
 */
async function touchSessionAndPrepareRenewal(
  db: Kysely<DB>,
  config: AppConfig,
  resolved: { session: DashboardSessionRow; rawToken: string },
  request: FastifyRequest,
): Promise<PendingSessionRenewal | undefined> {
  const now = new Date();
  const candidateExpiry = new Date(now.getTime() + config.session.slidingTtlMs);
  const renewedExpiresAt =
    resolved.session.absolute_expires_at < candidateExpiry
      ? resolved.session.absolute_expires_at
      : candidateExpiry;
  try {
    await touchSession(db, resolved.session.id, config.session.slidingTtlMs, now);
    return { rawToken: resolved.rawToken, maxAgeMs: renewedExpiresAt.getTime() - now.getTime() };
  } catch (err) {
    request.log.warn(
      { err },
      "auth: failed to renew session sliding expiry - browser cookie will not be refreshed this request",
    );
    return undefined;
  }
}

export function buildRequireAuth(db: Kysely<DB>, config: AppConfig) {
  return async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const resolved = await resolveAuthenticatedUser(db, config, request);
    if (!resolved) {
      await reply.code(401).send({
        error_code: "UNAUTHENTICATED",
        message_key: "errors.auth.unauthenticated",
        parameters: {},
      });
      return;
    }
    request.authUser = resolved.user;
    request.authSessionId = resolved.sessionId;
    request.pendingSessionRenewal = await touchSessionAndPrepareRenewal(db, config, resolved, request);
  };
}

/**
 * The ONE place a renewed `bcc_session` cookie is actually written back to
 * the browser. Returns a plain `onSend` hook handler — deliberately NOT a
 * function that takes a `fastify` instance and calls `.addHook` itself
 * (that shape hits an unrelated structural-typing wall under this project's
 * `exactOptionalPropertyTypes: true` between the concrete `Fastify({...
 * loggerInstance })` instance type and a generically-typed `FastifyInstance`
 * parameter). Callers register it directly:
 *   `fastify.addHook("onSend", createSessionCookieRenewalHook(config))`
 * on the ROOT instance (server.ts, not inside a nested `.register()` call)
 * so any current OR future route gated by `requireAuth`/`buildRequireAuth`
 * gets sliding renewal for free, without each route remembering to wire it
 * itself.
 *
 * Deliberately does NOT call `reply.setCookie` from inside `requireAuth`
 * itself: that would run in the PRE-HANDLER, before the route handler has
 * had a chance to decide to clear the session (logout/logout-all/revoke-
 * current). Deferring to `onSend` (which always runs AFTER the handler)
 * and gating on `request.sessionCookieCleared` (set synchronously by
 * `clearSessionCookie`, sessionCookie.ts, before this hook ever runs) means
 * at most ONE of {renew, clear} ever calls `reply.setCookie`/`clearCookie`
 * for `bcc_session` per response — never both, regardless of @fastify/
 * cookie's own internal header-flush timing (verified against its actual
 * source: `reply[kReplySetCookies]` is a `Map` keyed by name+domain+path, so
 * two calls for the same cookie in one response either collapse into one
 * entry or, once already flushed, self-flush again as a SECOND `Set-Cookie`
 * header — exactly the ambiguous "which one does the browser honor" case
 * this mutual-exclusion design avoids entirely rather than relying on
 * header ordering).
 */
export function createSessionCookieRenewalHook(config: AppConfig) {
  // Fastify's onSend hook runner (lib/hooks.js: `onSendHookRunner`) ALWAYS
  // invokes this with a 4th `next` callback argument and only advances the
  // chain when the hook either calls that callback OR returns something
  // thenable (`result.then(...)`) — a genuinely synchronous function that
  // just `return`s the payload satisfies neither, and the response silently
  // never completes (reproduced: every authenticated `app.inject()` call
  // hung until Vitest's 20s test timeout). `async` is required here for
  // real behavior, not style — hence the disable below, matching the same
  // justified `require-await` exception already used for `FastifyPluginAsync`
  // elsewhere in this module's sibling files.
  // eslint-disable-next-line @typescript-eslint/require-await -- Fastify's onSend hook must return a thenable to advance its internal chain; see comment above.
  return async function sessionCookieRenewalOnSendHook(
    request: FastifyRequest,
    reply: FastifyReply,
    payload: unknown,
  ): Promise<unknown> {
    const pending = request.pendingSessionRenewal;
    if (pending && !request.sessionCookieCleared) {
      setSessionCookie(reply, config, pending.rawToken, pending.maxAgeMs);
    }
    return payload;
  };
}

/**
 * Defense-in-depth CSRF layer beyond `SameSite=Lax`
 * (27_SECURITY.md §CSRF: "all state-changing routes require a custom header
 * ... that a cross-origin form submission cannot set"). Applied to every
 * mutating `/api/auth/*` route.
 */
export const CSRF_HEADER_NAME = "x-requested-with";
export const CSRF_HEADER_VALUE = "BunnyCommandCenter";

export async function requireCsrfHeader(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers[CSRF_HEADER_NAME];
  const value = Array.isArray(header) ? header[0] : header;
  if (value !== CSRF_HEADER_VALUE) {
    await reply.code(403).send({
      error_code: "CSRF_HEADER_MISSING",
      message_key: "errors.auth.csrfHeaderMissing",
      parameters: {},
    });
  }
}
