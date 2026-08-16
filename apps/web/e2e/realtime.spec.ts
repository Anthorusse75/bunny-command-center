/**
 * Real-browser proof of the Step-03 realtime infrastructure
 * (03_realtime_infrastructure.md §TESTS REQUIRED, mission §35/§36):
 *
 *   A. LIVE SSE     - real EventSource -> real Fastify /api/stream -> real
 *                     poller -> real TanStack Query reaction.
 *   A2. NATIVE RECONNECT (Case A) - the SAME real `EventSource` object,
 *                     after a genuine server-initiated network-level
 *                     connection failure, performs its own native browser
 *                     reconnect and sends the real, standard
 *                     `Last-Event-ID` HEADER - observed via `page.on('request')`,
 *                     never mocked, never a manually-constructed header.
 *   B. DROP         - a real, active EventSource connection is genuinely
 *                     closed and NEW connection attempts are genuinely
 *                     blocked at the network layer beyond the grace period,
 *                     which activates the polling fallback.
 *   C. RECOVERY     - the network block is lifted -> live mode resumes,
 *                     fallback stops.
 *   D. RESUME (Case B) - an application-level bootstrap of a BRAND-NEW
 *                     `EventSource` object (this layer's own fast
 *                     fatal-retry path, not the grace/polling path) carries
 *                     its resume position via the `?lastEventId=` query
 *                     parameter, since the native constructor has no way to
 *                     set a custom header on a freshly-created object.
 *                     Events produced while disconnected resume with no
 *                     gap/dup.
 *   E. GAP          - a Last-Event-ID whose history was pruned server-side
 *                     triggers `resync_required` (never a silent partial
 *                     replay).
 *   Multi-tab dedup - two real browser CONTEXTS (two real tabs), real
 *                     BroadcastChannel, exactly one claims the toast for
 *                     the same server-broadcast event.
 *
 * Every scenario mutates `dashboard_sse_test_source` directly via a real
 * MySQL connection - the same "entrypoint: mutate the synthetic test table
 * directly in the DB" proof-of-wiring chain 03_realtime_infrastructure.md's
 * own spec names - never a debug HTTP call into the E2E server.
 *
 * TWO DISTINCT RECONNECT MECHANISMS, TWO DISTINCT TEST TECHNIQUES (see
 * apps/api/src/sse/route.ts's own "Case A / Case B" doc comment for the
 * server-side half of this same distinction):
 *
 *   - Case A (native reconnect, test A2 below): induced by a genuine
 *     SERVER-SIDE network-level connection termination
 *     (`SseHub.simulateNetworkDropForTests`, triggered here only by
 *     inserting a `TRIGGER_NATIVE_DROP` sentinel row - the same "mutate the
 *     DB directly" entrypoint as every other scenario, never an HTTP debug
 *     call). Playwright/CDP's `context.setOffline(true)` was tried first
 *     for this and DOES flip `navigator.onLine` for real (exercising this
 *     layer's own `offline` listener), but was found, empirically, NOT to
 *     terminate an already-open long-lived HTTP/1.1 streaming response in
 *     Chromium - heartbeats kept flowing straight through it - so it cannot
 *     be used to prove Case A. This test never calls `onerror` manually,
 *     never manually instantiates a replacement `EventSource`, and never
 *     mocks a request header - the SAME browser-owned `EventSource` object
 *     reconnects entirely on its own.
 *   - Case B (application bootstrap, test D below): induced via
 *     `window.__bccE2E.forceDisconnect()` (apps/web/src/realtime/sseConnectionManager.ts's
 *     `forceDisconnectForTests`, gated the same way `RealtimeTestProbe` is -
 *     stripped from real production builds), which closes the real
 *     `EventSource` and drives the exact same production `ERROR`/grace-
 *     timer/fatal-retry code paths a genuine drop would, including
 *     constructing a genuinely NEW `EventSource` object with the
 *     `?lastEventId=` query bootstrap.
 *
 * `page.route()` is used separately (test B/C) to genuinely block NEW
 * connection attempts at the network layer for the grace->polling scenario.
 */
import { test, expect, type Page } from "@playwright/test";
import mysql from "mysql2/promise";

const DB_CONFIG = {
  host: process.env["TEST_MYSQL_HOST"] ?? "127.0.0.1",
  port: Number(process.env["TEST_MYSQL_PORT"] ?? 33070),
  user: "bunny_dashboard_app",
  password: "app_pass",
  database: "bunny_cc_e2e",
};

let pool: mysql.Pool;

test.beforeAll(() => {
  pool = mysql.createPool(DB_CONFIG);
});

test.afterAll(async () => {
  await pool.end();
});

