/**
 * The short-lived, httpOnly pre-auth cookie carrying the OAuth transaction's
 * `state`/PKCE `code_verifier`/preserved deep-link target
 * (07_DISCORD_OAUTH.md's sequence diagram step "set short-lived httpOnly
 * cookie {state, code_verifier}"; 27_SECURITY.md's session-fixation note: "a
 * pre-auth CSRF-protection cookie ... is used during the flow itself, never
 * reused as the post-auth session token").
 *
 * The cookie's JSON payload is HMAC-SHA256 signed with
 * `config.session.transactionSigningKey` (a server-only secret, never
 * derived from anything client-visible) so a client cannot forge or tamper
 * with `state`/`redirect` — e.g. constructing a cookie that points the
 * post-login redirect somewhere the real flow never chose (would otherwise
 * be an open-redirect vector even with `isSafeInternalRedirectPath`'s
 * structural check alone, since that check only rejects EXTERNAL targets,
 * not "a different internal page than the one the user actually started
 * from").
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface OAuthTransaction {
  state: string;
  codeVerifier: string;
  redirect: string;
  createdAtMs: number;
}

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sign(payload: string, key: Buffer): string {
  return base64url(createHmac("sha256", key).update(payload).digest());
}

export function serializeTransactionCookie(txn: OAuthTransaction, signingKey: Buffer): string {
  const payload = base64url(Buffer.from(JSON.stringify(txn), "utf-8"));
  const signature = sign(payload, signingKey);
  return `${payload}.${signature}`;
}

/**
 * Returns `null` for ANY malformed/tampered/unparsable input — never throws,
 * so a malformed OAuth transaction always fails closed at the call site
 * (27_SECURITY.md: "malformed/expired OAuth transactions fail closed").
 */
export function parseTransactionCookie(
  cookieValue: string | undefined,
  signingKey: Buffer,
): OAuthTransaction | null {
  if (!cookieValue) {
    return null;
  }
  const separatorIndex = cookieValue.lastIndexOf(".");
  if (separatorIndex <= 0) {
    return null;
  }
  const payload = cookieValue.slice(0, separatorIndex);
  const signature = cookieValue.slice(separatorIndex + 1);
  const expectedSignature = sign(payload, signingKey);

  const sigBuf = Buffer.from(signature, "utf-8");
  const expectedBuf = Buffer.from(expectedSignature, "utf-8");
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as OAuthTransaction).state === "string" &&
      typeof (parsed as OAuthTransaction).codeVerifier === "string" &&
      typeof (parsed as OAuthTransaction).redirect === "string" &&
      typeof (parsed as OAuthTransaction).createdAtMs === "number"
    ) {
      return parsed as OAuthTransaction;
    }
    return null;
  } catch {
    return null;
  }
}

export function isTransactionExpired(
  txn: OAuthTransaction,
  maxAgeMs: number,
  nowMs: number = Date.now(),
): boolean {
  return nowMs - txn.createdAtMs > maxAgeMs;
}

/** 07_DISCORD_OAUTH.md: "short-lived" — long enough for a human to complete Discord's consent screen, short enough to bound the CSRF/replay window. */
export const OAUTH_TRANSACTION_MAX_AGE_MS = 10 * 60 * 1000;
