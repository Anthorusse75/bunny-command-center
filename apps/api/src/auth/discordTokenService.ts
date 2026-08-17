/**
 * The full Discord access-token refresh lifecycle for Step 05's first real
 * session-time Discord permission calls (Mandatory carry-forward #2 from
 * Step 04's HANDOVER; 07_DISCORD_OAUTH.md §Discord token refresh).
 *
 * Contract (07_DISCORD_OAUTH.md, this step's spec):
 *   1-2. Discord tokens stay server-side only; read ENCRYPTED from
 *        `dashboard_users` here.
 *   3. Decrypted only inside this module (the backend OAuth/Discord service
 *      boundary) -- a decrypted access token is handed to the caller's
 *      `call` closure and nowhere else.
 *   4. The caller performs the actual Discord guild/member request.
 *   5. On a Discord 401 (`discordGuildClient.ts`'s `isDiscordUnauthorized`):
 *      exactly ONE controlled refresh.
 *   6. The refreshed (possibly rotated) token material is persisted before
 *      the retry.
 *   7. The original request is retried AT MOST ONCE, with the fresh token.
 *   8-9. If the refresh itself fails, OR the retried request still 401s,
 *      this throws `DiscordReauthRequiredError` -- never a second refresh,
 *      never a silent success. The CALLER (`guildAuthorization.ts`/
 *      `tier.ts`) is responsible for turning that into an actual session
 *      invalidation + re-login response, per 07_DISCORD_OAUTH.md: this
 *      module has no access to the Fastify `reply`/cookie and must not
 *      reach for one.
 *   10. No loop of any kind -- structurally, by construction.
 *   11. Never logs, returns, or embeds a token value in any error message
 *      this module throws (`Error` messages below are fixed strings; a
 *      wrapped cause is attached as `.cause`, never stringified into the
 *      message itself, and callers must not stringify a token-bearing
 *      cause into a user-visible response either).
 *   12. Concurrent refreshes for the SAME dashboard user never fan out into
 *      redundant Discord refresh calls -- see "Synchronization algorithm"
 *      below for the exact mechanism (corrected post-external-review; the
 *      original design had a genuine TOCTOU race, see that section).
 *
 * === Synchronization algorithm (external-review correction) ===
 * The ORIGINAL design captured the refresh token from the `dashboard_users`
 * row read BEFORE the initial (failing) Discord request, and a per-user
 * `Map<number, Promise<RefreshedAccessToken>>` only collapsed refreshes that
 * were ALREADY in flight at the moment a second caller checked the map. This
 * left a real window open: if caller A's entire refresh cycle (call Discord
 * refresh -> persist v2 -> release the lock) completed BEFORE caller B's own
 * stale 401 (using the same pre-refresh access token, read independently by
 * B before A even started) was even processed, B would find the lock empty
 * again and attempt a SECOND refresh using its own stale, pre-captured
 * refresh token -- which Discord may have already rotated away, producing a
 * redundant refresh call, a possible `invalid_grant` failure, and a
 * needlessly invalidated session.
 *
 * The fix is NOT "make the lock last longer" -- it is to make each caller's
 * post-401 refresh decision re-read CURRENT persisted state and compare it
 * against what THAT caller's own failed request actually used, every time,
 * inside a per-user serialized (mutex-like) section:
 *   1. `withFreshAccessToken` reads/decrypts the CURRENT access token and
 *      calls `call(accessToken)` normally (unchanged).
 *   2. On a 401, the caller enters `runExclusive(dashboardUserId, ...)` --
 *      a per-user FIFO queue (NOT a single shared promise-memoization map).
 *      Every caller that enters runs its OWN body, one at a time per user,
 *      never overlapping with another caller for the SAME user.
 *   3. Inside that exclusive section (`refreshIfStillStale`): re-read
 *      `dashboard_users` fresh, decrypt its CURRENT access token, and
 *      compare it against the access token THIS caller's own failed
 *      request used.
 *   4. If they DIFFER: another caller already completed a refresh while
 *      this one was in flight -- return the newer persisted access token,
 *      NO Discord call is made.
 *   5. If they are the SAME: this caller's failed token is genuinely still
 *      current -- decrypt the CURRENT persisted refresh token (also
 *      freshly read, never the pre-401 value) and perform exactly one real
 *      Discord refresh, persisting the result before returning.
 *   6. The caller retries its original operation at most once with
 *      whatever access token step 4/5 produced.
 * This correctly allows a genuinely NEW refresh cycle once the persisted
 * token has itself gone stale again (a later 401 against the CURRENT token
 * still triggers step 5 for whichever caller reaches it first), while never
 * letting a delayed, already-superseded 401 trigger a redundant refresh.
 */