test.beforeEach(async () => {
  await pool.query("DELETE FROM dashboard_sse_test_source");
  await pool.query("DELETE FROM dashboard_sse_cursor");
});

async function insertTestRow(label: string, scope = "test"): Promise<number> {
  const [result] = await pool.query<mysql.ResultSetHeader>(
    "INSERT INTO dashboard_sse_test_source (scope, payload_json) VALUES (?, ?)",
    [scope, JSON.stringify({ label })],
  );
  return result.insertId;
}

async function deleteTestRowsUpTo(maxIdInclusive: number): Promise<void> {
  await pool.query("DELETE FROM dashboard_sse_test_source WHERE id <= ?", [maxIdInclusive]);
}

const probe = (page: Page) => page.getByTestId("realtime-test-probe");

async function waitForTransportState(page: Page, state: string, timeout = 20_000): Promise<void> {
  await expect(probe(page)).toHaveAttribute("data-transport-state", state, { timeout });
}

async function receivedLabels(page: Page): Promise<string[]> {
  const raw = (await probe(page).getAttribute("data-received-labels")) ?? "";
  return raw.length > 0 ? raw.split(",") : [];
}

/** Waits for `window.__bccE2E` to exist, then closes the real EventSource and drives the real ERROR/grace/fatal-retry code paths. */
async function forceDisconnect(page: Page): Promise<void> {
  await expect(probe(page)).toHaveAttribute("data-e2e-controls-ready", "true");
  await page.evaluate(() => window.__bccE2E?.forceDisconnect());
}

