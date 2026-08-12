import { pathToFileURL } from "node:url";
import Fastify, { LogController } from "fastify";
import { loadAppConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { healthRoutes } from "./routes/health.js";
import { versionRoutes } from "./routes/version.js";

const POLLED_HEALTH_ROUTES = new Set(["/healthz", "/readyz"]);

export async function buildServer(config = loadAppConfig()) {
  const logger = createLogger(config.logLevel);
  const fastify = Fastify({
    loggerInstance: logger,
    // /healthz and /readyz are polled frequently by load balancers /
    // orchestrators - Fastify's automatic info-level "incoming
    // request"/"request completed" lines would spam the log at that volume,
    // so they're suppressed here; each handler emits its own explicit
    // debug-level line instead (routes/health.ts).
    logController: new LogController({
      disableRequestLogging: (request) => POLLED_HEALTH_ROUTES.has(request.url),
    }),
  });

  await fastify.register(healthRoutes(config));
  await fastify.register(versionRoutes(config));

  return fastify;
}

async function main(): Promise<void> {
  const config = loadAppConfig();
  const fastify = await buildServer(config);

  const shutdown = async (signal: string): Promise<void> => {
    fastify.log.info({ signal }, "shutting down");
    await fastify.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await fastify.listen({ port: config.port, host: "0.0.0.0" });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

// pathToFileURL (not manual string concatenation) so this is correct on
// Windows too, where a naive `file://${argv[1]}` is missing the extra `/`
// before the drive letter (`file:///D:/...`) and silently never matches -
// found by observing the built server exit immediately with no output.
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  void main();
}
