/**
 * `/api/auth/*` — 24_API_CONTRACTS.md §Auth, 07_DISCORD_OAUTH.md's sequence
 * diagram, ADR-020's session lifecycle. This is the ONLY place that reads
 * `code`/`state`/tokens off the wire and the ONLY place that sets/clears the
 * `bcc_session`/transaction cookies — every other route only ever consumes
 * `request.authUser` via `requireAuth`.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { Kysely } from "kysely";
import type { DB } from "../db/codegen-types.js";
import type { AppConfig } from "../config.js";
import { generateCodeChallenge, generateCodeVerifier, generateState } from "./pkce.js";
import {
  isTransactionExpired,
  OAUTH_TRANSACTION_MAX_AGE_MS,
  parseTransactionCookie,
  serializeTransactionCookie,
  type OAuthTransaction,
} from "./transactionCookie.js";
import type { OAuthTransactionRegistry } from "./oauthTransactionRegistry.js";
import { DEFAULT_POST_LOGIN_PATH, isSafeInternalRedirectPath } from "./redirectSafety.js";
import {
  buildAuthorizeUrl,
  DiscordIdentityFetchError,
  DiscordTokenExchangeError,
  exchangeCodeForToken,
  fetchDiscordIdentity,
} from "./discordClient.js";
import { encryptSecret } from "./tokenCrypto.js";
import { generateSessionToken } from "./sessionToken.js";
import { upsertDashboardUser } from "./userRepo.js";
import {
  createSession,
  deleteAllSessionsForUser,
  deleteSessionByRawToken,
  deleteSessionById,
  listSessionsForUser,
} from "./sessionRepo.js";
import { buildRequireAuth, requireCsrfHeader } from "./requireAuth.js";
import { setSessionCookie, clearSessionCookie } from "./sessionCookie.js";

const LOGIN_RATE_LIMIT = { max: 10, timeWindow: "15 minutes" };

function hashIp(ip: string): string {
  return createHash("sha256").update(ip, "utf-8").digest("hex");
}

function redirectToLoginError(
  reply: FastifyReply,
  reason: "oauth_denied" | "state_mismatch" | "token_exchange_failed",
): void {
  reply.redirect(`/login?error=${reason}`);
}

/**
 * `transactionRegistry` is owned and swept by the CALLER (server.ts,
 * alongside the session sweep and SSE poller's own `preClose`-managed
 * lifecycle) rather than created here — a registry this route module
 * instantiated itself would be unreachable from `server.ts`'s shutdown hook
 * and from `startOAuthTransactionSweep`, exactly the gap that let its own
 * documented periodic sweep go unwired in the first place (Copilot review,
 * Step 04 review pass).
 */