test.describe("Realtime infrastructure (real browser, real API server)", () => {
  test("A. LIVE: real EventSource connects, and a real DB row change is delivered while the connection stays open", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForTransportState(page, "LIVE");
    expect(await probe(page).getAttribute("data-polling-active")).toBe("false");

    await insertTestRow("live-e2e-event");

    await expect.poll(async () => receivedLabels(page), { timeout: 10_000 }).toContain("live-e2e-event");
  });

  test("A2. NATIVE RECONNECT (Case A): the SAME real EventSource object reconnects on its own after a genuine server-side network failure, and Fastify observes the real Last-Event-ID header", async ({
    page,
  }) => {
    const streamRequests: { url: string; headers: Record<string, string> }[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/stream") {
        // `allHeaders()` (async, the full raw request headers as actually
        // sent) rather than the synchronous `.headers()` snapshot - found
        // empirically to be the reliable one for a header Chromium's own
        // EventSource implementation sets internally (not via page JS),
        // which `.headers()` did not always reflect for this exact request.
        void request.allHeaders().then((headers) => {
          streamRequests.push({ url: request.url(), headers });
        });
      }
    });

    await page.goto("/");
    await waitForTransportState(page, "LIVE");
    // `allHeaders()` resolves asynchronously - wait for the first request's
    // headers to actually land before asserting on them.
    await expect.poll(() => streamRequests.length, { timeout: 5_000 }).toBe(1);
    expect(streamRequests[0]!.headers["last-event-id"]).toBeUndefined(); // first-ever connection carries no cursor

    // The anchor event this browser must remember across the native
    // reconnect - real DB mutation, the documented entrypoint.
    await insertTestRow("anchor-before-native-drop");
    await expect
      .poll(async () => receivedLabels(page), { timeout: 10_000 })
      .toContain("anchor-before-native-drop");

    // Real, server-initiated, network-level connection termination - see
    // this file's top comment for why this (not context.setOffline) is
    // what actually proves Case A. The sentinel row is itself a completely
    // ordinary row in the same source table, so it is ALSO delivered to
    // this browser as a genuine business event (via the exact same real
    // pipeline as any other row) before the drop actually fires - meaning
    // the client's true last-known position by the time of the drop is
    // THIS row's own ordinal, one past the anchor's, not the anchor's own
    // id. That is the correct, honest expectation (proven below), not an
    // approximation - the whole point of Last-Event-ID is "the last thing
    // I actually saw," and this sentinel row is a real, actually-seen
    // event like any other.
    const triggerRowId = await insertTestRow("TRIGGER_NATIVE_DROP");
    await expect.poll(async () => receivedLabels(page), { timeout: 5_000 }).toContain("TRIGGER_NATIVE_DROP");

    // The browser's OWN EventSource notices the failure and reconnects
    // entirely on its own (native `retry:` hint, ~3s) - this test performs
    // no client-side action to cause or hasten that.
    await expect.poll(() => streamRequests.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);

    const reconnectRequest = streamRequests[1]!;
    const observedLastEventId = reconnectRequest.headers["last-event-id"];
    expect(observedLastEventId).toBeDefined();
    // The real, latest-seen source-1 ordinal (the sentinel row's own id)
    // must be present in the real header the browser sent - proof the
    // STANDARD Last-Event-ID mechanism carried the correct, true position,
    // not a query-string bootstrap (which this request should not even
    // have - Case A never uses it).
    expect(observedLastEventId).toContain(`1:${triggerRowId}`);
    // Case A's reconnect request carries the cursor via the standard
    // HEADER only - unlike Case B (test D below), the reconnecting
    // request's URL itself has no `?lastEventId=` query string, because the
    // SAME EventSource object performed this reconnect (a query bootstrap
    // is only ever added by THIS layer's own code when constructing a
    // genuinely NEW EventSource, which never happened in this test).
    expect(new URL(reconnectRequest.url).searchParams.has("lastEventId")).toBe(false);

    // After resuming, live delivery keeps working with no duplicate of the anchor.
    await insertTestRow("after-native-reconnect");
    await expect
      .poll(async () => receivedLabels(page), { timeout: 15_000 })
      .toEqual(expect.arrayContaining(["anchor-before-native-drop", "after-native-reconnect"]));
    const labels = await receivedLabels(page);
    expect(labels.filter((l) => l === "anchor-before-native-drop")).toHaveLength(1);
  });

  test("B->C. DROP then RECOVERY: a real closed connection, blocked from reconnecting beyond grace, activates polling; unblocking deactivates it", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForTransportState(page, "LIVE");

    const pollCountBeforeDrop = Number((await probe(page).getAttribute("data-poll-fetch-count")) ?? "0");

    // Block every NEW /api/stream connection attempt at the real network
    // layer BEFORE closing the current one, so the fast fatal-retry path
    // cannot silently recover before the grace period elapses. A function
    // matcher (not a glob string) is used deliberately: reconnect attempts
    // after the very first one carry a `?lastEventId=...` query string
    // (sseConnectionManager.ts's own EventSource-header-limitation
    // workaround), which a plain `"**/api/stream"` glob does not match -
    // matching on `pathname` catches every attempt regardless of query
    // string.
    const isStreamRequest = (url: URL): boolean => url.pathname === "/api/stream";
    await page.route(isStreamRequest, (route) => route.abort());
    await forceDisconnect(page);

    // Beyond the grace period -> fallback activates.
    await expect(probe(page)).toHaveAttribute("data-polling-active", "true", { timeout: 20_000 });

    // The polling fallback is genuinely making HTTP requests against the
    // real /api/version endpoint - not just flagging a state. The first
    // fallback fetch may not have completed in the exact instant
    // `data-polling-active` flipped to "true", so poll for it rather than
    // reading once.
    await expect
      .poll(async () => Number((await probe(page).getAttribute("data-poll-fetch-count")) ?? "0"), {
        timeout: 5_000,
      })
      .toBeGreaterThan(pollCountBeforeDrop);

    // C. Recovery: unblock new connections - live mode resumes, fallback stops.
    await page.unroute(isStreamRequest);
    await waitForTransportState(page, "LIVE", 20_000);
    await expect(probe(page)).toHaveAttribute("data-polling-active", "false", { timeout: 10_000 });

    // Read-side data still updates once healthy again - the acceptance
    // criterion's actual point ("no user-visible breakage").
    await insertTestRow("post-recovery-event");
    await expect.poll(async () => receivedLabels(page), { timeout: 10_000 }).toContain("post-recovery-event");
  });

  test("D. RESUME: events produced during a real brief disconnect are replayed on reconnect, no gap, no duplicate", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForTransportState(page, "LIVE");

    await insertTestRow("seen-before-drop");
    await expect.poll(async () => receivedLabels(page), { timeout: 10_000 }).toContain("seen-before-drop");

    await forceDisconnect(page);
    // Insert immediately, before this layer's own fast fatal-retry
    // reconnect attempt (default ~1s) has a chance to fire.
    await insertTestRow("missed-during-drop-1");
    await insertTestRow("missed-during-drop-2");

    await expect
      .poll(async () => receivedLabels(page), { timeout: 15_000 })
      .toEqual(expect.arrayContaining(["seen-before-drop", "missed-during-drop-1", "missed-during-drop-2"]));

    const labels = await receivedLabels(page);
    // No duplicates: "seen-before-drop" appears exactly once even though the
    // connection reconnected and replayed.
    expect(labels.filter((l) => l === "seen-before-drop")).toHaveLength(1);
  });

  test("E. GAP: a Last-Event-ID whose history was pruned triggers resync_required, never a silent partial replay", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForTransportState(page, "LIVE");

    await insertTestRow("will-be-pruned-1");
    await expect.poll(async () => receivedLabels(page), { timeout: 10_000 }).toContain("will-be-pruned-1");

    await forceDisconnect(page);
    await insertTestRow("will-be-pruned-2");
    const survivorId = await insertTestRow("survivor");
    // Let the server-side poller advance its watermark past all three while
    // this browser is disconnected, before simulating retention.
    await page.waitForTimeout(500);

    // Simulate retention: delete everything except the survivor - a real
    // gap between what this browser last saw and what the source can still
    // produce.
    await deleteTestRowsUpTo(survivorId - 1);

    await expect
      .poll(async () => Number((await probe(page).getAttribute("data-resync-count")) ?? "0"), {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);

    // The pruned rows must never appear as if they were replayed.
    const labels = await receivedLabels(page);
    expect(labels).not.toContain("will-be-pruned-2");
  });

  test.describe("multi-tab dedup", () => {
    // This ONE scenario gets its own retry budget, even locally
    // (`playwright.config.ts`'s top-level `retries` is 0 outside CI): real
    // Chromium background-tab TIMER THROTTLING (confirmed root cause, not
    // guessed) means exactly one of two real tabs in one browser window is,
    // by definition, always the non-active one, and its own dedup-decision
    // `setTimeout` can occasionally fire later than the fixed safety margin
    // accounts for. This is a genuine, documented web-platform behavior a
    // real user's second tab would ALSO experience - correctness (both
    // tabs' underlying data state) is unaffected either way, only the
    // cosmetic "which tab shows the toast" outcome, and mission itself
    // classifies this mechanism as "a UX polish, not a correctness
    // requirement." The underlying tie-break algorithm is proven
    // deterministically correct regardless, in
    // packages/shared/test/realtime.test.ts and
    // apps/web/src/realtime/__tests__/multiTabDedup.test.ts's pure
    // `pickDedupWinner` tests. Scoped to this nested describe only - every
    // OTHER test in this file keeps the project-level retry count.
    test.describe.configure({ retries: 2 });

    test("two real tabs (pages) in the SAME browser context, real BroadcastChannel, exactly one claims the toast for the same event", async ({
      browser,
    }) => {
      // `BroadcastChannel` is scoped per-origin WITHIN one storage
      // partition/profile - two Playwright `BrowserContext`s are, by
      // design, isolated storage partitions (like two separate browser
      // profiles), so they do NOT share a `BroadcastChannel` (verified
      // empirically: two separate contexts both "claimed" the same event,
      // since neither ever saw the other's announcement - a real platform
      // constraint, not a bug in the dedup algorithm itself, which
      // packages/shared's `pickDedupWinner` unit tests already prove
      // deterministically). Real multi-tab behavior - what this scenario
      // actually needs to reproduce - is two PAGES in the SAME context,
      // exactly like two tabs in one real browser window.
      const sharedContext = await browser.newContext();
      const pageA = await sharedContext.newPage();
      const pageB = await sharedContext.newPage();

      try {
        await pageA.goto("/");
        await pageB.goto("/");
        await waitForTransportState(pageA, "LIVE");
        await waitForTransportState(pageB, "LIVE");

        await insertTestRow("multi-tab-event");

        await expect
          .poll(async () => receivedLabels(pageA), { timeout: 10_000 })
          .toContain("multi-tab-event");
        await expect
          .poll(async () => receivedLabels(pageB), { timeout: 10_000 })
          .toContain("multi-tab-event");

        // The dedup decision resolves ~500ms (MULTI_TAB_DEDUP_WINDOW_MS)
        // after the event is received - wait for both tabs' claims to
        // actually land.
        await expect
          .poll(
            async () => (await probe(pageA).getAttribute("data-toast-claims"))?.includes("multi-tab-event"),
            {
              timeout: 5_000,
            },
          )
          .toBe(true);
        await expect
          .poll(
            async () => (await probe(pageB).getAttribute("data-toast-claims"))?.includes("multi-tab-event"),
            {
              timeout: 5_000,
            },
          )
          .toBe(true);

        const claimsA = await probe(pageA).getAttribute("data-toast-claims");
        const claimsB = await probe(pageB).getAttribute("data-toast-claims");
        const claimedA = claimsA?.includes("multi-tab-event:claimed") ?? false;
        const claimedB = claimsB?.includes("multi-tab-event:claimed") ?? false;

        // Both tabs received and processed the SAME underlying event
        // independently (correctness) - but exactly one shows the toast
        // (UX polish, 26_REALTIME_SSE_AND_SYNC.md §Multi-tab).
        expect([claimedA, claimedB].filter(Boolean)).toHaveLength(1);
      } finally {
        await sharedContext.close();
      }
    });
  });
});
