/**
 * `/api/users/me/guilds*` + `/api/guilds/:guildId` — 24_API_CONTRACTS.md
 * §Users/Profile + §Guild overview, IMPLEMENTATION/06_multi_guild_navigation.md.
 *
 * This module is Step 06's closure of Step 05's documented `requireTier`
 * production-wiring gap ("there is currently NO production guild-scoped
 * application route") — `GET /api/guilds/:guildId` below is the first real
 * product route guarded by the shared `requireTier(guildIdParam, 'USER')`,
 * not a test-only sample route.
 */
import type { FastifyPluginAsync } from "fastify";
import type { Kysely } from "kysely";
import type { DB } from "../db/codegen-types.js";
import type { AppConfig } from "../config.js";
import { buildRequireTier, createGuildAuthDeps, type GuildAuthDeps } from "../auth/index.js";
import { buildRequireAuth, requireCsrfHeader } from "../auth/requireAuth.js";
import {
  buildGuildList,
  buildBotInviteUrl,
  getGuildOverview,
  setFavorite,
  setHomeVisibility,
} from "./guildsService.js";
import { touchLastUsed } from "./guildPreferencesRepo.js";

export function buildGuildRoutes(
  db: Kysely<DB>,
  config: AppConfig,
  guildAuthDepsOverride?: GuildAuthDeps,
): FastifyPluginAsync {
  const guildAuthDeps = guildAuthDepsOverride ?? createGuildAuthDeps(db, config);
  const requireTier = buildRequireTier(guildAuthDeps);
  const requireAuth = buildRequireAuth(db, config);

  // eslint-disable-next-line @typescript-eslint/require-await -- FastifyPluginAsync's contract
  return async (fastify) => {
    // -------------------------------------------------------------------
    // GET /api/users/me/guilds — live-cross-referenced guild list
    // (favorites first, then alphabetical), USER tier (any authenticated
    // caller — this is about THEIR OWN guild list, no guildId to gate on).
    // -------------------------------------------------------------------
    fastify.get("/api/users/me/guilds", { preHandler: [requireAuth] }, async (request) => {
      const caller = { id: request.authUser!.id, discordUserId: request.authUser!.discordUserId };
      const result = await buildGuildList(guildAuthDeps, caller, request.authUser!.id);
      return {
        data: {
          guilds: result.guilds,
          inviteEligibleGuilds: result.inviteEligibleGuilds,
          canInviteBunnyAnywhere: result.canInviteBunnyAnywhere,
          inviteUrl: buildBotInviteUrl(config.discord),
        },
      };
    });

    // -------------------------------------------------------------------
    // POST /api/users/me/guilds/:guildId/favorite — toggle favorite.
    // Body: { isFavorite: boolean }. This is a preference about the
    // CALLER'S OWN relationship to a guild, not a guild-admin action, so it
    // is guarded by `requireAuth` (any authenticated user) rather than
    // `requireTier` — Kysely's PK upsert (guildPreferencesRepo.ts) is the
    // only thing scoping it, always to `request.authUser.id`, never a
    // client-supplied user id (IDOR discipline, 27_SECURITY.md). No
    // membership check against the guild is required either: favoriting a
    // guild the caller no longer belongs to is harmless (it simply won't
    // appear in a future `GET .../guilds` response's `usable` list once
    // membership truth — re-fetched live, never cached — no longer includes
    // it) and rejecting it would require an extra live Discord round trip
    // this mutation has no real need for.
    // -------------------------------------------------------------------
    fastify.post(
      "/api/users/me/guilds/:guildId/favorite",
      { preHandler: [requireAuth, requireCsrfHeader] },
      async (request, reply) => {
        if (reply.sent) return;
        const { guildId } = request.params as { guildId: string };
        const body = request.body as { isFavorite?: unknown } | undefined;
        if (typeof body?.isFavorite !== "boolean") {
          await reply.code(400).send({
            error_code: "VALIDATION_ERROR",
            message_key: "errors.validation",
            parameters: {},
          });
          return;
        }
        const row = await setFavorite(db, request.authUser!.id, guildId, body.isFavorite);
        return { data: row };
      },
    );

    // -------------------------------------------------------------------
    // PATCH /api/users/me/guilds/:guildId/home-visibility — toggle Home
    // widget visibility for this guild. Body: { homeVisible: boolean }.
    // Same authorization shape as the favorite route above.
    // -------------------------------------------------------------------
    fastify.patch(
      "/api/users/me/guilds/:guildId/home-visibility",
      { preHandler: [requireAuth, requireCsrfHeader] },
      async (request, reply) => {
        if (reply.sent) return;
        const { guildId } = request.params as { guildId: string };
        const body = request.body as { homeVisible?: unknown } | undefined;
        if (typeof body?.homeVisible !== "boolean") {
          await reply.code(400).send({
            error_code: "VALIDATION_ERROR",
            message_key: "errors.validation",
            parameters: {},
          });
          return;
        }
        const row = await setHomeVisibility(db, request.authUser!.id, guildId, body.homeVisible);
        return { data: row };
      },
    );

    // -------------------------------------------------------------------
    // GET /api/guilds/:guildId — overview summary (24_API_CONTRACTS.md),
    // USER tier. THE real production route closing Step 05's requireTier
    // wiring gap: assertGuildMembership -> Guild Admin Resolution ->
    // exact-route-guild-scoped response, exactly the IDOR checklist
    // (08_AUTHORIZATION_AND_RBAC.md) applied for real for the first time.
    // Deliberately placeholder-shaped content (full PremiumPlus/stock/
    // forecast content is Step 13's scope) — the AUTH GUARD is what this
    // step proves, not the business content.
    // -------------------------------------------------------------------
    fastify.get(
      "/api/guilds/:guildId",
      { preHandler: [requireAuth, requireTier("guildId", "USER")] },
      async (request) => {
        const { guildId, tier } = request.guildAuthorization!;
        const overview = await getGuildOverview(db, guildId);
        // "view guild overview" is itself a meaningful guild-scoped action
        // (09_MULTI_GUILD_MODEL.md §Last-used guild) — never blocks/delays
        // the response on failure (a preference-write hiccup must never
        // turn a successful guild-overview read into a 500).
        await touchLastUsed(db, request.authUser!.id, guildId).catch((err: unknown) => {
          request.log.warn({ err, guildId }, "guilds: failed to touch last_used_at (non-fatal)");
        });
        return {
          data: {
            guildId: overview.guildId,
            tier,
            botPresent: overview.botPresent,
            enabled: overview.enabled,
            displayName: overview.displayName,
          },
        };
      },
    );
  };
}
