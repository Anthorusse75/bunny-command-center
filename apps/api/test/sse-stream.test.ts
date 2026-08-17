/**
 * REAL browser-shaped proof: real Fastify server (`fastify.listen()` on an
 * ephemeral port, not `.inject()`), real HTTP client reading the response
 * stream chunk-by-chunk, real MySQL source table, real poller timer. This is
 * the mission §32/§36 "no fake E2E at the server layer" proof: status,
 * headers, genuine incremental delivery while the connection stays open,
 * heartbeat, event ordering, Last-Event-ID resume/replay, invalid-cursor and
 * replay-gap handling, disconnect cleanup, multi-client isolation, and
 * graceful shutdown.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STEP_03_TEST_SCOPE } from "@bunny-command-center/shared";
import { buildServer } from "../src/server.js";
import type { AppConfig } from "../src/config.js";
import { runUp } from "../migrations/runner.js";
import type { MigratorDbConfig } from "../migrations/config.js";
import { registerEventType, registerSourceAdapter, resetRegistryForTests } from "../src/sse/registry.js";
import type { SourceAdapter, SourceRow } from "../src/sse/types.js";
import {
  TEST_EVENT_TYPE,
  TEST_SOURCE_INDEX,
  createTestSourceAdapter,
  createTestSourceSchema,
  deleteTestRowsUpTo,
  insertTestRow,
  testEventDataSchema,
} from "./helpers/sseTestSource.js";
import { SseTestClient, type ParsedSseFrame } from "./helpers/sseClient.js";
import { testDiscordConfig, testSessionConfig } from "./helpers/testAuthConfig.js";

const ROOT_CONFIG = {
  host: process.env.TEST_MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.TEST_MYSQL_PORT ?? 33070),
  user: "root",
  password: process.env.TEST_MYSQL_ROOT_PASSWORD ?? "devrootpass",
};
const TEST_DB_NAME = "bunny_cc_sse_stream_test";
const REAL_MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function testConfig(dbConfig: MigratorDbConfig, overrides: Partial<AppConfig["sse"]> = {}): AppConfig {
  return {
    port: 0,
    logLevel: "silent",
    appVersion: "0.1.0-scaffold-test",
    db: dbConfig,
    sse: {
      heartbeatSeconds: 1,
      pollIntervalMs: 100,
      maxQueuedFramesPerConnection: 200,
      maxRowsPerSourcePerTick: 500,
      ...overrides,
    },
    discord: testDiscordConfig(),
    session: testSessionConfig(),
  };
}

async function startTestServer(dbConfig: MigratorDbConfig, sseOverrides: Partial<AppConfig["sse"]> = {}) {
  const app = await buildServer(testConfig(dbConfig, sseOverrides));
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;
  return { app, port };
}

/**
 * Wraps a real adapter, injecting an artificial delay into `fetchSince`
 * ONLY when called with the exact `since` value given - used to reliably
 * create the replay<->live race window (correctness-review defect 3's
 * integration test) without slowing down every other `fetchSince` call
 * (the poller's own periodic ticks use a different, advancing `since` value
 * and are unaffected).
 */
function delayFetchSinceOnce(inner: SourceAdapter, since: number, delayMs: number): SourceAdapter {
  return {
    sourceTable: inner.sourceTable,
    sourceIndex: inner.sourceIndex,
    async fetchSince(sinceOrdinal: number, limit: number): Promise<SourceRow[]> {
      if (sinceOrdinal === since) {
        await sleep(delayMs);
      }
      return inner.fetchSince(sinceOrdinal, limit);
    },
    oldestAvailableOrdinal: () => inner.oldestAvailableOrdinal(),
  };
}

/** An adapter whose `fetchSince` always throws - proves defect 4's replay-failure-must-fail-safe behavior without needing a real DB-level fault. `oldestAvailableOrdinal` still answers normally so the gap-check ahead of the throwing call behaves like a healthy source. */
function throwingFetchSinceAdapter(inner: SourceAdapter): SourceAdapter {
  return {
    sourceTable: inner.sourceTable,
    sourceIndex: inner.sourceIndex,
    fetchSince(): Promise<SourceRow[]> {
      return Promise.reject(
        new Error("simulated adapter failure during replay (correctness-review defect 4 test)"),
      );
    },
    oldestAvailableOrdinal: () => inner.oldestAvailableOrdinal(),
  };
}

/**
 * Wraps a real adapter so its `fetchSince` silently withholds any row past
 * `maxOrdinalInclusive` - simulates a source that unexpectedly has LESS
 * history available than a previously-snapshotted target implied (e.g.
 * concurrent retention pruning racing a resuming connection's replay).
 * Proves `replaySourceToTarget`'s completion contract (correctness-review
 * round 2): the caller must detect this short-of-target outcome itself,
 * never infer completeness merely because the call didn't throw.
 */
function truncatingFetchSinceAdapter(inner: SourceAdapter, maxOrdinalInclusive: number): SourceAdapter {
  return {
    sourceTable: inner.sourceTable,
    sourceIndex: inner.sourceIndex,
    async fetchSince(sinceOrdinal: number, limit: number): Promise<SourceRow[]> {
      const rows = await inner.fetchSince(sinceOrdinal, limit);
      return rows.filter((row) => row.ordinal <= maxOrdinalInclusive);
    },
    oldestAvailableOrdinal: () => inner.oldestAvailableOrdinal(),
  };
}

/**
 * Wraps a real adapter so `fetchSince` NEVER reports anything past
 * `stuckAtOrdinal`, regardless of the requested `since` - a genuine adapter
 * contract violation (real rows exist above the caller's cursor, but this
 * adapter repeatedly reports the same non-advancing tail). Proves
 * `replaySourceToTarget` fails safe (breaks out of its loop after one
 * non-advancing page) rather than spinning forever re-fetching the same
 * window (correctness-review round 2).
 */
function noProgressFetchSinceAdapter(inner: SourceAdapter, stuckAtOrdinal: number): SourceAdapter {
  return {
    sourceTable: inner.sourceTable,
    sourceIndex: inner.sourceIndex,
    async fetchSince(_sinceOrdinal: number, limit: number): Promise<SourceRow[]> {
      const rows = await inner.fetchSince(0, limit);
      return rows.filter((row) => row.ordinal <= stuckAtOrdinal);
    },
    oldestAvailableOrdinal: () => inner.oldestAvailableOrdinal(),
  };
}

const businessFrame = (f: ParsedSseFrame): boolean => f.event === TEST_EVENT_TYPE;

