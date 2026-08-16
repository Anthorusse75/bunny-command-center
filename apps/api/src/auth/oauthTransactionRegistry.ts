/**
 * Server-side single-use enforcement for OAuth `state` values
 * (27_SECURITY.md §Replay/idempotency: "OAuth state/PKCE code_verifier are
 * single-use, invalidated after the callback consumes them";
 * IMPLEMENTATION/04_discord_oauth_sessions.md: "a replayed callback with the
 * same code must fail, not silently re-issue a session").
 *
 * The transaction cookie itself (transactionCookie.ts) is cleared by the
 * browser after the callback response, but that alone does not close a RACE:
 * two nearly-simultaneous requests presenting the identical (not-yet-cleared)
 * cookie value must not both succeed. `tryConsume` is a synchronous
 * check-and-set — safe under Node's single-threaded event loop, since no
 * `await` occurs between the `has()` check and the `add()` write, so no other
 * request handler can interleave between them.
 *
 * Deliberately an in-memory, non-durable Map, not a DB table: OAuth
 * transactions are inherently short-lived (bounded by
 * `OAUTH_TRANSACTION_MAX_AGE_MS`, ~10 minutes) and a process restart mid-flow
 * simply means the user retries login — nowhere near the durability bar
 * ADR-020 sets for actual SESSIONS (which must survive a restart). Swept
 * periodically so this Map cannot grow unbounded under sustained traffic.
 */
export class OAuthTransactionRegistry {
  private readonly consumedAtMs = new Map<string, number>();

  tryConsume(state: string): boolean {
    if (this.consumedAtMs.has(state)) {
      return false;
    }
    this.consumedAtMs.set(state, Date.now());
    return true;
  }

  sweep(maxAgeMs: number, nowMs: number = Date.now()): void {
    for (const [state, consumedAt] of this.consumedAtMs) {
      if (nowMs - consumedAt > maxAgeMs) {
        this.consumedAtMs.delete(state);
      }
    }
  }

  get size(): number {
    return this.consumedAtMs.size;
  }
}
