/**
 * Background expired-session sweep (ADR-020 risk mitigation: "expired-session
 * sweep job (same idiom as the existing blob_purge/scheduled_cleanup
 * background-task pattern already in the Self-bot repo, reimplemented for
 * this repo)"). Mirrors `apps/api/src/sse/poller.ts`'s
 * start/stop-handle shape so `server.ts`'s `preClose` hook can clean it up
 * the same way.
 */
import type { Kysely } from "kysely";
import type { DB } from "../db/codegen-types.js";
import type { FastifyBaseLogger } from "fastify";
import { sweepExpiredSessions } from "./sessionRepo.js";

export interface SessionSweepHandle {
  stop(): void;
}

export function startSessionSweep(params: {
  db: Kysely<DB>;
  logger: FastifyBaseLogger;
  intervalMs: number;
}): SessionSweepHandle {
  const timer = setInterval(() => {
    sweepExpiredSessions(params.db)
      .then((deletedCount) => {
        if (deletedCount > 0) {
          params.logger.info({ deletedCount }, "auth: expired session sweep removed rows");
        }
      })
      .catch((err: unknown) => {
        params.logger.error({ err }, "auth: expired session sweep failed");
      });
  }, params.intervalMs);
  timer.unref();

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
