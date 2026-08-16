/**
 * `dashboard_sessions` data access (ADR-020's full lifecycle: creation,
 * sliding/absolute TTL, rotation, logout/logout-all, listing, individual
 * revocation, restart-durability via MySQL).
 *
 * The RAW session token never appears in a query — every lookup/write uses
 * `hashSessionToken(rawToken)` (SHA-256 hex), matching
 * `dashboard_sessions.id`'s documented meaning ("opaque token hash, not the
 * raw token", 25_DATA_MODEL.md).
 */
import type { Kysely } from "kysely";
import type { DB } from "../db/codegen-types.js";
import { hashSessionToken } from "./sessionToken.js";

export interface DashboardSessionRow {
  id: string;
  user_id: number;
  device_label: string | null;
  user_agent: string | null;
  ip_hash: string | null;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  absolute_expires_at: Date;
}

export interface CreateSessionParams {
  userId: number;
  deviceLabel: string | null;
  userAgent: string | null;
  ipHash: string | null;
  slidingTtlMs: number;
  absoluteTtlMs: number;
  now?: Date;
}

/** Returns the RAW token (given to the browser) — never stored itself, only its hash. */
export async function createSession(
  db: Kysely<DB>,
  rawToken: string,
  params: CreateSessionParams,
): Promise<DashboardSessionRow> {
  const now = params.now ?? new Date();
  const expiresAt = new Date(now.getTime() + params.slidingTtlMs);
  const absoluteExpiresAt = new Date(now.getTime() + params.absoluteTtlMs);
  const id = hashSessionToken(rawToken);

  await db
    .insertInto("dashboard_sessions")
    .values({
      id,
      user_id: params.userId,
      device_label: params.deviceLabel,
      user_agent: params.userAgent,
      ip_hash: params.ipHash,
      created_at: now,
      last_seen_at: now,
      expires_at: expiresAt,
      absolute_expires_at: absoluteExpiresAt,
    })
    .execute();

  return {
    id,
    user_id: params.userId,
    device_label: params.deviceLabel,
    user_agent: params.userAgent,
    ip_hash: params.ipHash,
    created_at: now,
    last_seen_at: now,
    expires_at: expiresAt,
    absolute_expires_at: absoluteExpiresAt,
  };
}

/**
 * Looks up a session by its RAW token, returning it ONLY if it is still
 * valid (`now < expires_at AND now < absolute_expires_at`) — an
 * expired/revoked session is indistinguishable from a nonexistent one to
 * every caller (27_SECURITY.md: "expired/invalid/revoked sessions fail
 * closed").
 */
export async function findValidSessionByRawToken(
  db: Kysely<DB>,
  rawToken: string,
  now: Date = new Date(),
): Promise<DashboardSessionRow | undefined> {
  const id = hashSessionToken(rawToken);
  const row = await db
    .selectFrom("dashboard_sessions")
    .selectAll()
    .where("id", "=", id)
    .where("expires_at", ">", now)
    .where("absolute_expires_at", ">", now)
    .executeTakeFirst();
  return row;
}

/**
 * Sliding-expiry renewal (ADR-020: "30-day sliding window (refreshed on any
 * authenticated request)") — never extends past `absolute_expires_at`, so a
 * continuously-active session still hits its hard 90-day cap
 * (ADR-020: "90-day absolute cap forcing full re-auth regardless of
 * activity").
 */
export async function touchSession(
  db: Kysely<DB>,
  sessionId: string,
  slidingTtlMs: number,
  now: Date = new Date(),
): Promise<void> {
  const candidateExpiry = new Date(now.getTime() + slidingTtlMs);
  await db
    .updateTable("dashboard_sessions")
    .set((eb) => ({
      last_seen_at: now,
      expires_at: eb
        .case()
        .when("absolute_expires_at", "<", candidateExpiry)
        .then(eb.ref("absolute_expires_at"))
        .else(candidateExpiry)
        .end(),
    }))
    .where("id", "=", sessionId)
    .execute();
}

export async function deleteSessionByRawToken(db: Kysely<DB>, rawToken: string): Promise<void> {
  await db.deleteFrom("dashboard_sessions").where("id", "=", hashSessionToken(rawToken)).execute();
}

export async function deleteSessionById(db: Kysely<DB>, sessionId: string, userId: number): Promise<number> {
  const result = await db
    .deleteFrom("dashboard_sessions")
    .where("id", "=", sessionId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

export async function deleteAllSessionsForUser(db: Kysely<DB>, userId: number): Promise<number> {
  const result = await db.deleteFrom("dashboard_sessions").where("user_id", "=", userId).executeTakeFirst();
  return Number(result.numDeletedRows);
}

export async function listSessionsForUser(db: Kysely<DB>, userId: number): Promise<DashboardSessionRow[]> {
  return db
    .selectFrom("dashboard_sessions")
    .selectAll()
    .where("user_id", "=", userId)
    .orderBy("last_seen_at", "desc")
    .execute();
}

/** ADR-020 risk mitigation: "expired-session sweep job" — deletes rows past either TTL. Idempotent, safe to run repeatedly/concurrently. */
export async function sweepExpiredSessions(db: Kysely<DB>, now: Date = new Date()): Promise<number> {
  const result = await db
    .deleteFrom("dashboard_sessions")
    .where((eb) => eb.or([eb("expires_at", "<=", now), eb("absolute_expires_at", "<=", now)]))
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}
