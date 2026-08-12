import type { FastifyPluginAsync } from "fastify";
import type { AppConfig } from "../config.js";
import { checkReadiness } from "../readiness.js";

export function healthRoutes(config: AppConfig): FastifyPluginAsync {
  // eslint-disable-next-line @typescript-eslint/require-await -- FastifyPluginAsync's contract
  return async (fastify) => {
    // Proves only that the API process itself is alive. Deliberately has NO
    // DB dependency, of any kind - not even a lazy/cached one - so it stays
    // 200 even when MySQL is completely unreachable. The automatic
    // info-level "incoming request"/"request completed" lines Fastify would
    // otherwise emit for this frequently-polled route are suppressed via
    // `disableRequestLogging` in server.ts; this explicit call is the only
    // trace left, at debug level (00_GLOBAL_IMPLEMENTATION_RULES.md /
    // 01_foundations_and_scaffolding.md's OBSERVABILITY section).
    fastify.get("/healthz", (request) => {
      request.log.debug("healthz poll");
      return { status: "ok" };
    });

    // Only succeeds if MySQL is reachable AND the Dashboard's own migration
    // ledger is bootstrapped and clean (see src/readiness.ts for the exact
    // Step-01 scope of "ready"). Same debug-only logging treatment as
    // /healthz above.
    fastify.get("/readyz", async (request, reply) => {
      const result = await checkReadiness(config.db);
      request.log.debug({ ready: result.ready, reason: result.reason }, "readyz poll");
      if (!result.ready) {
        reply.code(503);
        return { status: "not_ready", reason: result.reason };
      }
      return { status: "ready" };
    });
  };
}