describe("GET /api/stream (real Fastify server, real HTTP streaming)", () => {
  let dbConfig: MigratorDbConfig;
  let rawPool: mysql.Pool;

  beforeAll(async () => {
    dbConfig = await freshDatabase();
    rawPool = mysql.createPool({ ...dbConfig });
  });

  afterAll(async () => {
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
    resetRegistryForTests();
  });

  it("status 200, real SSE headers, and a business event arrives while the connection stays open", async () => {
    const { app, port } = await startTestServer(dbConfig);
    try {
      const client = new SseTestClient(port);
      expect(await client.statusCode).toBe(200);
      const headers = await client.headers;
      expect(headers["content-type"]).toContain("text/event-stream");
      expect(headers["cache-control"]).toContain("no-cache");
      expect(headers.connection?.toLowerCase()).toBe("keep-alive");
      expect(headers["x-accel-buffering"]).toBe("no");
      expect(client.isClosed).toBe(false); // still open when headers arrived

      const insertedId = await insertTestRow(rawPool, "live-event");
      const frame = await client.waitForFrame(businessFrame);
      expect(client.isClosed).toBe(false); // still open AFTER receiving data - proves genuine streaming, not a closed-then-replayed response
      expect(frame.data).toContain("live-event");
      expect(frame.id).toBe(`${TEST_SOURCE_INDEX}:${insertedId}`);

      client.destroy();
    } finally {
      await app.close();
    }
  });

  it("heartbeat arrives on its own cadence without being mistaken for a business event", async () => {
    const { app, port } = await startTestServer(dbConfig);
    try {
      const client = new SseTestClient(port);
      await client.statusCode;
      const heartbeat = await client.waitForFrame((f) => f.event === "heartbeat", 3000);
      expect(heartbeat.data).toBe("{}");
      expect(heartbeat.id).toMatch(/^0:\d+$/); // reserved HEARTBEAT_SOURCE_INDEX slot
      client.destroy();
    } finally {
      await app.close();
    }
  });

  it("multiple sequential events preserve source order", async () => {
    const { app, port } = await startTestServer(dbConfig);
    try {
      const client = new SseTestClient(port);
      await client.statusCode;
      await insertTestRow(rawPool, "first");
      await insertTestRow(rawPool, "second");
      await insertTestRow(rawPool, "third");

      await client.waitForFrame((f) => businessFrame(f) && Boolean(f.data?.includes("third")), 3000);
      const businessFrames = client.frames.filter(businessFrame);
      expect(businessFrames.map((f) => f.data)).toEqual([
        JSON.stringify({ label: "first" }),
        JSON.stringify({ label: "second" }),
        JSON.stringify({ label: "third" }),
      ]);
      client.destroy();
    } finally {
      await app.close();
    }
  });

  it("Last-Event-ID resume: reconnecting replays only events missed while disconnected, no duplicates", async () => {
    const { app, port } = await startTestServer(dbConfig);
    try {
      const client1 = new SseTestClient(port);
      await client1.statusCode;
      await insertTestRow(rawPool, "seen-before-disconnect");
      const frame1 = await client1.waitForFrame(businessFrame);
      const lastEventId = frame1.id!;
      client1.destroy();
      await sleep(50);

      await insertTestRow(rawPool, "missed-1");
      await insertTestRow(rawPool, "missed-2");
      // Let the server-side poller advance its durable watermark past both
      // rows even with nobody currently connected (proves the poller keeps
      // consuming the source independent of live subscriber count).
      await sleep(400);

      const client2 = new SseTestClient(port, { lastEventId });
      await client2.statusCode;
      await client2.waitForFrame((f) => businessFrame(f) && Boolean(f.data?.includes("missed-2")), 3000);

      const businessFrames = client2.frames.filter(businessFrame);
      expect(businessFrames.map((f) => f.data)).toEqual([
        JSON.stringify({ label: "missed-1" }),
        JSON.stringify({ label: "missed-2" }),
      ]);
      // The already-seen row must never reappear.
      expect(businessFrames.some((f) => f.data?.includes("seen-before-disconnect"))).toBe(false);

      client2.destroy();
    } finally {
      await app.close();
    }
  });

  it("duplicate reconnect with the SAME Last-Event-ID replays the same (already-known) tail again, never MORE than it - no phantom duplication beyond what's owed", async () => {
    const { app, port } = await startTestServer(dbConfig);
    try {
      const client1 = new SseTestClient(port);
      await client1.statusCode;
      await insertTestRow(rawPool, "anchor");
      const frame1 = await client1.waitForFrame(businessFrame);
      const lastEventId = frame1.id!;
      client1.destroy();
      await sleep(50);

      await insertTestRow(rawPool, "after-anchor");
      await sleep(300);

      const clientA = new SseTestClient(port, { lastEventId });
      await clientA.statusCode;
      await clientA.waitForFrame(businessFrame, 3000);
      clientA.destroy();
      await sleep(50);

      // Reconnect AGAIN with the SAME (now-stale) lastEventId - a real
      // client scenario (e.g. duplicate reconnect race). It must replay
      // exactly "after-anchor" again (idempotent from the source's point of
      // view, mission §12), never anything extra and never a crash.
      const clientB = new SseTestClient(port, { lastEventId });
      await clientB.statusCode;
      await clientB.waitForFrame(businessFrame, 3000);
      const framesB = clientB.frames.filter(businessFrame);
      expect(framesB).toHaveLength(1);
      expect(framesB[0]!.data).toBe(JSON.stringify({ label: "after-anchor" }));
      clientB.destroy();
    } finally {
      await app.close();
    }
  });

  it("malformed Last-Event-ID -> safe resync_required, never a crash or a hang", async () => {
    const { app, port } = await startTestServer(dbConfig);
    try {
      const client = new SseTestClient(port, { lastEventId: "not-a-valid-vector" });
      expect(await client.statusCode).toBe(200); // never rejects the connection outright
      const frame = await client.waitForFrame((f) => f.event === "resync_required", 3000);
      expect(JSON.parse(frame.data!)).toEqual({ scope: STEP_03_TEST_SCOPE, reason: "INVALID_CURSOR" });
      expect(frame.id).toBeUndefined(); // control frame never carries a durable id
      client.destroy();
    } finally {
      await app.close();
    }
  });

  it("cursor EXACTLY caught up with the source (knownOrdinal === currentWatermark) -> safe handling, no replay, no resync", async () => {
    const { app, port } = await startTestServer(dbConfig);
    try {
      const client1 = new SseTestClient(port);
      await client1.statusCode;
      await insertTestRow(rawPool, "only-event");
      const frame1 = await client1.waitForFrame(businessFrame);
      const lastEventId = frame1.id!; // exactly caught up to the current watermark
      client1.destroy();
      await sleep(400); // let the poller settle - nothing new to produce

      const client2 = new SseTestClient(port, { lastEventId });
      await client2.statusCode;
      // Give it a moment: it must NOT emit resync_required and must NOT
      // replay "only-event" again.
      await sleep(300);
      expect(client2.frames.some((f) => f.event === "resync_required")).toBe(false);
      expect(client2.frames.filter(businessFrame)).toHaveLength(0);
      client2.destroy();
    } finally {
      await app.close();
    }
  });

  describe("future cursor: knownOrdinal > currentWatermark (correctness-review defect 5)", () => {
    it("a Last-Event-ID claiming a position AHEAD of the server's own durable watermark triggers resync_required (CURSOR_AHEAD), never silently clamped and treated as caught up", async () => {
      const { app, port } = await startTestServer(dbConfig);
      try {
        const client1 = new SseTestClient(port);
        await client1.statusCode;
        await insertTestRow(rawPool, "real-event");
        const frame1 = await client1.waitForFrame(businessFrame);
        client1.destroy();
        await sleep(400); // let the poller settle, watermark = real-event's ordinal

        // A cursor claiming a position WAY beyond anything the source has
        // ever produced.
        const [sourceIndexStr] = frame1.id!.split(":");
        const futureLastEventId = `${sourceIndexStr}:999999999`;

        const client2 = new SseTestClient(port, { lastEventId: futureLastEventId });
        await client2.statusCode;
        const resync = await client2.waitForFrame((f) => f.event === "resync_required", 3000);
        expect(JSON.parse(resync.data!)).toEqual({ scope: STEP_03_TEST_SCOPE, reason: "CURSOR_AHEAD" });
        expect(client2.frames.filter(businessFrame)).toHaveLength(0); // never replayed anything for an untrusted position
        client2.destroy();
      } finally {
        await app.close();
      }
    });

    it("a future cursor does not permanently poison the client: after resync_required, a FRESH connection with no Last-Event-ID recovers normally and later updates are delivered", async () => {
      const { app, port } = await startTestServer(dbConfig);
      try {
        const client1 = new SseTestClient(port);
        await client1.statusCode;
        await insertTestRow(rawPool, "baseline");
        const frame1 = await client1.waitForFrame(businessFrame);
        client1.destroy();
        await sleep(400);

        const [sourceIndexStr] = frame1.id!.split(":");
        const client2 = new SseTestClient(port, { lastEventId: `${sourceIndexStr}:999999999` });
        await client2.statusCode;
        await client2.waitForFrame((f) => f.event === "resync_required", 3000);
        client2.destroy();
        await sleep(50);

        // A client recovering from CURSOR_AHEAD does a full refetch (REST,
        // out of this file's scope) and opens a brand-new, fresh connection
        // - proving the SERVER remains healthy and continues delivering
        // real updates afterward, not stuck in some poisoned state.
        const client3 = new SseTestClient(port);
        await client3.statusCode;
        await insertTestRow(rawPool, "after-recovery");
        const recovered = await client3.waitForFrame(businessFrame, 3000);
        expect(recovered.data).toContain("after-recovery");
        client3.destroy();
      } finally {
        await app.close();
      }
    });

    it("B: CURSOR_AHEAD self-heals the SAME connection - no frame it subsequently emits ever retains the poisoned component (correctness-review round 2)", async () => {
      // The test above proves the SERVER remains healthy for a brand-new
      // connection after CURSOR_AHEAD. This test proves the stronger,
      // previously-missing invariant: the SAME connection that triggered
      // CURSOR_AHEAD, left open (never destroyed/recreated by this test),
      // recovers on its own - hub.ts's `resetSourceVector` is what makes
      // this possible (without it, `advanceVector`'s monotonic-max
      // semantics would let the poisoned 999999999 value survive in every
      // subsequent id: this connection ever emits, since no real future
      // ordinal will exceed it for a very long time).
      const { app, port } = await startTestServer(dbConfig);
      try {
        const client1 = new SseTestClient(port);
        await client1.statusCode;
        await insertTestRow(rawPool, "baseline");
        const frame1 = await client1.waitForFrame(businessFrame);
        client1.destroy();
        await sleep(400);

        const [sourceIndexStr] = frame1.id!.split(":");
        const client2 = new SseTestClient(port, { lastEventId: `${sourceIndexStr}:999999999` });
        await client2.statusCode;
        await client2.waitForFrame((f) => f.event === "resync_required", 3000);

        // Same connection (client2), kept open - insert a REAL new row and
        // prove the NEXT business frame this connection emits carries the
        // real durable ordinal, never the poisoned 999999999.
        const realId = await insertTestRow(rawPool, "after-cursor-ahead");
        const realFrame = await client2.waitForFrame(businessFrame, 3000);
        const businessComponent = realFrame
          .id!.split(",")
          .find((entry) => entry.startsWith(`${sourceIndexStr}:`));
        expect(businessComponent).toBe(`${sourceIndexStr}:${realId}`);
        expect(businessComponent).not.toContain("999999999");
        client2.destroy();
      } finally {
        await app.close();
      }
    });
  });

  it("replay gap: a Last-Event-ID older than the source's retained history triggers resync_required, never a silent partial replay", async () => {
    const { app, port } = await startTestServer(dbConfig);
    try {
      const client1 = new SseTestClient(port);
      await client1.statusCode;
      await insertTestRow(rawPool, "will-be-pruned-1");
      const frame1 = await client1.waitForFrame(businessFrame);
      const staleLastEventId = frame1.id!;
      client1.destroy();
      await sleep(50);

      // Two MORE rows must exist between the client's known position and
      // the surviving row for a real gap (not just an off-by-one at the
      // boundary): knownOrdinal < oldestAvailable - 1 requires at least one
      // fully-missing row in between.
      await insertTestRow(rawPool, "will-be-pruned-2");
      const survivorId = await insertTestRow(rawPool, "survivor");
      await sleep(300); // let poller advance past all three rows
      // Simulate retention: delete everything except the survivor.
      await deleteTestRowsUpTo(rawPool as never, survivorId - 1);

      const client2 = new SseTestClient(port, { lastEventId: staleLastEventId });
      await client2.statusCode;
      const resync = await client2.waitForFrame((f) => f.event === "resync_required", 3000);
      expect(JSON.parse(resync.data!)).toEqual({ scope: STEP_03_TEST_SCOPE, reason: "REPLAY_GAP" });
      // Must not have silently replayed a partial/incorrect history.
      expect(client2.frames.filter(businessFrame).some((f) => f.data?.includes("will-be-pruned"))).toBe(
        false,
      );
      client2.destroy();
    } finally {
      await app.close();
    }
  });

  it("paginated replay: more missed rows than one page reaches the FULL snapshotted target, never truncating at the first page (correctness-review defect 2)", async () => {
    // page size = 4, and 12 rows are missed while disconnected - requires 3
    // full pages to reach the target the OLD single-fetchSince-call design
    // would have silently truncated after the first 4.
    const { app, port } = await startTestServer(dbConfig, { maxRowsPerSourcePerTick: 4 });
    try {
      const client1 = new SseTestClient(port);
      await client1.statusCode;
      await insertTestRow(rawPool, "anchor");
      const frame1 = await client1.waitForFrame(businessFrame);
      const lastEventId = frame1.id!;
      client1.destroy();
      await sleep(50);

      const labels: string[] = [];
      for (let i = 1; i <= 12; i++) {
        const label = `paged-${i}`;
        labels.push(label);
        await insertTestRow(rawPool, label);
      }
      await sleep(400); // let the poller advance the watermark past all 12

      const client2 = new SseTestClient(port, { lastEventId });
      await client2.statusCode;
      await client2.waitForFrame((f) => businessFrame(f) && f.data?.includes("paged-12") === true, 5000);

      const businessFrames = client2.frames.filter(businessFrame);
      expect(businessFrames.map((f) => f.data)).toEqual(labels.map((label) => JSON.stringify({ label })));
      client2.destroy();
    } finally {
      await app.close();
    }
  });

  describe("replay target completion (correctness-review round 2)", () => {
    it("A: a page that comes back short BEFORE reaching the snapshotted target sends resync_required (REPLAY_GAP), never silently transitions to LIVE as if fully caught up", async () => {
      const { app, port } = await startTestServer(dbConfig, { maxRowsPerSourcePerTick: 100 });
      try {
        const client1 = new SseTestClient(port);
        await client1.statusCode;
        await insertTestRow(rawPool, "anchor");
        const frame1 = await client1.waitForFrame(businessFrame);
        const lastEventId = frame1.id!;
        client1.destroy();
        await sleep(50);

        let lastRealOrdinal = 0;
        for (let i = 1; i <= 5; i++) {
          lastRealOrdinal = await insertTestRow(rawPool, `row-${i}`);
        }
        await sleep(300); // let the poller advance the real durable watermark past all 5

        // Simulate the source unexpectedly having LESS history available
        // than the snapshotted target implies (e.g. concurrent retention
        // pruning mid-replay): the adapter silently withholds the last 2
        // rows, so its own page comes back short of the target even though
        // the target itself was a real, once-valid watermark.
        const cutoff = lastRealOrdinal - 2;
        resetRegistryForTests();
        registerEventType({ type: TEST_EVENT_TYPE, schema: testEventDataSchema });
        registerSourceAdapter(truncatingFetchSinceAdapter(createTestSourceAdapter(rawPool), cutoff));

        const client2 = new SseTestClient(port, { lastEventId });
        await client2.statusCode;
        const resync = await client2.waitForFrame((f) => f.event === "resync_required", 3000);
        expect(JSON.parse(resync.data!)).toEqual({ scope: STEP_03_TEST_SCOPE, reason: "REPLAY_GAP" });
        client2.destroy();
      } finally {
        await app.close();
        resetRegistryForTests();
      }
    });

    it("B: an adapter that makes NO forward progress (contract violation) fails safe - no infinite loop, and resync_required still fires", async () => {
      // Poller ticking is fully manual (huge pollIntervalMs) so the broken
      // adapter below is exercised ONLY by client2's own one-time replay
      // call, never repeatedly re-broadcast by an active poller timer -
      // keeps this test deterministic and free of unrelated noise.
      const { app, port } = await startTestServer(dbConfig, {
        maxRowsPerSourcePerTick: 100,
        pollIntervalMs: 999_999,
      });
      try {
        const hooks = app.sseTestHooks;
        if (!hooks) throw new Error("sseTestHooks not decorated");

        const client1 = new SseTestClient(port);
        await client1.statusCode;
        await insertTestRow(rawPool, "anchor");
        await hooks.poller.runOnceForTests();
        const frame1 = await client1.waitForFrame(businessFrame);
        const lastEventId = frame1.id!;
        const anchorOrdinal = Number(frame1.id!.split(":")[1]);
        client1.destroy();
        await sleep(50);

        await insertTestRow(rawPool, "needs-replay");
        await hooks.poller.runOnceForTests(); // advances the REAL watermark past it - this becomes client2's replay target

        resetRegistryForTests();
        registerEventType({ type: TEST_EVENT_TYPE, schema: testEventDataSchema });
        // Never reports anything past the anchor - real data exists above
        // it (the durable watermark client2 will target), but this adapter
        // repeatedly claims there's nothing more, regardless of `since`.
        registerSourceAdapter(noProgressFetchSinceAdapter(createTestSourceAdapter(rawPool), anchorOrdinal));

        const client2 = new SseTestClient(port, { lastEventId });
        await client2.statusCode;
        // A bounded wait: if replaySourceToTarget looped forever re-fetching
        // the same non-advancing window, this would time out and fail the
        // test rather than hang indefinitely - waitForFrame itself enforces
        // the timeout.
        const resync = await client2.waitForFrame((f) => f.event === "resync_required", 3000);
        expect(JSON.parse(resync.data!)).toEqual({ scope: STEP_03_TEST_SCOPE, reason: "REPLAY_GAP" });
        client2.destroy();
      } finally {
        await app.close();
        resetRegistryForTests();
      }
    });
  });

  it("replay failure: an adapter that throws during replay sends resync_required (REPLAY_FAILED) rather than silently treating the connection as caught up (correctness-review defect 4)", async () => {
    const { app, port } = await startTestServer(dbConfig);
    try {
      const client1 = new SseTestClient(port);
      await client1.statusCode;
      await insertTestRow(rawPool, "anchor");
      const frame1 = await client1.waitForFrame(businessFrame);
      const lastEventId = frame1.id!;
      client1.destroy();
      await sleep(50);

      await insertTestRow(rawPool, "needs-replay");
      await sleep(300); // let the poller advance the real watermark past it

      // Swap the registered adapter for a throwing one (same sourceTable/
      // sourceIndex, so the already-advanced cursor watermark is still
      // found under the same key) - simulates a real adapter fault
      // encountered specifically during a resuming connection's replay.
      resetRegistryForTests();
      registerEventType({ type: TEST_EVENT_TYPE, schema: testEventDataSchema });
      registerSourceAdapter(throwingFetchSinceAdapter(createTestSourceAdapter(rawPool)));

      const client2 = new SseTestClient(port, { lastEventId });
      await client2.statusCode;
      const resync = await client2.waitForFrame((f) => f.event === "resync_required", 3000);
      expect(JSON.parse(resync.data!)).toEqual({ scope: STEP_03_TEST_SCOPE, reason: "REPLAY_FAILED" });
      // Never silently delivered partial/fabricated replay data.
      expect(client2.frames.filter(businessFrame)).toHaveLength(0);
      client2.destroy();
    } finally {
      await app.close();
      // Restore the real adapter for subsequent tests' beforeEach to layer onto cleanly.
      resetRegistryForTests();
    }
  });

  describe("replay <-> live race (correctness-review defect 3)", () => {
    it("a live event broadcast WHILE a resuming connection's replay is still in flight is buffered and delivered AFTER replay finishes, in correct order, no duplicate, no gap", async () => {
      const { app, port } = await startTestServer(dbConfig, { pollIntervalMs: 60, heartbeatSeconds: 0.2 });
      try {
        const client1 = new SseTestClient(port);
        await client1.statusCode;
        await insertTestRow(rawPool, "anchor");
        const anchorFrame = await client1.waitForFrame(businessFrame);
        const lastEventId = anchorFrame.id!;
        const anchorOrdinal = Number(lastEventId.split(":")[1]);
        client1.destroy();
        await sleep(50);

        const missedId = await insertTestRow(rawPool, "missed-before-reconnect");
        await sleep(250); // let the poller advance the watermark to missedId BEFORE client2 connects

        // From this point on, ONLY client2's own replay call (fetchSince
        // with since === anchorOrdinal) is slowed - the poller's own
        // routine ticks (since === missedId, then higher) are unaffected.
        resetRegistryForTests();
        registerEventType({ type: TEST_EVENT_TYPE, schema: testEventDataSchema });
        registerSourceAdapter(delayFetchSinceOnce(createTestSourceAdapter(rawPool), anchorOrdinal, 500));

        const client2 = new SseTestClient(port, { lastEventId });
        await client2.statusCode;

        // While client2's replay `fetchSince(anchorOrdinal, ...)` is still
        // sleeping (500ms), insert a genuinely NEW row. The poller (ticking
        // every 60ms, using `since=missedId` - NOT delayed) will pick this
        // up and broadcast it to every LIVE subscriber. client2 is still
        // REPLAYING at this point (SseHub's phase), so this broadcast must
        // be buffered, not delivered immediately out of order.
        await sleep(100);
        const liveId = await insertTestRow(rawPool, "live-during-replay");
        await sleep(200); // give the poller at least one more tick to broadcast it while client2 is still replaying

        // Now wait for replay to finish AND the buffered live event to flush.
        await client2.waitForFrame(
          (f) => businessFrame(f) && f.data?.includes("live-during-replay") === true,
          3000,
        );

        const businessFrames = client2.frames.filter(businessFrame);
        expect(businessFrames.map((f) => f.data)).toEqual([
          JSON.stringify({ label: "missed-before-reconnect" }),
          JSON.stringify({ label: "live-during-replay" }),
        ]);
        // Correct, monotonically increasing per-source ids - proves the
        // resulting Last-Event-ID represents exactly what was delivered,
        // never a jump-then-inversion. The id STRING may also carry the
        // reserved heartbeat source's own component (sourceIndex 0 - a
        // heartbeat can legitimately interleave, see the assertion below),
        // so this checks the business source's OWN entry within the vector
        // rather than asserting the whole string verbatim.
        const businessComponent = (id: string): string | undefined =>
          id.split(",").find((entry) => entry.startsWith(`${TEST_SOURCE_INDEX}:`));
        expect(businessComponent(businessFrames[0]!.id!)).toBe(`${TEST_SOURCE_INDEX}:${missedId}`);
        expect(businessComponent(businessFrames[1]!.id!)).toBe(`${TEST_SOURCE_INDEX}:${liveId}`);

        // A different, independent "source" (the reserved heartbeat slot,
        // sourceIndex 0) is entirely unaffected by the buffering applied to
        // the business source above - heartbeats keep flowing the whole
        // time via the connection's own direct sendEvent path, never
        // buffered (SseHub's class doc comment).
        expect(client2.frames.some((f) => f.event === "heartbeat")).toBe(true);

        client2.destroy();
      } finally {
        await app.close();
        resetRegistryForTests();
      }
    });
  });

  describe("pre-snapshot replay/bridge duplication window (correctness-review round 2)", () => {
    it("a row that is broadcast AND durably advances the watermark BEFORE the resuming connection's own target snapshot is captured is delivered exactly once, not duplicated by the bridge flush", async () => {
      // The replay <-> live race suite above covers a live broadcast
      // happening AFTER the target snapshot (correctly excluded from replay,
      // delivered once via the bridge). This test covers the OTHER side of
      // the same boundary: a broadcast (and durable cursor advance)
      // happening BEFORE the snapshot is even taken - the bridge buffer
      // already has the row (broadcast while this connection was still
      // REPLAYING), and `replaySourceToTarget` ALSO ends up delivering it
      // directly (because the watermark it snapshots already includes it).
      // Without hub.ts's `completeReplay` dedup fix, this would double-
      // deliver the same durable row.
      //
      // Poller ticking is fully manual here (`runOnceForTests`, a huge
      // `pollIntervalMs` so the real timer never fires on its own) so the
      // only `cursorRepo.getLastSequence` call affected by the artificial
      // delay below is client2's OWN replay snapshot read, never a poller
      // tick this test doesn't explicitly trigger.
      const { app, port } = await startTestServer(dbConfig, {
        pollIntervalMs: 999_999,
        heartbeatSeconds: 999_999,
      });
      try {
        const hooks = app.sseTestHooks;
        if (!hooks) throw new Error("sseTestHooks not decorated");

        const client1 = new SseTestClient(port);
        await client1.statusCode;
        await insertTestRow(rawPool, "anchor");
        await hooks.poller.runOnceForTests();
        const anchorFrame = await client1.waitForFrame(businessFrame);
        const lastEventId = anchorFrame.id!;
        client1.destroy();
        await sleep(50);

        // Captured via `.bind()` so this holds the CURRENT function value
        // immediately - a lazy arrow re-reading `hooks.cursorRepo.getLastSequence`
        // at call time would instead observe the PATCHED version below (the
        // reassignment happens synchronously, before any async call), causing
        // infinite self-recursion instead of delegating to the real
        // implementation.
        const originalGetLastSequence = hooks.cursorRepo.getLastSequence.bind(hooks.cursorRepo);
        hooks.cursorRepo.getLastSequence = async (sourceTable: string, cursorKey: string) => {
          await sleep(300);
          return originalGetLastSequence(sourceTable, cursorKey);
        };

        const client2 = new SseTestClient(port, { lastEventId });
        await client2.statusCode; // registration is synchronous; replayOrResync starts async and is now sleeping inside the (patched) snapshot read

        // While client2's snapshot read is still sleeping, a NEW row is
        // inserted and the poller is ticked manually - this broadcasts the
        // row (buffered, since client2 is still REPLAYING) AND durably
        // advances the watermark past it, all before client2's delayed
        // snapshot read actually executes.
        const preSnapshotId = await insertTestRow(rawPool, "pre-snapshot-race-row");
        await hooks.poller.runOnceForTests();

        const delivered = await client2.waitForFrame(
          (f) => businessFrame(f) && f.data?.includes("pre-snapshot-race-row") === true,
          3000,
        );

        const matching = client2.frames.filter(
          (f) => businessFrame(f) && f.data?.includes("pre-snapshot-race-row"),
        );
        expect(matching).toHaveLength(1); // exactly once, never duplicated

        const businessComponent = delivered
          .id!.split(",")
          .find((entry) => entry.startsWith(`${TEST_SOURCE_INDEX}:`));
        expect(businessComponent).toBe(`${TEST_SOURCE_INDEX}:${preSnapshotId}`);

        hooks.cursorRepo.getLastSequence = originalGetLastSequence;
        client2.destroy();
      } finally {
        await app.close();
      }
    });
  });

  describe("broadcast-before-durable-advance window (reconnect race, D.RESUME CI investigation)", () => {
    it("a row broadcast by the poller BEFORE a reconnecting client registers, whose durable watermark advance is still in flight when that client snapshots its replay target, is still delivered exactly once - never permanently lost", async () => {
      // Root-caused from a real, reproducible CI flake on
      // apps/web/e2e/realtime.spec.ts's "D. RESUME" test: two rows inserted
      // back-to-back while disconnected, only the SECOND one ever arrived.
      // poller.ts's tick body calls `hub.broadcast()` for each row (which
      // only reaches connections ALREADY registered) and only AFTERWARD
      // durably records `dashboard_sse_cursor` via `cursorRepo.advance()`.
      // A client reconnecting in the gap between those two steps registers
      // too late for that tick's broadcast AND reads a replay-target
      // watermark that doesn't include the row yet either - a genuine loss,
      // not a duplicate (the already-tested "pre-snapshot" race above is the
      // mirror-image, later-arriving side of this exact same boundary).
      //
      // `advance` is patched (not `getLastSequence`, unlike the dup test
      // above) to artificially widen this specific gap: firing the tick
      // WITHOUT awaiting it reaches the synchronous `broadcast()` calls
      // (after `fetchSince` resolves) and then blocks inside the now-slow
      // `advance()` - reconnecting client2 during that block reproduces the
      // exact real-world interleaving deterministically instead of hoping a
      // real ~ms-scale race lines up.
      const { app, port } = await startTestServer(dbConfig, {
        pollIntervalMs: 999_999,
        heartbeatSeconds: 999_999,
      });
      try {
        const hooks = app.sseTestHooks;
        if (!hooks) throw new Error("sseTestHooks not decorated");

        const client1 = new SseTestClient(port);
        await client1.statusCode;
        await insertTestRow(rawPool, "anchor");
        await hooks.poller.runOnceForTests();
        const anchorFrame = await client1.waitForFrame(businessFrame);
        const lastEventId = anchorFrame.id!;
        client1.destroy();
        await sleep(50);

        const originalAdvance = hooks.cursorRepo.advance.bind(hooks.cursorRepo);
        hooks.cursorRepo.advance = async (sourceTable: string, cursorKey: string, newSequence: number) => {
          await sleep(300);
          return originalAdvance(sourceTable, cursorKey, newSequence);
        };

        const gapRowId = await insertTestRow(rawPool, "gap-row");
        // Fire-and-forget: broadcasts "gap-row" synchronously once
        // `fetchSince` resolves, then blocks inside the patched `advance`.
        void hooks.poller.runOnceForTests();
        // Long enough to be well past the synchronous broadcast, well short
        // of the 300ms `advance` delay - client2 registers and takes its
        // own replay-target snapshot squarely inside the gap.
        await sleep(50);

        const client2 = new SseTestClient(port, { lastEventId });
        await client2.statusCode;

        const delivered = await client2.waitForFrame(
          (f) => businessFrame(f) && f.data?.includes("gap-row") === true,
          3000,
        );

        const matching = client2.frames.filter((f) => businessFrame(f) && f.data?.includes("gap-row"));
        expect(matching).toHaveLength(1); // exactly once - never lost, never duplicated

        const businessComponent = delivered
          .id!.split(",")
          .find((entry) => entry.startsWith(`${TEST_SOURCE_INDEX}:`));
        expect(businessComponent).toBe(`${TEST_SOURCE_INDEX}:${gapRowId}`);

        hooks.cursorRepo.advance = originalAdvance;
        client2.destroy();
      } finally {
        await app.close();
      }
    });
  });

  it("disconnect cleans up server resources: activeConnectionCount returns to 0", async () => {
    const { app, port } = await startTestServer(dbConfig);
    try {
      const client = new SseTestClient(port);
      await client.statusCode;
      await sleep(50);
      expect(app.sseTestHooks?.hub.activeConnectionCount).toBe(1);

      client.destroy();

      // Poll briefly for the server-side close handler to run (async socket teardown).
      for (let i = 0; i < 20 && app.sseTestHooks?.hub.activeConnectionCount !== 0; i++) {
        await sleep(50);
      }
      expect(app.sseTestHooks?.hub.activeConnectionCount).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("multi-client isolation: one client's disconnect does not affect another client's stream", async () => {
    const { app, port } = await startTestServer(dbConfig);
    try {
      const clientA = new SseTestClient(port);
      const clientB = new SseTestClient(port);
      await Promise.all([clientA.statusCode, clientB.statusCode]);
      await sleep(50);

      await insertTestRow(rawPool, "seen-by-both");
      await Promise.all([clientA.waitForFrame(businessFrame), clientB.waitForFrame(businessFrame)]);

      clientA.destroy();
      await sleep(100);

      await insertTestRow(rawPool, "seen-by-b-only");
      await clientB.waitForFrame(
        (f) => businessFrame(f) && Boolean(f.data?.includes("seen-by-b-only")),
        3000,
      );

      expect(clientB.frames.filter(businessFrame)).toHaveLength(2);
      clientB.destroy();
    } finally {
      await app.close();
    }
  });

  it("server shutdown closes SSE streams gracefully, not with a bare drop", async () => {
    const { app, port } = await startTestServer(dbConfig);
    const client = new SseTestClient(port);
    await client.statusCode;
    await sleep(50);

    await app.close();

    for (let i = 0; i < 20 && !client.isClosed; i++) {
      await sleep(50);
    }
    expect(client.isClosed).toBe(true);
    expect(client.frames.some((f) => f.event === "server_shutdown")).toBe(true);
  });

  describe("backpressure overflow recovery (correctness-review defect 1, tests C/D)", () => {
    it("test C: once a connection's bounded queue overflows (proven for real at the unit level, sse-hub.test.ts), reconnecting from the last id it ACTUALLY received recovers every missed row exactly once, in order", async () => {
      // The overflow MECHANISM itself (BackpressureWriter's bound -> abrupt
      // termination, never a silent drop-and-continue) is already proven
      // directly and deterministically against the real BackpressureWriter
      // class in sse-hub.test.ts's "backpressure overflow terminates the
      // connection" suite (tests A/B/E). Genuinely inducing that same
      // overflow here via real OS/Node socket buffering was tried first and
      // found to be non-deterministic in practice (observed wall-clock time
      // to overflow varied from ~1s to 18s+ across runs, and the CLIENT
      // side's own close-event timing didn't reliably keep pace either) -
      // exactly the kind of flaky real-timing dependency the correctness
      // review itself warns against weakening tests to route around. So
      // this test uses the SAME test-only-hook pattern already established
      // (and already accepted) for native-reconnect proof
      // (`simulateNetworkDropForTests`): a deterministic trigger for the
      // precondition, then a fully REAL reconnect + REAL paginated replay
      // for the property actually under test - recovery correctness.
      const { app, port } = await startTestServer(dbConfig, { maxRowsPerSourcePerTick: 50 });
      try {
        const client1 = new SseTestClient(port);
        await client1.statusCode;
        await insertTestRow(rawPool, "anchor");
        const anchorFrame = await client1.waitForFrame(businessFrame);
        // The anchor was written DIRECTLY (the very first frame on this
        // connection) - this is the position client1 can, for certain,
        // actually claim as received.
        const lastEventId = anchorFrame.id!;

        app.sseTestHooks?.hub.simulateBackpressureOverflowForTests(STEP_03_TEST_SCOPE);
        for (let i = 0; i < 50 && app.sseTestHooks?.hub.activeConnectionCount !== 0; i++) {
          await sleep(50);
        }
        expect(app.sseTestHooks?.hub.activeConnectionCount).toBe(0);

        // More rows than one replay page (50) were missed while the
        // connection was gone - exercises pagination (defect 2) and
        // overflow-recovery (defect 1) together.
        const BURST_SIZE = 120;
        const labels: string[] = [];
        for (let i = 0; i < BURST_SIZE; i++) {
          const label = `burst-${i}`;
          labels.push(label);
          await insertTestRow(rawPool, label);
        }
        await sleep(400); // let the poller advance the watermark past the whole burst

        // Reconnect from the LAST id client1 can actually claim (the
        // anchor) - normal Last-Event-ID replay must recover the ENTIRE
        // burst, exactly once, in order. No event the overflow "swallowed"
        // was ever silently skipped by a later id.
        const client2 = new SseTestClient(port, { lastEventId });
        await client2.statusCode;
        await client2.waitForFrame(
          (f) => businessFrame(f) && f.data?.includes(`burst-${BURST_SIZE - 1}`) === true,
          5000,
        );

        const businessFrames = client2.frames.filter(businessFrame);
        expect(businessFrames.map((f) => f.data)).toEqual(labels.map((label) => JSON.stringify({ label })));
        client2.destroy();
      } finally {
        await app.close();
      }
    });

    // test D ("if replay is outside retention, full resync occurs instead")
    // is mechanistically the SAME "replay gap -> resync_required" path
    // already proven by the "replay gap" test above, against a REAL
    // disconnected connection - the server has no way to distinguish "this
    // connection ended because of a backpressure overflow" from "this
    // connection ended for any other reason" by the time a NEW connection
    // reconnects with a Last-Event-ID: both are just "a stale cursor,
    // resume from here". Re-deriving an entire second real-burst-overflow
    // scenario here would exercise no code path the "replay gap" test
    // doesn't already cover.
  });

  // ==================================================================
  // Last-Event-ID precedence: standard HEADER (Case A - native
  // EventSource reconnect) vs `?lastEventId=` QUERY (Case B - a brand-new
  // EventSource bootstrapped by application code, e.g. after the polling
  // fallback or this layer's own fatal-retry recreation - the native
  // EventSource constructor has no way to set a custom request header, so
  // it cannot use Case A at all). apps/api/src/sse/route.ts's own header
  // comment documents the same seven cases exhaustively; this suite is the
  // executable proof for each one, against a REAL server and REAL MySQL.
  // ==================================================================
  describe("Last-Event-ID precedence: header vs ?lastEventId= query", () => {
    /** Connects, waits for one real business event, and returns its exact wire id plus the id of a SECOND event inserted afterward while this client is disconnected. */
    async function primeAnchorAndFollowUp(
      app: Awaited<ReturnType<typeof startTestServer>>["app"],
      port: number,
    ): Promise<{ anchorId: string; followUpLabel: string; currentWatermarkAheadId: string }> {
      const primer = new SseTestClient(port);
      await primer.statusCode;
      await insertTestRow(rawPool, "precedence-anchor");
      const anchorFrame = await primer.waitForFrame(businessFrame);
      const anchorId = anchorFrame.id!;
      primer.destroy();
      await sleep(50);

      const followUpLabel = "precedence-followup";
      await insertTestRow(rawPool, followUpLabel);
      await sleep(300); // let the poller advance its durable watermark

      // A cursor claiming to be far AHEAD of anything the source has ever
      // produced - "caught up, nothing to replay" - deliberately distinct
      // from `anchorId` so a test can tell, from the OBSERVABLE replay
      // behavior alone, which of the two candidate cursors the server
      // actually used (real behavioral proof, not an internal inspection).
      const currentWatermarkAheadId = `${TEST_SOURCE_INDEX}:999999999`;
      void app; // kept for signature symmetry / future use
      return { anchorId, followUpLabel, currentWatermarkAheadId };
    }

    it("1. HEADER ONLY: a valid standard Last-Event-ID header resumes replay from that position", async () => {
      const { app, port } = await startTestServer(dbConfig);
      try {
        const { anchorId, followUpLabel } = await primeAnchorAndFollowUp(app, port);
        const client = new SseTestClient(port, { lastEventId: anchorId });
        await client.statusCode;
        await client.waitForFrame((f) => businessFrame(f) && f.data?.includes(followUpLabel) === true, 3000);
        expect(client.frames.filter(businessFrame)).toHaveLength(1);
        client.destroy();
      } finally {
        await app.close();
      }
    });

    it("2. QUERY ONLY: a valid ?lastEventId= query parameter resumes replay when no header is sent (Case B bootstrap)", async () => {
      const { app, port } = await startTestServer(dbConfig);
      try {
        const { anchorId, followUpLabel } = await primeAnchorAndFollowUp(app, port);
        const client = new SseTestClient(port, {
          path: `/api/stream?lastEventId=${encodeURIComponent(anchorId)}`,
        });
        await client.statusCode;
        await client.waitForFrame((f) => businessFrame(f) && f.data?.includes(followUpLabel) === true, 3000);
        expect(client.frames.filter(businessFrame)).toHaveLength(1);
        client.destroy();
      } finally {
        await app.close();
      }
    });

    it("3. BOTH SAME: header and query carrying the identical valid cursor behave exactly like either alone", async () => {
      const { app, port } = await startTestServer(dbConfig);
      try {
        const { anchorId, followUpLabel } = await primeAnchorAndFollowUp(app, port);
        const client = new SseTestClient(port, {
          lastEventId: anchorId,
          path: `/api/stream?lastEventId=${encodeURIComponent(anchorId)}`,
        });
        await client.statusCode;
        await client.waitForFrame((f) => businessFrame(f) && f.data?.includes(followUpLabel) === true, 3000);
        expect(client.frames.filter(businessFrame)).toHaveLength(1);
        client.destroy();
      } finally {
        await app.close();
      }
    });

    it("4. BOTH DIFFERENT: the header ALWAYS wins over a conflicting query value, never merged, never overridden", async () => {
      const { app, port } = await startTestServer(dbConfig);
      try {
        const { anchorId, followUpLabel, currentWatermarkAheadId } = await primeAnchorAndFollowUp(app, port);
        // Header says "replay from the anchor" (real, correct usage);
        // query says "I'm already caught up" (would silently swallow the
        // follow-up event if it won). If the header truly takes
        // precedence, the follow-up event MUST still arrive.
        const client = new SseTestClient(port, {
          lastEventId: anchorId,
          path: `/api/stream?lastEventId=${encodeURIComponent(currentWatermarkAheadId)}`,
        });
        await client.statusCode;
        await client.waitForFrame((f) => businessFrame(f) && f.data?.includes(followUpLabel) === true, 3000);
        expect(client.frames.filter(businessFrame)).toHaveLength(1);
        client.destroy();
      } finally {
        await app.close();
      }
    });

    it("5. MALFORMED HEADER (no query): never falls through to guessing - safe resync_required, no replay", async () => {
      const { app, port } = await startTestServer(dbConfig);
      try {
        await primeAnchorAndFollowUp(app, port);
        const client = new SseTestClient(port, { lastEventId: "not-a-valid-cursor" });
        expect(await client.statusCode).toBe(200);
        const resync = await client.waitForFrame((f) => f.event === "resync_required", 3000);
        expect(JSON.parse(resync.data!)).toMatchObject({ reason: "INVALID_CURSOR" });
        expect(client.frames.filter(businessFrame)).toHaveLength(0);
        client.destroy();
      } finally {
        await app.close();
      }
    });

    it("5b. MALFORMED HEADER + a VALID query present: the malformed header still wins (never silently falls back to the query)", async () => {
      const { app, port } = await startTestServer(dbConfig);
      try {
        const { anchorId } = await primeAnchorAndFollowUp(app, port);
        const client = new SseTestClient(port, {
          lastEventId: "not-a-valid-cursor",
          path: `/api/stream?lastEventId=${encodeURIComponent(anchorId)}`,
        });
        expect(await client.statusCode).toBe(200);
        const resync = await client.waitForFrame((f) => f.event === "resync_required", 3000);
        expect(JSON.parse(resync.data!)).toMatchObject({ reason: "INVALID_CURSOR" });
        // Never silently replayed using the query value instead.
        expect(client.frames.filter(businessFrame)).toHaveLength(0);
        client.destroy();
      } finally {
        await app.close();
      }
    });

    it("6. MALFORMED QUERY (no header): resolved as the fallback source, fails the same safe way", async () => {
      const { app, port } = await startTestServer(dbConfig);
      try {
        await primeAnchorAndFollowUp(app, port);
        const client = new SseTestClient(port, { path: "/api/stream?lastEventId=garbage-not-a-cursor" });
        expect(await client.statusCode).toBe(200);
        const resync = await client.waitForFrame((f) => f.event === "resync_required", 3000);
        expect(JSON.parse(resync.data!)).toMatchObject({ reason: "INVALID_CURSOR" });
        expect(client.frames.filter(businessFrame)).toHaveLength(0);
        client.destroy();
      } finally {
        await app.close();
      }
    });

    it("7. NEITHER: a fresh connection with no header and no query is live-only, no resync, no replay", async () => {
      const { app, port } = await startTestServer(dbConfig);
      try {
        await primeAnchorAndFollowUp(app, port);
        const client = new SseTestClient(port);
        await client.statusCode;
        await sleep(300);
        expect(client.frames.some((f) => f.event === "resync_required")).toBe(false);
        expect(client.frames.filter(businessFrame)).toHaveLength(0);
        client.destroy();
      } finally {
        await app.close();
      }
    });
  });
});
