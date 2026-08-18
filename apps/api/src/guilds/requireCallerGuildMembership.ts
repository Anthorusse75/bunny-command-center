/**
 * Personal-guild-membership gate for the CALLER'S OWN preference mutations
 * (`POST /api/users/me/guilds/:guildId/favorite`,
 * `PATCH /api/users/me/guilds/:guildId/home-visibility`) — deliberately
 * NOT `requireTier`, and NEVER bypasses for Superadmin.
 *
 * EXTERNAL REVIEW CORRECTION (Step 06, second correction pass, Residual 2):
 * these two routes previously used `requireTier(guildIdParam, "USER")`.
 * Step 05's `assertGuildMembership` intentionally bypasses membership for
 * Superadmin — correct for PRODUCT guild routes such as
 * `GET /api/guilds/:guildId`, where the platform Superadmin genuinely has
 * platform-wide access regardless of their own personal Discord servers
 * (`08_AUTHORIZATION_AND_RBAC.md`). A personal Dashboard preference
 * (favorite / home-visible) is a different kind of fact: it records
 * something about the CALLER'S OWN live Discord guild membership.
 * Superadmin's platform privilege must never fabricate a personal
 * membership that doesn't actually exist — a Superadmin with zero real
 * guilds must still be rejected here, exactly like any other non-member,
 * even though the exact same Superadmin succeeds on
 * `GET /api/guilds/:guildId`.
 *
 * Reuses `getCallerGuildsForListing` — the EXACT SAME cached OAuth
 * guild-list fetch (`guildAuthorization.ts`'s `getCallerGuilds`, the one
 * function in this codebase that ever calls Discord's
 * `GET /users/@me/guilds`) that `assertGuildMembership` and
 * `buildGuildList` already use — with NO Superadmin short-circuit added on
 * top, so this is not a second Discord-membership implementation, just a
 * different (Superadmin-blind) decision built on the same fetch.
 *
 * Returns the SAME 404 shape (`GUILD_NOT_FOUND`) `requireTier` uses for a
 * well-formed but non-member guildId — indistinguishable from a
 * nonexistent guild, per `08_AUTHORIZATION_AND_RBAC.md`'s response
 * convention, and reuses `tier.ts`'s exact `respondReauthRequired` for a
 * revoked/expired Discord grant (this gate also goes through
 * `DiscordTokenService.withFreshAccessToken`, via `getCallerGuildsForListing`).
 *
 * EXTERNAL REVIEW CORRECTION (Step 06, Copilot review pass, Finding 4): the
 * `!isMember` branch below sent the 404 but did not explicitly `return`
 * afterward, the one branch in this file inconsistent with its own 401 and
 * `DiscordReauthRequiredError` branches (both of which already `return`).
 * Made explicit for the same reason `validateGuildIdParam` was
 * (`routes.ts`'s matching correction) — not because the rejected mutation
 * was reproduced actually reaching `setFavorite`/`setHomeVisibility`
 * (Fastify's own `reply.sent` check already prevents that, and this was
 * already covered by this step's own passing non-member-rejection tests),
 * but for explicitness and consistency with this file's other two branches.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  getCallerGuildsForListing,
  respondReauthRequired,
  DiscordReauthRequiredError,
  type GuildAuthDeps,
} from "../auth/index.js";

export function buildRequireCallerGuildMembership(
  deps: GuildAuthDeps,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    if (!request.authUser) {
      await reply.code(401).send({
        error_code: "UNAUTHENTICATED",
        message_key: "errors.auth.unauthenticated",
        parameters: {},
      });
      return;
    }
    // `validateGuildIdParam` (routes.ts) already ran and confirmed this is
    // a syntactically-valid snowflake before this preHandler is reached.
    const { guildId } = request.params as { guildId: string };
    const caller = { id: request.authUser.id, discordUserId: request.authUser.discordUserId };
    try {
      const guilds = await getCallerGuildsForListing(deps, caller, "READ");
      const isMember = guilds.some((g) => g.id === guildId);
      if (!isMember) {
        await reply
          .code(404)
          .send({ error_code: "GUILD_NOT_FOUND", message_key: "errors.guilds.notFound", parameters: {} });
        return;
      }
    } catch (err) {
      if (err instanceof DiscordReauthRequiredError) {
        await respondReauthRequired(deps, request, reply);
        return;
      }
      throw err;
    }
  };
}
