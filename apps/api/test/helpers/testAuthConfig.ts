/**
 * Shared, deliberately-fake auth config fragments for tests that build an
 * `AppConfig` but don't exercise OAuth/session behaviour themselves (health,
 * version, SSE-stream regression tests). Real Step-04 auth tests
 * (test/auth/*.test.ts) build their own config pointing at a local Discord
 * test double instead of reusing this.
 *
 * These are NOT secrets (00_GLOBAL_IMPLEMENTATION_RULES.md #15: ".env.example
 * files get placeholder values only" — the same principle applies to test
 * fixtures) — fixed, publicly-committed, test-only byte sequences that would
 * be useless against any real deployment (no real Discord client secret, no
 * real key ever derived from or equal to these).
 */
import type { AppConfig } from "../../src/config.js";

export function testDiscordConfig(): AppConfig["discord"] {
  return {
    clientId: "test-client-id",
    clientSecret: "test-client-secret-never-real",
    redirectUri: "http://127.0.0.1:0/api/auth/callback",
    scope: "identify guilds guilds.members.read",
    authorizeBaseUrl: "http://127.0.0.1:0/oauth2/authorize",
    tokenUrl: "http://127.0.0.1:0/oauth2/token",
    apiBaseUrl: "http://127.0.0.1:0/api",
  };
}

export function testSessionConfig(): AppConfig["session"] {
  return {
    cookieName: "bcc_session",
    transactionCookieName: "bcc_oauth_txn",
    transactionSigningKey: Buffer.alloc(32, 0x11),
    tokenEncryptionKey: Buffer.alloc(32, 0x22),
    slidingTtlMs: 30 * 24 * 60 * 60 * 1000,
    absoluteTtlMs: 90 * 24 * 60 * 60 * 1000,
    sweepIntervalMs: 60 * 60 * 1000,
  };
}
