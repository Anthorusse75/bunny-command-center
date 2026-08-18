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
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { DB } from "../db/codegen-types.js";
import type { AppConfig } from "../config.js";
import {
  guildIdParamSchema,
  favoriteRequestSchema,
  homeVisibilityRequestSchema,
} from "@bunny-command-center/shared";
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
import { buildRequireCallerGuildMembership } from "./requireCallerGuildMembership.js";

/**
 * `:guildId` route-param shape check (external review correction —
 * `guildIdParamSchema`, `packages/shared/src/types/guilds.ts`), run BEFORE
 * `requireTier` on every guild-scoped route below. Must run before, not
 * after: `requireTier`/`assertGuildMembership` already fail closed to 404 on
 * a syntactically-invalid guildId (it simply won't match anything in the
 * caller's live membership list), which would make a validation-specific
 * 400 unreachable if this ran afterward — the two failure modes ("this
 * doesn't even look like a Discord ID" vs "you don't have access to this
 * real guild") stay distinct on purpose, matching this codebase's existing
 * 403-vs-404 authorization-code discipline.
 */
async function validateGuildIdParam(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = guildIdParamSchema.safeParse(request.params);
  if (!result.success) {
    await reply.code(400).send({
      error_code: "VALIDATION_ERROR",
      message_key: "errors.validation",
      parameters: {},
    });
  }
}

export function buildGuildRoutes(
  db: Kysely<DB>,
  config: AppConfig,
  guildAuthDepsOverride?: GuildAuthDeps,
): FastifyPluginAsync {
  const guildAuthDeps = guildAuthDepsOverride ?? createGuildAuthDeps(db, config);
  const requireTier = buildRequireTier(guildAuthDeps);
  const requireCallerGuildMembership = buildRequireCallerGuildMembership(guildAuthDeps);
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
    // CALLER'S OWN relationship to a guild — Kysely's PK upsert
    // (guildPreferencesRepo.ts) always scopes the WRITE to
    // `request.authUser.id`, never a client-supplied user id (IDOR
    // discipline, 27_SECURITY.md).
    //
    // EXTERNAL REVIEW CORRECTION (Step 06 correction pass): this route
    // previously used ONLY `requireAuth` + `requireCsrfHeader`, with NO
    // guild-membership check at all before persisting a preference row —
    // an authenticated caller with a valid CSRF header could write a
    // durable row for ANY guildId string, including one they have no
    // Discord relationship to whatsoever. The original comment's "no
    // membership check is required, favoriting a guild the caller no
    // longer belongs to is harmless" reasoning conflated two different
    // things: "the caller WAS a member and later left" (genuinely harmless,
    // matches the reasoning) vs "the caller was NEVER a member of this
    // guildId at all" (an arbitrary-guild IDOR write, not harmless — an
    // unbounded write surface with no relationship check).
    //
    // SECOND CORRECTION PASS (Residual 2): the first fix used
    // `requireTier(guildIdParam, "USER")` — but that reuses
    // `assertGuildMembership`, whose Superadmin bypass is correct for
    // PRODUCT guild routes (`GET /api/guilds/:guildId`) and WRONG here: a
    // Superadmin's platform privilege must never fabricate a personal
    // Discord membership for a guild they don't actually belong to. Fixed
    // by using `requireCallerGuildMembership` instead
    // (`requireCallerGuildMembership.ts` — same cached OAuth guild-list
    // fetch, no Superadmin short-circuit, see that file's header comment).
    // `"READ"` freshness (the default that gate uses) is correct here, not
    // `"SENSITIVE_MUTATION"`: this mutates a Dashboard-owned preference row,
    // never a guild's real configuration/bot behavior (D-070's freshness
    // bypass is reserved for sensitive guild-config/admin-policy/bot
    // mutations, 00_GLOBAL_IMPLEMENTATION_RULES.md-adjacent — this is
    // exactly the "simple idempotent upsert" case
    // IMPLEMENTATION/06_multi_guild_navigation.md's own Concurrency section
    // already calls out).
    // -------------------------------------------------------------------
    fastify.post(
      "/api/users/me/guilds/:guildId/favorite",
      {
        preHandler: [requireAuth, validateGuildIdParam, requireCsrfHeader, requireCallerGuildMembership],
      },
      async (request, reply) => {
        if (reply.sent) return;
        const { guildId } = request.params as { guildId: string };
        const parsedBody = favoriteRequestSchema.safeParse(request.body);
        if (!parsedBody.success) {
          await reply.code(400).send({
            error_code: "VALIDATION_ERROR",
            message_key: "errors.validation",
            parameters: {},
          });
          return;
        }
        const row = await setFavorite(db, request.authUser!.id, guildId, parsedBody.data.isFavorite);
        return { data: row };
      },
    );

    // -------------------------------------------------------------------
    // PATCH /api/users/me/guilds/:guildId/home-visibility — toggle Home
    // widget visibility for this guild. Body: { homeVisible: boolean }.
    // Same authorization shape as the favorite route above (both correction
    // passes: same missing-membership-check defect, then the same
    // Superadmin-bypass-is-wrong-here defect, same fixes).
    // -------------------------------------------------------------------
    fastify.patch(
      "/api/users/me/guilds/:guildId/home-visibility",
      {
        preHandler: [requireAuth, validateGuildIdParam, requireCsrfHeader, requireCallerGuildMembership],
      },
      async (request, reply) => {
        if (reply.sent) return;
        const { guildId } = request.params as { guildId: string };
        const parsedBody = homeVisibilityRequestSchema.safeParse(request.body);
        if (!parsedBody.success) {
          await reply.code(400).send({
            error_code: "VALIDATION_ERROR",
            message_key: "errors.validation",
            parameters: {},
          });
          return;
        }
        const row = await setHomeVisibility(db, request.authUser!.id, guildId, parsedBody.data.homeVisible);
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
      { preHandler: [requireAuth, validateGuildIdParam, requireTier("guildId", "USER")] },
      async (request, reply) => {
        if (reply.sent) return undefined;
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