export function buildAuthRoutes(
  db: Kysely<DB>,
  config: AppConfig,
  transactionRegistry: OAuthTransactionRegistry,
): FastifyPluginAsync {
  // eslint-disable-next-line @typescript-eslint/require-await -- FastifyPluginAsync's contract
  return async (fastify) => {
    const requireAuth = buildRequireAuth(db, config);

    // -----------------------------------------------------------------
    // GET /api/auth/login — begins the flow (07_DISCORD_OAUTH.md sequence
    // diagram steps 1-4). Rate-limited (27_SECURITY.md: "tight rate limit
    // per IP, mirrors the Self-bot dashboard's express-rate-limit pattern").
    // -----------------------------------------------------------------
    fastify.get("/api/auth/login", { config: { rateLimit: LOGIN_RATE_LIMIT } }, (request, reply) => {
      const rawRedirect = (request.query as Record<string, unknown> | undefined)?.["redirect"];
      const redirect =
        typeof rawRedirect === "string" && isSafeInternalRedirectPath(rawRedirect)
          ? rawRedirect
          : DEFAULT_POST_LOGIN_PATH;

      const state = generateState();
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      const transaction: OAuthTransaction = {
        state,
        codeVerifier,
        redirect,
        createdAtMs: Date.now(),
      };
      const cookieValue = serializeTransactionCookie(transaction, config.session.transactionSigningKey);
      reply.setCookie(config.session.transactionCookieName, cookieValue, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/api/auth",
        maxAge: Math.floor(OAUTH_TRANSACTION_MAX_AGE_MS / 1000),
      });

      const authorizeUrl = buildAuthorizeUrl(config.discord, { state, codeChallenge });
      reply.redirect(authorizeUrl);
    });

    // -----------------------------------------------------------------
    // GET /api/auth/callback — validates state/PKCE, exchanges the code,
    // fetches identity, upserts the user, creates the session.
    // -----------------------------------------------------------------
    fastify.get("/api/auth/callback", { config: { rateLimit: LOGIN_RATE_LIMIT } }, async (request, reply) => {
      const query = request.query as Record<string, unknown> | undefined;
      const txnCookieValue = request.cookies?.[config.session.transactionCookieName];
      // Cleared unconditionally on every exit path from this point on —
      // the transaction is single-use regardless of outcome
      // (27_SECURITY.md: "OAuth state/PKCE code_verifier are single-use").
      reply.clearCookie(config.session.transactionCookieName, { path: "/api/auth" });

      if (typeof query?.["error"] === "string") {
        // Discord itself denied consent (07_DISCORD_OAUTH.md: "Discord
        // denies consent -> redirect to /login?error=oauth_denied") —
        // never surfaces Discord's raw error string to the user.
        redirectToLoginError(reply, "oauth_denied");
        return;
      }

      const transaction = parseTransactionCookie(txnCookieValue, config.session.transactionSigningKey);
      if (!transaction) {
        // Missing/tampered/unparsable transaction fails closed
        // (27_SECURITY.md: "malformed/expired OAuth transactions fail
        // closed") — bucketed under state_mismatch per SCREENS/AUTH.md's
        // fixed 3-cause vocabulary (denied / stateMismatch /
        // tokenExchangeFailed); documented as a deliberate mapping in the
        // HANDOVER rather than inventing a 4th cause.
        redirectToLoginError(reply, "state_mismatch");
        return;
      }

      if (isTransactionExpired(transaction, OAUTH_TRANSACTION_MAX_AGE_MS)) {
        redirectToLoginError(reply, "state_mismatch");
        return;
      }

      const queryState = typeof query?.["state"] === "string" ? query["state"] : undefined;
      if (!queryState || !constantTimeEquals(queryState, transaction.state)) {
        redirectToLoginError(reply, "state_mismatch");
        return;
      }

      // Single-use enforcement, race-safe (see oauthTransactionRegistry.ts)
      // — a replayed callback with the same state (and therefore, in
      // practice, the same code) is rejected here even if it arrives
      // before/concurrently with the cookie being cleared client-side.
      if (!transactionRegistry.tryConsume(transaction.state)) {
        redirectToLoginError(reply, "state_mismatch");
        return;
      }

      const code = typeof query?.["code"] === "string" ? query["code"] : undefined;
      if (!code) {
        redirectToLoginError(reply, "token_exchange_failed");
        return;
      }

      try {
        const tokenResponse = await exchangeCodeForToken(config.discord, {
          code,
          codeVerifier: transaction.codeVerifier,
        });
        const identity = await fetchDiscordIdentity(config.discord, tokenResponse.access_token);

        const now = new Date();
        const tokenExpiresAt = new Date(now.getTime() + tokenResponse.expires_in * 1000);
        const encryptedAccessToken = encryptSecret(
          tokenResponse.access_token,
          config.session.tokenEncryptionKey,
        );
        const encryptedRefreshToken = encryptSecret(
          tokenResponse.refresh_token,
          config.session.tokenEncryptionKey,
        );

        const user = await upsertDashboardUser(db, {
          discordUserId: identity.id,
          username: identity.username,
          avatarHash: identity.avatar,
          encryptedAccessToken,
          encryptedRefreshToken,
          tokenExpiresAt,
        });

        // Session rotation on login (ADR-020) — a brand-new opaque token
        // is always minted here; nothing pre-auth is ever "upgraded" into
        // a session token (27_SECURITY.md's session-fixation note).
        const rawSessionToken = generateSessionToken();
        const userAgentHeader = request.headers["user-agent"];
        const ipHeader = request.ip;
        await createSession(db, rawSessionToken, {
          userId: user.id,
          deviceLabel: null,
          userAgent: typeof userAgentHeader === "string" ? userAgentHeader.slice(0, 512) : null,
          ipHash: ipHeader ? hashIp(ipHeader) : null,
          slidingTtlMs: config.session.slidingTtlMs,
          absoluteTtlMs: config.session.absoluteTtlMs,
        });

        // Fresh session: absolute cap (default 90d) is always farther away
        // than one sliding window (default 30d) per config's own TTL
        // invariant, so no clamping is needed here — unlike the renewal
        // path (requireAuth.ts's onSend hook), which clamps every time.
        setSessionCookie(reply, config, rawSessionToken, config.session.slidingTtlMs);
        request.log.info({ discordUserIdPresent: true }, "auth: login succeeded");
        reply.redirect(transaction.redirect);
      } catch (err) {
        if (err instanceof DiscordTokenExchangeError || err instanceof DiscordIdentityFetchError) {
          request.log.warn({ errName: err.name, status: err.status }, "auth: OAuth callback failed");
          redirectToLoginError(reply, "token_exchange_failed");
          return;
        }
        throw err;
      }
    });

    // -----------------------------------------------------------------
    // POST /api/auth/logout
    // -----------------------------------------------------------------
    fastify.post(
      "/api/auth/logout",
      { preHandler: [requireAuth, requireCsrfHeader] },
      async (request, reply) => {
        if (reply.sent) return;
        const rawToken = request.cookies?.[config.session.cookieName];
        if (rawToken) {
          await deleteSessionByRawToken(db, rawToken);
        }
        clearSessionCookie(reply, config, request);
        return { data: { success: true } };
      },
    );

    // -----------------------------------------------------------------
    // POST /api/auth/logout-all — 07_DISCORD_OAUTH.md: "deletes every
    // dashboard_sessions row for that discord_user_id."
    // -----------------------------------------------------------------
    fastify.post(
      "/api/auth/logout-all",
      { preHandler: [requireAuth, requireCsrfHeader] },
      async (request, reply) => {
        if (reply.sent) return;
        const revokedCount = await deleteAllSessionsForUser(db, request.authUser!.id);
        clearSessionCookie(reply, config, request);
        return { data: { success: true, revokedCount } };
      },
    );

    // -----------------------------------------------------------------
    // GET /api/auth/session — authenticated "current user/session" contract
    // Step 05 is designed to consume (never includes any Discord token).
    // -----------------------------------------------------------------
    fastify.get("/api/auth/session", { preHandler: [requireAuth] }, (request) => {
      const user = request.authUser!;
      return {
        data: {
          user: {
            id: user.id,
            discordUserId: user.discordUserId,
            username: user.username,
            avatarHash: user.avatarHash,
            locale: user.locale,
            themeName: user.themeName,
            themeMode: user.themeMode,
          },
          sessionId: request.authSessionId,
        },
      };
    });

    // -----------------------------------------------------------------
    // GET /api/auth/sessions — "Manage sessions" list.
    // -----------------------------------------------------------------
    fastify.get("/api/auth/sessions", { preHandler: [requireAuth] }, async (request) => {
      const rows = await listSessionsForUser(db, request.authUser!.id);
      return {
        data: rows.map((row) => ({
          id: row.id,
          deviceLabel: row.device_label,
          userAgent: row.user_agent,
          createdAt: row.created_at.toISOString(),
          lastSeenAt: row.last_seen_at.toISOString(),
          expiresAt: row.expires_at.toISOString(),
          isCurrent: row.id === request.authSessionId,
        })),
      };
    });

    // -----------------------------------------------------------------
    // DELETE /api/auth/sessions/:sessionId — revoke one session
    // (24_API_CONTRACTS.md). Scoped to the caller's OWN sessions only —
    // never trusts a client-supplied user ID (IDOR discipline, 27_SECURITY.md).
    // -----------------------------------------------------------------
    fastify.delete(
      "/api/auth/sessions/:sessionId",
      { preHandler: [requireAuth, requireCsrfHeader] },
      async (request, reply) => {
        if (reply.sent) return;
        const { sessionId } = request.params as { sessionId: string };
        const deletedCount = await deleteSessionById(db, sessionId, request.authUser!.id);
        if (deletedCount === 0) {
          await reply.code(404).send({
            error_code: "SESSION_NOT_FOUND",
            message_key: "errors.auth.sessionNotFound",
            parameters: {},
          });
          return;
        }
        if (sessionId === request.authSessionId) {
          clearSessionCookie(reply, config, request);
        }
        return { data: { success: true } };
      },
    );
  };
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
