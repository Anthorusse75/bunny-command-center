/**
 * `requireTier` -- the ONE shared Fastify preHandler every guild-scoped AND
 * platform-scoped route uses to declare its authorization requirement
 * (08_AUTHORIZATION_AND_RBAC.md, this step's IMPLEMENTATION file: "A shared
 * Fastify plugin/decorator (`requireTier(guildIdParam, minTier)`) applied as
 * the ONLY way any future route declares its authorization requirement --
 * internally calls `assertGuildMembership` first, then resolves the
 * requested tier. No route is allowed to hand-roll its own check.").
 *
 * Two call shapes, matching the step's own explicit requirement that
 * platform-scoped Superadmin routes stay separable from guild-scoped
 * membership checks:
 *   requireTier('SUPERADMIN')                -- PLATFORM-scoped: no guildId
 *                                                 at all, no assertGuildMembership,
 *                                                 pure isSuperadmin check.
 *   requireTier(guildIdParam, minTier, opts?) -- GUILD-scoped: assertGuildMembership
 *                                                 runs first, unconditionally,
 *                                                 then tier resolution.
 *
 * `opts.freshness` (08_AUTHORIZATION_AND_RBAC.md §Permission freshness,
 * D-070) -- defaults to `"READ"`, which may be served from the 60s
 * `GuildAuthCache` within its TTL. Every SENSITIVE MUTATION route (guild
 * config write, pause/resume, approval decision, admin role policy change,
 * override toggle, any `operator_commands` enqueue -- Steps 10/12) MUST pass
 * `{ freshness: "SENSITIVE_MUTATION" }` instead: `assertGuildMembership` and
 * tier resolution then both bypass the cache entirely and re-resolve live,
 * exactly matching D-070's "never from a value cached ... or trusted from
 * the client." This is the ONE sanctioned freshness control for the RBAC
 * path -- no route may invent its own cache-clearing/bypass logic.
 *
 * MUST be chained AFTER `requireAuth` in a route's `preHandler` array
 * (`{ preHandler: [requireAuth, requireTier(...)] }`, mirroring the existing
 * `[requireAuth, requireCsrfHeader]` convention in `routes.ts`) -- this
 * function reads `request.authUser`/`request.authSessionId`, which only
 * `requireAuth` ever sets; it does not re-implement session/cookie parsing
 * itself (single-responsibility: authentication is Step 04's concern,
 * authorization is this step's).
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { isSuperadmin } from "./superadmin.js";
import {
  assertGuildMembership,
  resolveGuildAuthorization,
  isCallerGuildOwner,
  GUILD_TIER_RANK,
  type AuthorizationFreshness,
  type GuildAuthDeps,
  type GuildTier,
} from "./guildAuthorization.js";
import { DiscordReauthRequiredError } from "./discordTokenService.js";
import { clearSessionCookie } from "./sessionCookie.js";
import { deleteSessionById } from "./sessionRepo.js";

export interface ResolvedGuildAuthorization {
  guildId: string;
  tier: GuildTier;
}

/** See this module's header comment on `opts.freshness`. */
export interface RequireTierOptions {
  freshness?: AuthorizationFreshness;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by `requireTier`'s guild-scoped form -- the guild the route is scoped to and the caller's resolved tier for exactly that guild. */
    guildAuthorization?: ResolvedGuildAuthorization;
  }
}

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * 07_DISCORD_OAUTH.md's refresh-failure contract, wired at the ONE place a
 * guild-scoped/platform-scoped route first makes a live Discord call:
 * invalidates the CURRENT session (not logout-all -- 08_AUTHORIZATION_AND_RBAC.md
 * §Permission freshness draws the same "current session only" line for a
 * guild-tier change; a revoked Discord GRANT is user-wide, but every other
 * open session independently discovers the same failure on ITS OWN next
 * admin-gated request, so no eager cross-session fan-out is needed), clears
 * the browser cookie, and returns the documented re-login response -- never
 * a raw 401 with no explanation, never a half-authenticated browser state.
 */
