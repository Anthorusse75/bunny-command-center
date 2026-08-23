/**
 * Pure selection of `operator_commands.requested_by_discord_id`/
 * `requested_by_role` for a `SEND_DM` enqueue (ADR-013, corrected 2026-08-11
 * second pass; `01_NEW_SELF_BOTS/database/migrations/0009_operations.up.sql:36-37,46`).
 *
 * Load-bearing for idempotency: `requested_by_discord_id` is part of the
 * REAL composite `UNIQUE(requested_by_discord_id, target_service,
 * idempotency_key)` constraint, so it must be deterministic across retries
 * of the SAME logical notification. `target_service` is always the constant
 * `'bunny_ocr'` and `idempotency_key` is always the notification's own
 * globally-unique CHAR26 id — so `requested_by_discord_id` is the only
 * remaining variable, and this function's whole job is making sure it never
 * varies across retries of the same logical call:
 *
 *   - HUMAN-triggered (e.g. a Guild Admin clicked "Send reminder"):
 *     `requested_by_discord_id` = that user's real, exact Discord snowflake
 *     STRING (never `Number()`/`parseInt()`'d — `discordSnowflakeSchema`
 *     already enforces the caller passed a syntactically valid one).
 *   - SYSTEM-generated (no human actor — upload completed, badge earned,
 *     etc.): `requested_by_discord_id` = `config.superadmin.discordUserId`
 *     (the platform's own constant, already-privileged identity, ADR-008),
 *     `requested_by_role = 'SYSTEM'`.
 */
import type { AppConfig } from "../config.js";

export interface RequestedByResolution {
  readonly discordUserId: string;
  readonly role: string;
}

/** `triggeredBy` is `undefined` for a system-generated notification (no human actor) — the caller never has to pass a sentinel. */
export function resolveRequestedBy(
  config: Pick<AppConfig, "superadmin">,
  triggeredBy: { readonly discordUserId: string; readonly role?: string } | undefined,
): RequestedByResolution {
  if (triggeredBy) {
    return { discordUserId: triggeredBy.discordUserId, role: triggeredBy.role ?? "USER" };
  }
  return { discordUserId: config.superadmin.discordUserId, role: "SYSTEM" };
}
