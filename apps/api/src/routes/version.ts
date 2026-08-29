import type { FastifyPluginAsync } from "fastify";
import type { AppConfig } from "../config.js";
import { SUPPORTED_SHARED_SCHEMA_MIN, SUPPORTED_SHARED_SCHEMA_MAX } from "../sharedSchemaCompat.js";

export function versionRoutes(config: AppConfig): FastifyPluginAsync {
  // eslint-disable-next-line @typescript-eslint/require-await -- FastifyPluginAsync's contract
  return async (fastify) => {
    // Reports what this BUILD supports (static, compiled-in constants) —
    // never a live query against the actual applied schema, which is
    // /readyz's job (sharedSchemaCompat.ts's own doc comment). Both this
    // route and readiness.ts read the SAME canonical
    // SUPPORTED_SHARED_SCHEMA_MIN/_MAX declaration, never a second,
    // independently-editable literal (Step 10 post-merge correction —
    // this previously reported a stale scaffold-era "0014" that never
    // moved when the submodule pin was actually bumped).
    fastify.get("/api/version", () => {
      return {
        service: "bunny-command-center-api",
        version: config.appVersion,
        supportedSharedSchemaMin: SUPPORTED_SHARED_SCHEMA_MIN,
        supportedSharedSchemaMax: SUPPORTED_SHARED_SCHEMA_MAX,
      };
    });
  };
}
