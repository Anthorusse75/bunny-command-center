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
import { findValidSessionByRawToken, touchSession } from "./sessionRepo.js";
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
 * Non-throwing resolution used both by the mandatory `requireAuth` gate below
 * AND by the SSE route's optional identity upgrade
 * (apps/api/src/sse/route.ts) — a connection without a valid session simply
 * gets `undefined` back, never an error, since /api/stream does not yet
 * require authentication (see this step's HANDOVER "Step 03 compatibility"
 * deviation note).
 */
export async function resolveAuthenticatedUser(
  db: Kysely<DB>,
  config: AppConfig,
  request: FastifyRequest,
): Promise<{ user: AuthenticatedUser; sessionId: string; renewal: PendingSessionRenewal } | undefined> {
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
  // Sliding TTL renewal (ADR-020) — best-effort; a failure here must never
  // block the request that's already been authenticated. Computed with the
  // SAME `now` and the SAME clamp-to-absolute-cap formula `touchSession`
  // applies server-side in SQL, so the browser cookie's Max-Age and the
  // DB row's `expires_at` always converge on the identical value — this is
  // what makes the sliding session genuinely end-to-end rather than only
  // sliding in the database while the browser cookie silently keeps its
  // original, un-renewed login-time expiry (correction-pass review finding).
  const now = new Date();
  const candidateExpiry = new Date(now.getTime() + config.session.slidingTtlMs);
  const renewedExpiresAt =
    session.absolute_expires_at < candidateExpiry ? session.absolute_expires_at : candidateExpiry;
  await touchSession(db, session.id, config.session.slidingTtlMs, now).catch((err: unknown) => {
    request.log.warn({ err }, "auth: failed to renew session sliding expiry");
  });

  return {
    sessionId: session.id,
    renewal: { rawToken, maxAgeMs: renewedExpiresAt.getTime() - now.getTime() },
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

export function buildRequireAuth(db: Kysely<DB>, config: AppConfig) {
  return async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const result = await resolveAuthenticatedUser(db, config, request);
    if (!result) {
      await reply.code(401).send({
        error_code: "UNAUTHENTICATED",
        message_key: "errors.auth.unauthenticated",
        parameters: {},
      });
      return;
    }
    request.authUser = result.user;
    request.authSessionId = result.sessionId;
    request.pendingSessionRenewal = result.renewal;
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