/**
 * Exported (Step 06 second external-review correction pass, Residual 2):
 * `guilds/requireCallerGuildMembership.ts` reuses this EXACT re-login
 * response rather than duplicating it -- the personal-guild-membership gate
 * for favorite/home-visibility mutations goes through
 * `DiscordTokenService.withFreshAccessToken` too (via
 * `getCallerGuildsForListing`) and must fail the same documented way on a
 * revoked/expired Discord grant.
 */
export async function respondReauthRequired(
  deps: GuildAuthDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (request.authSessionId && request.authUser) {
    await deleteSessionById(deps.db, request.authSessionId, request.authUser.id).catch((err: unknown) => {
      request.log.warn({ err }, "requireTier: failed to delete session during Discord-reauth invalidation");
    });
  }
  clearSessionCookie(reply, deps.config, request);
  await reply.code(401).send({
    error_code: "DISCORD_REAUTH_REQUIRED",
    message_key: "errors.auth.discordReauthRequired",
    parameters: {},
  });
}

function extractGuildId(request: FastifyRequest, guildIdParam: string): string | undefined {
  const params = request.params as Record<string, unknown> | undefined;
  const value = params?.[guildIdParam];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function buildRequireTier(deps: GuildAuthDeps) {
  function requireTier(minTier: "SUPERADMIN"): PreHandler;
  function requireTier(guildIdParam: string, minTier: GuildTier, options?: RequireTierOptions): PreHandler;
  function requireTier(a: string, b?: GuildTier, options?: RequireTierOptions): PreHandler {
    // -----------------------------------------------------------------
    // Platform-scoped form: requireTier('SUPERADMIN') -- no guildId, no
    // assertGuildMembership, no guild-authorization resolution at all.
    // -----------------------------------------------------------------
    if (b === undefined) {
      if (a !== "SUPERADMIN") {
        throw new Error(
          `requireTier(minTier) single-argument form only supports 'SUPERADMIN' (platform-scoped). Got: ${a}`,
        );
      }
      return async (request, reply) => {
        if (!request.authUser) {
          await reply.code(401).send({
            error_code: "UNAUTHENTICATED",
            message_key: "errors.auth.unauthenticated",
            parameters: {},
          });
          return;
        }
        if (!isSuperadmin(request.authUser.discordUserId, deps.config)) {
          request.log.warn(
            { route: request.routeOptions?.url, minTier: "SUPERADMIN" },
            "requireTier: 403 (platform-scoped, caller is not Superadmin)",
          );
          await reply.code(403).send({
            error_code: "FORBIDDEN",
            message_key: "errors.auth.insufficientPermissions",
            parameters: {},
          });
          return;
        }
      };
    }

    // -----------------------------------------------------------------
    // Guild-scoped form: assertGuildMembership FIRST, unconditionally (IDOR
    // checklist item 2), then tier resolution (item 3).
    // -----------------------------------------------------------------
    const guildIdParam = a;
    const minTier = b;
    const freshness: AuthorizationFreshness = options?.freshness ?? "READ";
    return async (request, reply) => {
      if (!request.authUser) {
        await reply.code(401).send({
          error_code: "UNAUTHENTICATED",
          message_key: "errors.auth.unauthenticated",
          parameters: {},
        });
        return;
      }
      const guildId = extractGuildId(request, guildIdParam);
      if (!guildId) {
        // A route wired to requireTier with a param name that isn't
        // actually present in its own path pattern is a programmer error,
        // not a client-triggerable outcome -- fails closed as 404 anyway
        // (never leaks "this route is misconfigured" to the caller).
        await reply
          .code(404)
          .send({ error_code: "GUILD_NOT_FOUND", message_key: "errors.guilds.notFound", parameters: {} });
        return;
      }

      const caller = { id: request.authUser.id, discordUserId: request.authUser.discordUserId };

      try {
        const isMember = await assertGuildMembership(deps, caller, guildId, freshness);
        if (!isMember) {
          // 404, not 403 -- deliberately indistinguishable from a
          // nonexistent guildId (08_AUTHORIZATION_AND_RBAC.md's response
          // convention: never leak guild existence to a non-member).
          await reply
            .code(404)
            .send({ error_code: "GUILD_NOT_FOUND", message_key: "errors.guilds.notFound", parameters: {} });
          return;
        }

        const tier = await resolveGuildAuthorization(deps, caller, guildId, freshness);
        if (GUILD_TIER_RANK[tier] < GUILD_TIER_RANK[minTier]) {
          request.log.warn(
            { route: request.routeOptions?.url, guildId, minTier, resolvedTier: tier },
            "requireTier: 403 (guild membership confirmed, tier insufficient)",
          );
          await reply.code(403).send({
            error_code: "FORBIDDEN",
            message_key: "errors.auth.insufficientPermissions",
            parameters: {},
          });
          return;
        }

        request.guildAuthorization = { guildId, tier };
      } catch (err) {
        if (err instanceof DiscordReauthRequiredError) {
          await respondReauthRequired(deps, request, reply);
          return;
        }
        throw err;
      }
    };
  }
  return requireTier;
}

/**
 * Step 10 correction round, Gap 1: gates a route on the literal Discord guild
 * Owner (`isCallerGuildOwner`), NOT on `GUILD_ADMIN` tier — a Guild Admin who
 * holds the configured admin role or the Discord ADMINISTRATOR bit but is
 * not the guild's Owner must be rejected. Superadmin still bypasses (matches
 * `isCallerGuildOwner`'s own documented Superadmin bypass).
 *
 * Deliberately mirrors `buildRequireTier`'s guild-scoped form structurally
 * (`requireAuth` precondition, `assertGuildMembership` first for the
 * documented 404-not-403 non-member behavior, then the actual gate) rather
 * than being a copy-pasted RBAC re-derivation — the only new decision this
 * function makes is Owner-vs-not; membership and tier resolution are the
 * exact same calls `buildRequireTier` makes.
 *
 * `request.guildAuthorization` is still populated (via `resolveGuildAuthorization`)
 * so downstream service calls (`transitionGuildLifecycle`) receive the
 * caller's real tier (`GUILD_ADMIN` for a genuine Owner — `resolveGuildAuthorization`'s
 * Owner branch always resolves to `GUILD_ADMIN` unconditionally; `SUPERADMIN`
 * for the platform Superadmin) exactly as every other route already expects.
 */
export function buildRequireGuildOwner(deps: GuildAuthDeps) {
  return function requireGuildOwner(guildIdParam: string, options?: RequireTierOptions): PreHandler {
    const freshness: AuthorizationFreshness = options?.freshness ?? "READ";
    return async (request, reply) => {
      if (!request.authUser) {
        await reply.code(401).send({
          error_code: "UNAUTHENTICATED",
          message_key: "errors.auth.unauthenticated",
          parameters: {},
        });
        return;
      }
      const guildId = extractGuildId(request, guildIdParam);
      if (!guildId) {
        await reply
          .code(404)
          .send({ error_code: "GUILD_NOT_FOUND", message_key: "errors.guilds.notFound", parameters: {} });
        return;
      }

      const caller = { id: request.authUser.id, discordUserId: request.authUser.discordUserId };

      try {
        const isMember = await assertGuildMembership(deps, caller, guildId, freshness);
        if (!isMember) {
          await reply
            .code(404)
            .send({ error_code: "GUILD_NOT_FOUND", message_key: "errors.guilds.notFound", parameters: {} });
          return;
        }

        const [isOwner, tier] = await Promise.all([
          isCallerGuildOwner(deps, caller, guildId, freshness),
          resolveGuildAuthorization(deps, caller, guildId, freshness),
        ]);
        if (!isOwner) {
          request.log.warn(
            { route: request.routeOptions?.url, guildId, resolvedTier: tier },
            "requireGuildOwner: 403 (guild membership confirmed, caller is not the guild Owner)",
          );
          await reply.code(403).send({
            error_code: "FORBIDDEN",
            message_key: "errors.auth.insufficientPermissions",
            parameters: {},
          });
          return;
        }

        request.guildAuthorization = { guildId, tier };
      } catch (err) {
        if (err instanceof DiscordReauthRequiredError) {
          await respondReauthRequired(deps, request, reply);
          return;
        }
        throw err;
      }
    };
  };
}
