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

export interface AuthenticatedUser {
  id: number;
  discordUserId: string;
  username: string;
  avatarHash: string | null;
  locale: string;
  themeName: string;
  themeMode: string;
}

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthenticatedUser;
    authSessionId?: string;
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
): Promise<{ user: AuthenticatedUser; sessionId: string } | undefined> {
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
  // block the request that's already been authenticated.
  await touchSession(db, session.id, config.session.slidingTtlMs).catch((err: unknown) => {
    request.log.warn({ err }, "auth: failed to renew session sliding expiry");
  });

  return {
    sessionId: session.id,
    user: {
      id: userRow.id,
      discordUserId: String(userRow.discord_user_id),
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
