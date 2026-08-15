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

function testConfig(dbConfig: MigratorDbConfig): AppConfig {
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
    },
  };
}

async function startTestServer(dbConfig: MigratorDbConfig) {
  const app = await buildServer(testConfig(dbConfig));
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;
  return { app, port };
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

  it("cursor ahead of / caught up with the source -> safe handling, no replay, no resync", async () => {
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
});
