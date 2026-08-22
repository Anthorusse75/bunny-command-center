/**
 * Extends Step 03's existing SSE infrastructure via its documented extension
 * points (`registerEventType`/`registerSourceAdapter`,
 * `apps/api/src/sse/registry.ts:27-38`) — this step's task brief: "do not
 * build a second SSE endpoint/mechanism". `notification.created` is the
 * FIRST genuinely feature-specific event type/source adapter registered in
 * this codebase (Step 06's `permissions_changed` was only ever registered
 * client-side, `apps/web/src/features/guilds/realtimeWiring.ts`, with no
 * real server-side emitter yet).
 *
 * Correction #6 — the durable ordinal is `dashboard_notifications.sse_seq`
 * (a dedicated `BIGINT UNSIGNED AUTO_INCREMENT` column, migration 0008's
 * header comment has the full rationale for why the CHAR26 `id` cannot be
 * used here), fetched via `repo.ts`'s `fetchNotificationsSinceSseSeq`/
 * `oldestNotificationSseSeq`.
 *
 * Channel scoping: `userScope(String(row.user_id))` per row — this is the
 * ONLY place a notification's recipient is turned into an SSE channel, so a
 * poller tick fanning out 500 different users' notifications in one batch
 * can never leak one user's row onto another user's connection (the hub's
 * own `broadcast()` already filters by exact scope membership per
 * connection — this adapter's job is only to report the CORRECT scope per
 * row, never to over-broadcast).
 */
import type { Kysely } from "kysely";
import {
  NOTIFICATION_CREATED_EVENT_TYPE,
  notificationCreatedDataSchema,
  userScope,
} from "@bunny-command-center/shared";
import type { DB } from "../db/codegen-types.js";
import type { SourceAdapter, SourceRow } from "../sse/types.js";
import { registerEventType, registerSourceAdapter, unregisterSourceAdapter } from "../sse/registry.js";
import { fetchNotificationsSinceSseSeq, oldestNotificationSseSeq } from "./repo.js";

/**
 * `0` is reserved for heartbeat (`sse/types.ts`'s `HEARTBEAT_SOURCE_INDEX`).
 * `1` is already claimed by Step 03's own synthetic test source adapter
 * (`apps/api/test/helpers/sseTestSource.ts`'s `TEST_SOURCE_INDEX`) — that
 * fixture registers directly into the same module-level registry
 * (`apps/api/src/sse/registry.ts`) independently of `buildServer()` in
 * several existing integration tests (`test/sse-stream.test.ts`), so `1`
 * must stay reserved for it. `2` is this codebase's first REAL production
 * source adapter.
 */
export const DASHBOARD_NOTIFICATIONS_SSE_SOURCE_INDEX = 2;

const NOTIFICATIONS_SOURCE_TABLE = "dashboard_notifications";

export function buildNotificationsSourceAdapter(db: Kysely<DB>): SourceAdapter {
  return {
    sourceTable: NOTIFICATIONS_SOURCE_TABLE,
    sourceIndex: DASHBOARD_NOTIFICATIONS_SSE_SOURCE_INDEX,
    async fetchSince(sinceOrdinal, limit): Promise<SourceRow[]> {
      const rows = await fetchNotificationsSinceSseSeq(db, sinceOrdinal, limit);
      return rows.map((row) => ({
        ordinal: row.sse_seq,
        eventType: NOTIFICATION_CREATED_EVENT_TYPE,
        scope: userScope(String(row.user_id)),
        // `inAppVisible` (external-review item 2): every row still gets an
        // SSE event (the cursor must advance past a SKIPPED_PREFERENCE row
        // regardless — see `repo.ts`'s `fetchNotificationsSinceSseSeq` doc
        // comment), but the frontend uses this flag to decide whether the
        // arrival is actually rendered/counted/announced.
        data: {
          notificationId: row.id,
          messageKey: row.message_key,
          parameters: row.parameters_json,
          inAppVisible: row.in_app_visible,
        },
        occurredAt: row.created_at,
      }));
    },
    async oldestAvailableOrdinal(): Promise<number | null> {
      return oldestNotificationSseSeq(db);
    },
  };
}

let registeredForDb: Kysely<DB> | undefined;

/**
 * Idempotent — called once from `server.ts` at real startup (this step's
 * task brief: "registered at real server startup (not just defined in a
 * file)"). Safe to call more than once (e.g. across `buildServer()` calls in
 * a test suite that builds multiple server instances in one process): the
 * SAME `db` instance is a genuine no-op (avoids the registry's own
 * already-registered throw); a DIFFERENT `db` instance — external-review
 * item 3's `health.test.ts` investigation — re-points the adapter at the
 * CURRENT `db` rather than silently leaving it bound to a PREVIOUS
 * `buildServer()` call's `db` forever. That earlier "register once, skip
 * every later call" version of this guard was found to be a genuine
 * regression: `apps/api/test/health.test.ts` builds 5 separate servers
 * (each with its own `db`/pool, several subsequently `destroy()`-ed via
 * `preClose`) in ONE test-file process — every server AFTER the first had
 * its SSE poller querying `dashboard_notifications` through the FIRST
 * server's already-destroyed pool, which surfaced as an unhandled
 * `connect ETIMEDOUT` rejection during the "DB DOWN" cases (reproduced
 * deterministically outside Vitest too — see this step's HANDOVER). The
 * event type registration itself is schema-only (never depends on which
 * `db` is current), so it is registered exactly once, ever.
 */
export function registerNotificationsSse(db: Kysely<DB>): void {
  if (registeredForDb === db) {
    return;
  }
  if (registeredForDb === undefined) {
    registerEventType({ type: NOTIFICATION_CREATED_EVENT_TYPE, schema: notificationCreatedDataSchema });
  } else {
    unregisterSourceAdapter(NOTIFICATIONS_SOURCE_TABLE);
  }
  registeredForDb = db;
  registerSourceAdapter(buildNotificationsSourceAdapter(db));
}

/** Test-only reset — mirrors `resetRegistryForTests` in `sse/registry.ts`, needed because `registeredForDb` is a module-level singleton. */
export function resetNotificationsSseRegistrationForTests(): void {
  registeredForDb = undefined;
}
