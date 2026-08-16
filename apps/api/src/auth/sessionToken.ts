/**
 * Opaque, high-entropy session tokens (ADR-020: "opaque 256-bit token").
 * The RAW token is what the browser holds in its `bcc_session` cookie; only
 * its SHA-256 hash is ever persisted (`dashboard_sessions.id`,
 * 25_DATA_MODEL.md: "id PK (opaque token hash, not the raw token)") — a
 * database read alone can never yield a usable credential, and this hashing
 * is deterministic/unsalted specifically so a lookup by presented token stays
 * an O(1) indexed equality query (a per-token salt would require a full table
 * scan to find the matching row).
 */
import { randomBytes, createHash } from "node:crypto";

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf-8").digest("hex");
}
