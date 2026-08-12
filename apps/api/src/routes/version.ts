import type { FastifyPluginAsync } from "fastify";
import type { AppConfig } from "../config.js";

/**
 * The Self-bot schema_migrations max this build was scaffolded against
 * (vendor/self-bot-schema submodule pin, 06_VERSIONING_AND_COMPATIBILITY.md).
 * Step 01 declares no Dashboard-specific floor beyond "the shared schema
 * exists" - the first real dependency (web_upload_intake) arrives in Step 07
 * and will replace this constant with a real compatibility gate.
 * Bump this whenever the submodule pin in vendor/self-bot-schema is bumped.
 */
const SELF_BOT_SCHEMA_MAX_AT_SCAFFOLD = "0014";

export function versionRoutes(config: AppConfig): FastifyPluginAsync {
  // eslint-disable-next-line @typescript-eslint/require-await -- FastifyPluginAsync's contract
  return async (fastify) => {
    fastify.get("/api/version", () => {
      return {
        service: "bunny-command-center-api",
        version: config.appVersion,
        selfBotSchemaMaxAtScaffold: SELF_BOT_SCHEMA_MAX_AT_SCAFFOLD,
        dashboardMigrationLedgerFloor: null,
      };
    });
  };
}
