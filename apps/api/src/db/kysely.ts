import { Kysely, MysqlDialect } from "kysely";
import { createPool } from "mysql2";
import type { DbConfig } from "../config.js";
import type { DB } from "./codegen-types.js";

/** Minimal logger shape — mirrors `notifications/service.ts`'s own `MinimalLogger`, defaults to `console` so every existing call site (several test files construct a client with just one argument) keeps compiling and working unchanged. */
export interface MinimalPoolLogger {
  error(obj: unknown, msg?: string): void;
}

/**
 * Typed query client for the runtime app (ADR-022). Never issues DDL — the
 * migration runner (apps/api/migrations/) is the only thing allowed to.
 *
 * External-review item 3 (health.test.ts "DB DOWN" investigation): the raw
 * mysql2 `Pool` is a Node `EventEmitter` — per Node's own EventEmitter
 * contract, an `'error'` event with NO listener attached is thrown
 * synchronously and crashes the process (or fails an entire Vitest file)
 * instead of politely rejecting the one query's promise the way every
 * per-call `try/catch` in this codebase (`sse/poller.ts`,
 * `notifications/reconciliationWatcher.ts`) already assumes it will. This
 * surfaced for real once `buildServer()` grew a SECOND concurrent
 * background consumer of this SAME shared pool (Step 09's reconciliation
 * watcher, alongside Step 03's pre-existing SSE poller): two simultaneous
 * connection attempts against a genuinely unreachable host can produce a
 * raw pool-level `'error'` event (confirmed against the real
 * `PoolConnection._handleTimeoutError` stack) that neither poller's own
 * query-level `try/catch` ever gets a chance to catch, because it never
 * reaches either poller's query promise at all — it fires on the pool
 * itself. A single permanent listener here absorbs it exactly like every
 * other background-tick failure in this codebase is already meant to be
 * absorbed: logged, never fatal.
 */
export function createKyselyClient(config: DbConfig, logger: MinimalPoolLogger = console): Kysely<DB> {
  const pool = createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionLimit: 10,
    // External-review item 3: without an explicit bound here, a NEW pool
    // connection attempt against an unreachable host has no defined upper
    // bound of its own (unlike `readiness.ts`'s own dedicated connection,
    // which has always set `connectTimeout: 3000` for exactly this reason).
    // Once `buildServer()` grew a SECOND concurrent background consumer of
    // this shared pool (Step 09's reconciliation watcher, alongside Step
    // 03's pre-existing SSE poller), two simultaneous unbounded connection
    // attempts against a genuinely unreachable host reproduced a real,
    // deterministic failure in this environment (`health.test.ts`'s "DB
    // DOWN" cases) that a single hanging attempt (baseline, before Step 09)
    // never triggered. Matching `readiness.ts`'s already-proven-safe 3s
    // bound here makes every consumer of this pool fail fast and
    // predictably instead of racing an effectively-unbounded OS-level
    // default.
    connectTimeout: 3000,
  });
  pool.on("error", (err: unknown) => {
    logger.error({ err }, "mysql2 pool: background connection error (contained, never crashes the process)");
  });

  const dialect = new MysqlDialect({ pool });

  return new Kysely<DB>({ dialect });
}
