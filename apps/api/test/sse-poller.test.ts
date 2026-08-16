/**
 * Real-MySQL, real-adapter proof of the poller's core mechanism (mission
 * §17/§54's server-side wiring chain: SOURCE DURABLE EVENT -> source adapter
 * -> cursor/watermark read -> event envelope -> SSE hub). No mock DB, no
 * mock adapter - the actual `dashboard_sse_test_source` table and the actual
 * `createSseCursorRepo`/`SseHub` production code.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { Kysely, MysqlDialect } from "kysely";
import { createPool as createKyselyPool } from "mysql2";
import { pino } from "pino";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STEP_03_TEST_SCOPE } from "@bunny-command-center/shared";
import { runUp } from "../migrations/runner.js";
import type { MigratorDbConfig } from "../migrations/config.js";
import { createSseCursorRepo } from "../src/sse/cursorRepo.js";
import { SseHub } from "../src/sse/hub.js";
import { startSsePoller } from "../src/sse/poller.js";
import { registerEventType, registerSourceAdapter, resetRegistryForTests } from "../src/sse/registry.js";
import type { DB } from "../src/db/codegen-types.js";
import {
  TEST_EVENT_TYPE,
  TEST_SOURCE_INDEX,
  createTestSourceAdapter,
  createTestSourceSchema,
  deleteTestRowsUpTo,
  insertTestRow,
  testEventDataSchema,
} from "./helpers/sseTestSource.js";

const ROOT_CONFIG = {
  host: process.env.TEST_MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.TEST_MYSQL_PORT ?? 33070),
  user: "root",
  password: process.env.TEST_MYSQL_ROOT_PASSWORD ?? "devrootpass",
};
const TEST_DB_NAME = "bunny_cc_sse_poller_test";
const REAL_MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const silentLogger = pino({ level: "silent" });

async function freshDatabase(): Promise<MigratorDbConfig> {
  const admin = await mysql.createConnection(ROOT_CONFIG);
  await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB_NAME}\``);
  await admin.query(`CREATE DATABASE \`${TEST_DB_NAME}\``);
  await admin.end();
  const config: MigratorDbConfig = { ...ROOT_CONFIG, database: TEST_DB_NAME };
  const conn = await mysql.createConnection(config);
  try {
    const result = await runUp(conn, REAL_MIGRATIONS_DIR, config);
    if (!result.ok) throw new Error(result.message);
    await createTestSourceSchema(conn);
  } finally {
    await conn.end();
  }
  return config;
}

describe("SSE poller (real MySQL, real adapter)", () => {
  let dbConfig: MigratorDbConfig;
  let kysely: Kysely<DB>;
  let rawPool: mysql.Pool;

  beforeAll(async () => {
    dbConfig = await freshDatabase();
    kysely = new Kysely<DB>({
      dialect: new MysqlDialect({
        pool: createKyselyPool({ ...dbConfig }),
      }),
    });
    rawPool = mysql.createPool({ ...dbConfig });
  });

  afterAll(async () => {
    await kysely.destroy();
    await rawPool.end();
    const admin = await mysql.createConnection(ROOT_CONFIG);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB_NAME}\``);
    await admin.end();
  });

  beforeEach(() => {
    resetRegistryForTests();
    registerEventType({ type: TEST_EVENT_TYPE, schema: testEventDataSchema });
    registerSourceAdapter(createTestSourceAdapter(rawPool));
  });

  afterEach(async () => {
    await rawPool.query("DELETE FROM dashboard_sse_test_source");
    await kysely.deleteFrom("dashboard_sse_cursor").execute();
    resetRegistryForTests();
  });

  it("a real DB row inserted directly becomes a real SSE broadcast within one poll tick (full server-side wiring proof)", async () => {
    const hub = new SseHub();
    const cursorRepo = createSseCursorRepo(kysely);
    const received: unknown[] = [];
    const fakeRes = {
      write: (chunk: string) => {
        received.push(chunk);
        return true;
      },
      on: () => undefined,
    };
    const handle = hub.register({
      scopes: [STEP_03_TEST_SCOPE],
      initialVector: new Map(),
      res: fakeRes as never,
      maxQueuedFrames: 50,
      retryMs: 1000,
    });
    // A real caller (route.ts) always calls completeReplay once replay
    // finishes - this connection has nothing to replay, so it's immediate.
    hub.completeReplay(handle.connectionId);

    const insertedId = await insertTestRow(rawPool as never, "hello-world");

    const poller = startSsePoller({
      hub,
      cursorRepo,
      logger: silentLogger,
      pollIntervalMs: 60_000, // never fires on its own timer in this test
      maxRowsPerTick: 100,
    });
    try {
      await poller.runOnceForTests();
    } finally {
      poller.stop();
    }

    expect(received).toHaveLength(1);
    expect(received[0]).toContain(`event: ${TEST_EVENT_TYPE}`);
    expect(received[0]).toContain("hello-world");
    expect(received[0]).toContain(`id: ${TEST_SOURCE_INDEX}:${insertedId}`);

    expect(await cursorRepo.getLastSequence("dashboard_sse_test_source", "sse_hub")).toBe(insertedId);
  });

  it("multiple sequential rows preserve order across ticks and the watermark advances monotonically", async () => {
    const hub = new SseHub();
    const cursorRepo = createSseCursorRepo(kysely);
    const received: string[] = [];
    const fakeRes = { write: (c: string) => (received.push(c), true), on: () => undefined };
    const handle = hub.register({
      scopes: [STEP_03_TEST_SCOPE],
      initialVector: new Map(),
      res: fakeRes as never,
      maxQueuedFrames: 50,
      retryMs: 1000,
    });
    hub.completeReplay(handle.connectionId);

    const poller = startSsePoller({
      hub,
      cursorRepo,
      logger: silentLogger,
      pollIntervalMs: 60_000,
      maxRowsPerTick: 100,
    });
    try {
      await insertTestRow(rawPool as never, "first");
      await insertTestRow(rawPool as never, "second");
      await insertTestRow(rawPool as never, "third");
      await poller.runOnceForTests();

      expect(received).toHaveLength(3);
      expect(received[0]).toContain("first");
      expect(received[1]).toContain("second");
      expect(received[2]).toContain("third");

      // A second tick with no new rows produces nothing further.
      await poller.runOnceForTests();
      expect(received).toHaveLength(3);
    } finally {
      poller.stop();
    }
  });

  it("restart-safety: a NEW poller instance against the SAME durable DB resumes from the durable watermark, never re-delivering already-seen rows", async () => {
    const hub1 = new SseHub();
    const cursorRepo1 = createSseCursorRepo(kysely);
    const received1: string[] = [];
    const handle1 = hub1.register({
      scopes: [STEP_03_TEST_SCOPE],
      initialVector: new Map(),
      res: { write: (c: string) => (received1.push(c), true), on: () => undefined } as never,
      maxQueuedFrames: 50,
      retryMs: 1000,
    });
    hub1.completeReplay(handle1.connectionId);
    const pollerA = startSsePoller({
      hub: hub1,
      cursorRepo: cursorRepo1,
      logger: silentLogger,
      pollIntervalMs: 60_000,
      maxRowsPerTick: 100,
    });
    await insertTestRow(rawPool as never, "before-restart");
    await pollerA.runOnceForTests();
    pollerA.stop();
    expect(received1).toHaveLength(1);

    // "Restart": brand-new SseHub + poller objects (simulates a new process),
    // same durable DB/cursorRepo state.
    const hub2 = new SseHub();
    const cursorRepo2 = createSseCursorRepo(kysely);
    const received2: string[] = [];
    const handle2 = hub2.register({
      scopes: [STEP_03_TEST_SCOPE],
      initialVector: new Map(),
      res: { write: (c: string) => (received2.push(c), true), on: () => undefined } as never,
      maxQueuedFrames: 50,
      retryMs: 1000,
    });
    hub2.completeReplay(handle2.connectionId);
    const pollerB = startSsePoller({
      hub: hub2,
      cursorRepo: cursorRepo2,
      logger: silentLogger,
      pollIntervalMs: 60_000,
      maxRowsPerTick: 100,
    });
    await insertTestRow(rawPool as never, "after-restart");
    await pollerB.runOnceForTests();
    pollerB.stop();

    // pollerB never redelivers "before-restart" - only the genuinely new row.
    expect(received2).toHaveLength(1);
    expect(received2[0]).toContain("after-restart");
  });

  it("failure isolation: an unregistered event type on a row is skipped (not fanned out) but the poller still advances past it and processes later rows", async () => {
    const hub = new SseHub();
    const cursorRepo = createSseCursorRepo(kysely);
    const received: string[] = [];
    hub.register({
      scopes: [STEP_03_TEST_SCOPE],
      initialVector: new Map(),
      res: { write: (c: string) => (received.push(c), true), on: () => undefined } as never,
      maxQueuedFrames: 50,
      retryMs: 1000,
    });

    // Deregister the event type AFTER inserting a row that references it -
    // simulates a row whose event type the running process doesn't (yet)
    // recognize (e.g. rolled-back deploy) - mission §43.
    resetRegistryForTests();
    registerSourceAdapter(createTestSourceAdapter(rawPool)); // adapter re-registered, event type intentionally NOT

    const insertedId = await insertTestRow(rawPool as never, "unrecognized");
    const poller = startSsePoller({
      hub,
      cursorRepo,
      logger: silentLogger,
      pollIntervalMs: 60_000,
      maxRowsPerTick: 100,
    });
    try {
      await poller.runOnceForTests();
      expect(received).toHaveLength(0); // never fanned out
      // Cursor still advanced past the poison row (to its real ordinal, not
      // hardcoded to 1 - AUTO_INCREMENT is not reset between tests in this
      // file) - it will never block later rows.
      expect(await cursorRepo.getLastSequence("dashboard_sse_test_source", "sse_hub")).toBe(insertedId);
    } finally {
      poller.stop();
    }
  });

  it("gap detection: oldestAvailableOrdinal reflects rows deleted (simulated retention) below the poller's known window", async () => {
    const id1 = await insertTestRow(rawPool as never, "old-1");
    await insertTestRow(rawPool as never, "old-2");
    const id3 = await insertTestRow(rawPool as never, "still-here");
    await deleteTestRowsUpTo(rawPool as never, id3 - 1); // deletes old-1 and old-2

    const adapter = createTestSourceAdapter(rawPool);
    const oldest = await adapter.oldestAvailableOrdinal();
    expect(oldest).toBe(id3);
    expect(oldest).toBeGreaterThan(id1);
  });

  describe("single-flight scheduling (correctness-review defect 6): overlapping DB ticks must be impossible", () => {
    it("poll interval shorter than adapter latency -> maximum concurrent tick count is 1, row broadcast count is exactly 1 (no duplicate fan-out), cursor advances once, and stop() cleans up with no further ticks", async () => {
      const hub = new SseHub();
      const cursorRepo = createSseCursorRepo(kysely);
      const received: string[] = [];
      const handle = hub.register({
        scopes: [STEP_03_TEST_SCOPE],
        initialVector: new Map(),
        res: { write: (c: string) => (received.push(c), true), on: () => undefined } as never,
        maxQueuedFrames: 50,
        retryMs: 1000,
      });
      hub.completeReplay(handle.connectionId);

      const realAdapter = createTestSourceAdapter(rawPool);
      let concurrentFetches = 0;
      let maxConcurrentFetches = 0;
      let fetchCallCount = 0;
      const ADAPTER_LATENCY_MS = 250;
      const slowAdapter = {
        sourceTable: realAdapter.sourceTable,
        sourceIndex: realAdapter.sourceIndex,
        async fetchSince(since: number, limit: number) {
          fetchCallCount += 1;
          concurrentFetches += 1;
          maxConcurrentFetches = Math.max(maxConcurrentFetches, concurrentFetches);
          try {
            await new Promise((resolve) => setTimeout(resolve, ADAPTER_LATENCY_MS));
            return await realAdapter.fetchSince(since, limit);
          } finally {
            concurrentFetches -= 1;
          }
        },
        oldestAvailableOrdinal: () => realAdapter.oldestAvailableOrdinal(),
      };
      resetRegistryForTests();
      registerEventType({ type: TEST_EVENT_TYPE, schema: testEventDataSchema });
      registerSourceAdapter(slowAdapter);

      const insertedId = await insertTestRow(rawPool as never, "single-flight-probe");

      // A poll interval MUCH shorter than the adapter's own latency - the
      // pre-fix `setInterval` design would have started a new tick every
      // 20ms regardless of whether the previous one's 250ms fetchSince call
      // had even returned yet, producing many overlapping in-flight fetches.
      const poller = startSsePoller({
        hub,
        cursorRepo,
        logger: silentLogger,
        pollIntervalMs: 20,
        maxRowsPerTick: 100,
      });

      try {
        // Real wall-clock wait, long enough for several WOULD-BE overlapping
        // intervals under the old design (many multiples of 20ms), but only
        // ~2-3 real ticks under single-flight scheduling (~270ms apart:
        // 250ms adapter latency + 20ms gap).
        await new Promise((resolve) => setTimeout(resolve, 900));
      } finally {
        poller.stop();
        // Drain any tick that was already in-flight the instant stop() was
        // called (stop() cannot cancel work already in progress) so no
        // dangling async work crosses into the next test.
        for (let i = 0; i < 50 && concurrentFetches > 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }

      expect(maxConcurrentFetches).toBe(1); // never more than one tick's fetchSince in flight at once
      expect(fetchCallCount).toBeGreaterThanOrEqual(1); // the poller genuinely ran
      expect(received).toHaveLength(1); // the single real row was broadcast exactly once, never duplicated by an overlapping tick
      expect(received[0]).toContain("single-flight-probe");
      expect(await cursorRepo.getLastSequence("dashboard_sse_test_source", "sse_hub")).toBe(insertedId);

      // stop() must prevent any FURTHER tick from starting.
      const callCountAtStop = fetchCallCount;
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(fetchCallCount).toBe(callCountAtStop);

      resetRegistryForTests();
    });
  });
});
