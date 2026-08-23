/**
 * Minimal, dependency-free ULID generator (Crockford Base32, 48-bit
 * millisecond timestamp + 80-bit randomness = 26 characters) — this repo's
 * shared schema already uses `CHAR(26) CHARACTER SET ascii COLLATE ascii_bin`
 * for durable ids (`operator_commands.command_id` et al.,
 * `01_NEW_SELF_BOTS/database/migrations/0009_operations.up.sql:17`), but no
 * Dashboard-owned table has needed a CHAR26 id generator until this step
 * (`dashboard_notifications`/`dashboard_notification_deliveries` both use
 * one). No `ulid`/`nanoid` package is installed anywhere in this workspace
 * (`apps/api/package.json` has no such dependency) — this file is a small,
 * fully-tested addition rather than pulling in a new runtime dependency for
 * one 30-line algorithm. Time-sortable by construction, which
 * `apps/api/src/notifications/repo.ts` relies on for cursor pagination
 * (`WHERE id < :cursor ORDER BY id DESC`, no separate `created_at` index
 * needed).
 */
import { randomBytes } from "node:crypto";

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function encodeTime(nowMs: number): string {
  let time = nowMs;
  const chars = new Array<string>(TIME_LEN);
  for (let i = TIME_LEN - 1; i >= 0; i -= 1) {
    chars[i] = CROCKFORD_ALPHABET[time % 32]!;
    time = Math.floor(time / 32);
  }
  return chars.join("");
}

function encodeRandom(): string {
  // 80 bits = 10 bytes -> 16 base32 characters (5 bits/char).
  const bytes = randomBytes(10);
  let bits = 0n;
  for (const byte of bytes) {
    bits = (bits << 8n) | BigInt(byte);
  }
  const chars = new Array<string>(RANDOM_LEN);
  for (let i = RANDOM_LEN - 1; i >= 0; i -= 1) {
    chars[i] = CROCKFORD_ALPHABET[Number(bits & 31n)]!;
    bits >>= 5n;
  }
  return chars.join("");
}

/** A fresh, time-sortable CHAR26 id. Never used for anything security-sensitive (the randomness is 80 bits, generous for collision avoidance at this system's realistic volume, but this is an identifier, not a secret token). */
export function generateNotificationId(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

/** Structural validity check only (used by `createNotification`'s optional caller-supplied `notificationId` parameter — never trust an externally-shaped-but-wrong id silently). */
export function isSyntacticallyValidNotificationId(value: string): boolean {
  return ULID_PATTERN.test(value);
}