import type { Kysely } from "kysely";
import type { DB } from "../db/codegen-types.js";
import type { AppConfig } from "../config.js";
import { findDashboardUserById, updateDashboardUserTokens } from "./userRepo.js";
import { encryptSecret, decryptSecret } from "./tokenCrypto.js";
import { refreshDiscordToken, DiscordTokenExchangeError } from "./discordClient.js";
import { isDiscordUnauthorized } from "./discordGuildClient.js";

export class DiscordReauthRequiredError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DiscordReauthRequiredError";
  }
}

interface RefreshedAccessToken {
  accessToken: string;
}

export class DiscordTokenService {
  /**
   * Per-dashboard-user FIFO serialization queue -- NOT a shared result
   * cache. Each entry is the settled (always-resolves, never-rejects) tail
   * of the last-enqueued exclusive operation for that user; a new caller
   * chains its OWN operation onto that tail via `runExclusive` so no two
   * callers for the SAME user ever run their exclusive section concurrently,
   * while still letting each caller's own re-read-and-compare logic decide
   * independently whether a real Discord refresh is actually needed (see
   * "Synchronization algorithm" above). Entries are removed once their
   * queue drains (contract point 12's "no poisoned permanent lock").
   */
  private readonly userQueues = new Map<number, Promise<void>>();

  constructor(
    private readonly db: Kysely<DB>,
    private readonly config: AppConfig,
  ) {}

  /**
   * Runs `call` with the user's current decrypted access token. On a
   * Discord 401, enters the per-user exclusive section (which may or may
   * not perform a real refresh, per the algorithm above) and retries `call`
   * exactly once with the resulting token. Any non-401 error from `call`
   * (network failure, 403, 5xx, malformed body) propagates UNCHANGED -- only
   * a 401 is refresh-eligible.
   */
  async withFreshAccessToken<T>(
    dashboardUserId: number,
    call: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    const userRow = await findDashboardUserById(this.db, dashboardUserId);
    if (!userRow || !userRow.discord_access_token_enc || !userRow.discord_refresh_token_enc) {
      throw new DiscordReauthRequiredError(
        "No Discord OAuth token material on file for this dashboard user.",
      );
    }

    const accessToken = decryptSecret(
      userRow.discord_access_token_enc,
      this.config.session.tokenEncryptionKey,
    );

    try {
      return await call(accessToken);
    } catch (err) {
      if (!isDiscordUnauthorized(err)) {
        throw err;
      }
      // Contract point 5-7, corrected algorithm: enter the per-user
      // exclusive section, which independently re-checks CURRENT persisted
      // state against THIS caller's own failed token before ever deciding
      // to call Discord's refresh endpoint.
      const refreshed = await this.runExclusive(dashboardUserId, () =>
        this.refreshIfStillStale(dashboardUserId, accessToken),
      );
      try {
        return await call(refreshed.accessToken);
      } catch (retryErr) {
        if (isDiscordUnauthorized(retryErr)) {
          // Contract point 9: a fresh token STILL rejected -- fail, never refresh again.
          throw new DiscordReauthRequiredError(
            "Discord rejected the retried request even with a freshly-refreshed access token.",
            retryErr,
          );
        }
        throw retryErr;
      }
    }
  }

