/**
 * PKCE (RFC 7636) + OAuth `state` CSRF nonce generation — 07_DISCORD_OAUTH.md's
 * "Authorization Code + PKCE" flow, mandatory because the Dashboard is a public
 * client (27_SECURITY.md §OAuth/session security: "PKCE mandatory").
 *
 * `code_verifier`: 32 cryptographically random bytes, base64url-encoded (43
 * chars — within RFC 7636's 43-128 char requirement).
 * `code_challenge`: BASE64URL(SHA256(code_verifier)) — the S256 method (the only
 * method Discord's implementation and this codebase support; `plain` is never
 * used).
 * `state`: an independent 32-byte random CSRF nonce, never derived from or equal
 * to the verifier/challenge (a distinct secret for a distinct purpose).
 */
import { randomBytes, createHash } from "node:crypto";

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

export function generateCodeChallenge(codeVerifier: string): string {
  return base64url(createHash("sha256").update(codeVerifier).digest());
}

export function generateState(): string {
  return base64url(randomBytes(32));
}
