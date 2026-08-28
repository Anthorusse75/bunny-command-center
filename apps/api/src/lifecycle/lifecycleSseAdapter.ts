/**
 * `guild_lifecycle.state_changed` SSE source adapter (Step 10 correction
 * round, Gap 3) — mirrors `apps/api/src/notifications/sseAdapter.ts`'s exact
 * pattern (this codebase's own template for "extend Step 03's SSE
 * infrastructure via its documented extension points, do not build a second
 * SSE mechanism").
 *
 * Channel scoping: `guildScope(row.guild_id)` per row — the ONLY place a
 * lifecycle event's audience is turned into an SSE channel. A connection is
 * only ever subscribed to `guild:{id}` for guilds the caller is ACTUALLY a
 * member of (`sse/route.ts`'s `resolveSubscriptionScopes`, Gap 3's other
 * required addition), so this adapter's job is only to report the CORRECT
 * scope per row, never to over-broadcast.
 */
import type { Kysely } from "kysely";
import {
  GUILD_LIFECYCLE_STATE_CHANGED_EVENT_TYPE,
  guildLifecycleStateChangedDataSchema,
  guildScope,
} from "@bunny-command-center/shared";
import type { DB } from "../db/codegen-types.js";
import type { SourceAdapter, SourceRow } from "../sse/types.js";
import { registerEventType, registerSourceAdapter, unregisterSourceAdapter } from "../sse/registry.js";
import { fetchLifecycleEventsSinceSseSeq, oldestLifecycleEventSseSeq } from "./lifecycleEventsRepo.js";

/**
 * `0` is reserved for heartbeat, `1` for Step 03's synthetic test adapter,
 * `2` is `notifications/sseAdapter.ts`'s `DASHBOARD_NOTIFICATIONS_SSE_SOURCE_INDEX`
 * (this codebase's first real production source adapter) — `3` is the next
 * free, unique, fixed constant.
 */
export const DASHBOARD_GUILD_LIFECYCLE_EVENTS_SSE_SOURCE_INDEX = 3;

const LIFECYCLE_EVENTS_SOURCE_TABLE = "dashboard_guild_lifecycle_events";

export function buildLifecycleEventsSourceAdapter(db: Kysely<DB>): SourceAdapter {
  return {
    sourceTable: LIFECYCLE_EVENTS_SOURCE_TABLE,
    sourceIndex: DASHBOARD_GUILD_LIFECYCLE_EVENTS_SSE_SOURCE_INDEX,
    async fetchSince(sinceOrdinal, limit): Promise<SourceRow[]> {
      const rows = await fetchLifecycleEventsSinceSseSeq(db, sinceOrdinal, limit);
      return rows.map((row) => ({
        ordinal: row.sse_seq,
        eventType: GUILD_LIFECYCLE_STATE_CHANGED_EVENT_TYPE,
        scope: guildScope(row.guild_id),
        data: {
          guildId: row.guild_id,
          previousState: row.previous_state,
          lifecycleState: row.lifecycle_state,
        },
        occurredAt: row.occurred_at,
      }));
    },
    async oldestAvailableOrdinal(): Promise<number | null> {
      return oldestLifecycleEventSseSeq(db);
    },
  };
}

let registeredForDb: Kysely<DB> | undefined;

/**
 * Idempotent, same "re-point on a DIFFERENT db, no-op on the SAME one"
 * discipline as `registerNotificationsSse` — see that function's own doc
 * comment for the full rationale (a real regression found in
 * `apps/api/test/health.test.ts`'s 5-separate-servers-in-one-process case).
 */
export function registerLifecycleEventsSse(db: Kysely<DB>): void {
  if (registeredForDb === db) {
    return;
  }
  if (registeredForDb === undefined) {
    registerEventType({
      type: GUILD_LIFECYCLE_STATE_CHANGED_EVENT_TYPE,
      schema: guildLifecycleStateChangedDataSchema,
    });
  } else {
    unregisterSourceAdapter(LIFECYCLE_EVENTS_SOURCE_TABLE);
  }
  registeredForDb = db;
  registerSourceAdapter(buildLifecycleEventsSourceAdapter(db));
}

/** Test-only reset — mirrors `resetNotificationsSseRegistrationForTests`. */
export function resetLifecycleEventsSseRegistrationForTests(): void {
  registeredForDb = undefined;
}