  /**
   * Serializes exclusive operations per `dashboardUserId` -- a plain FIFO
   * queue, not a shared-result cache (see class doc comment). `fn` always
   * runs to completion for THIS caller, one at a time relative to any other
   * caller for the same user; a rejection from one caller's `fn` never
   * poisons or blocks the next caller's turn (the stored queue tail always
   * settles, success or failure, via the `.then(ok, ok)` below), and the
   * map entry is removed once nothing newer is queued behind it -- no
   * permanent lock survives a failure.
   */
  private runExclusive<T>(dashboardUserId: number, fn: () => Promise<T>): Promise<T> {
    // `previousTail` (see the field's own doc comment) is constructed to
    // always resolve, never reject -- a single `.then(() => fn())` is
    // therefore sufficient; no rejection branch can ever fire here.
    const previousTail = this.userQueues.get(dashboardUserId) ?? Promise.resolve();
    const started = previousTail.then(() => fn());
    const settled = started.then(
      () => undefined,
      () => undefined,
    );
    this.userQueues.set(dashboardUserId, settled);
    // Cleanup: only remove the map entry if nothing newer has been enqueued
    // behind this operation while it was running.
    void settled.then(() => {
      if (this.userQueues.get(dashboardUserId) === settled) {
        this.userQueues.delete(dashboardUserId);
      }
    });
    return started;
  }

  /**
   * The exclusive-section body (algorithm steps 3-5 in the class doc
   * comment). MUST be called only from inside `runExclusive` for the same
   * `dashboardUserId` -- re-reads `dashboard_users` fresh (never trusts any
   * value read before entering the exclusive section) and either reuses an
   * already-refreshed token (no Discord call) or performs exactly one real
   * refresh.
   */
  private async refreshIfStillStale(
    dashboardUserId: number,
    failedAccessToken: string,
  ): Promise<RefreshedAccessToken> {
    const currentRow = await findDashboardUserById(this.db, dashboardUserId);
    if (!currentRow || !currentRow.discord_access_token_enc || !currentRow.discord_refresh_token_enc) {
      throw new DiscordReauthRequiredError(
        "No Discord OAuth token material on file for this dashboard user.",
      );
    }
    const key = this.config.session.tokenEncryptionKey;
    const currentAccessToken = decryptSecret(currentRow.discord_access_token_enc, key);

    if (currentAccessToken !== failedAccessToken) {
      // Another caller already refreshed while this one was in flight --
      // reuse the newer persisted token, no second Discord call.
      return { accessToken: currentAccessToken };
    }

    // Still genuinely stale -- exactly one real Discord refresh, using the
    // CURRENT persisted refresh token (freshly decrypted here, never a
    // value captured before entering the exclusive section).
    const currentRefreshToken = decryptSecret(currentRow.discord_refresh_token_enc, key);
    return this.doRefresh(dashboardUserId, currentRefreshToken);
  }

  private async doRefresh(
    dashboardUserId: number,
    currentRefreshToken: string,
  ): Promise<RefreshedAccessToken> {
    const key = this.config.session.tokenEncryptionKey;

    let tokenResponse;
    try {
      tokenResponse = await refreshDiscordToken(this.config.discord, currentRefreshToken);
    } catch (err) {
      if (err instanceof DiscordTokenExchangeError) {
        // Contract point 8: refresh itself failed (revoked grant, network
        // failure, malformed response -- including a malformed HTTP 200
        // body, validated inside refreshDiscordToken itself) -- reauth
        // required, no further retry.
        throw new DiscordReauthRequiredError("Discord token refresh failed.", err);
      }
      throw err;
    }

    const now = new Date();
    const tokenExpiresAt = new Date(now.getTime() + tokenResponse.expires_in * 1000);
    const encryptedAccessToken = encryptSecret(tokenResponse.access_token, key);
    // Discord may or may not rotate the refresh token on a given refresh
    // call (contract point 6: "If Discord rotates the refresh token,
    // persist the rotated token") -- if the response didn't include one,
    // the CURRENT (still-valid) refresh token is persisted again rather
    // than assumed unchanged and left alone, so the persisted row always
    // reflects exactly what would be used on the next refresh attempt.
    const rotatedRefreshTokenPlain = tokenResponse.refresh_token || currentRefreshToken;
    const encryptedRefreshToken = encryptSecret(rotatedRefreshTokenPlain, key);

    await updateDashboardUserTokens(this.db, dashboardUserId, {
      encryptedAccessToken,
      encryptedRefreshToken,
      tokenExpiresAt,
    });

    return { accessToken: tokenResponse.access_token };
  }
}
