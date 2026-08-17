/**
 * Background sweep for `OAuthTransactionRegistry`'s consumed-state `Map`
 * (that class's own doc comment: "Swept periodically so this Map cannot
 * grow unbounded under sustained traffic" — documented but never actually
 * wired up anywhere, a real gap caught in Copilot's Step-04 review pass).
 * Mirrors `sessionSweep.ts`'s start/stop-handle shape (so `server.ts`'s
 * `preClose` hook can clean it up the exact same way) and `poller.ts`'s
 * `timer.unref()` convention (so this timer never keeps the process alive
 * on its own).
 *
 * A consumed state only needs to stay blocked for as long as a replay could
 * plausibly still arrive — bounded by the transaction's OWN validity window
 * (`OAUTH_TRANSACTION_MAX_AGE_MS`). Once that window has passed, any replay
 * attempt independently fails `routes.ts`'s `isTransactionExpired` check
 * regardless of whether this registry still remembers the state, so
 * retaining an entry any longer than that serves no purpose — hence reusing
 * that exact constant as the default sweep age, rather than inventing a
 * second, unrelated retention window.
 */
import type { FastifyBaseLogger } from "fastify";
import type { OAuthTransactionRegistry } from "./oauthTransactionRegistry.js";
import { OAUTH_TRANSACTION_MAX_AGE_MS } from "./transactionCookie.js";

export interface OAuthTransactionSweepHandle {
  stop(): void;
  /** Test hook: run exactly one sweep synchronously (avoids real-timer waits in tests). */
  runOnceForTests(): void;
}

/**
 * Short relative to `OAUTH_TRANSACTION_MAX_AGE_MS` (10 minutes) so the map
 * never meaningfully outgrows roughly one max-age window's worth of
 * consumed states under sustained login traffic.
 */
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export function startOAuthTransactionSweep(params: {
  registry: OAuthTransactionRegistry;
  logger: FastifyBaseLogger;
  intervalMs?: number;
  maxAgeMs?: number;
}): OAuthTransactionSweepHandle {
  const intervalMs = params.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const maxAgeMs = params.maxAgeMs ?? OAUTH_TRANSACTION_MAX_AGE_MS;

  const runSweep = (): void => {
    try {
      params.registry.sweep(maxAgeMs);
    } catch (err) {
      // sweep() is a pure in-memory Map operation and should never actually
      // throw, but a sweep tick must never be allowed to crash the process
      // regardless (same "never bring down the app for a background
      // maintenance task" discipline as sessionSweep.ts/poller.ts).
      params.logger.error({ err }, "auth: OAuth transaction registry sweep failed");
    }
  };

  const timer = setInterval(runSweep, intervalMs);
  timer.unref();

  return {
    stop(): void {
      clearInterval(timer);
    },
    runOnceForTests(): void {
      runSweep();
    },
  };
}
