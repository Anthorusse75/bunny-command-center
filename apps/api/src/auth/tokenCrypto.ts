/**
 * Application-level AES-256-GCM encryption for Discord OAuth access/refresh
 * tokens at rest (ADR-020: "Discord OAuth access_token/refresh_token are
 * stored encrypted at rest ... key from the deployment's secret store, not the
 * DB"). The key never lives in `dashboard_users` or anywhere in the database —
 * only `config.session.tokenEncryptionKey`, sourced from
 * `DASHBOARD_TOKEN_ENCRYPTION_KEY` (an env var, i.e. the deployment's secret
 * store, per ADR-020's own wording), does.
 *
 * Ciphertext layout (single VARBINARY column): `iv(12) || authTag(16) || ciphertext`.
 * A fresh random 12-byte IV is generated per encryption call (GCM requires a
 * unique IV per key; reuse would break confidentiality) — the caller never
 * supplies or reuses one.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export function encryptSecret(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

export function decryptSecret(payload: Buffer, key: Buffer): string {
  if (payload.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Malformed encrypted payload: too short to contain an IV and auth tag.");
  }
  const iv = payload.subarray(0, IV_LENGTH);
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  // A tampered/corrupted payload or wrong key throws here (GCM tag
  // verification) — never silently returns garbage plaintext.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
}
