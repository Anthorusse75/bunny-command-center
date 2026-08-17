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
 *   10. No loop of any kind -- structurally, by construction (one `try`,
 *      one nested `try` for the retry, no recursion).
 *   11. Never logs, returns, or embeds a token value in any error message
 *      this module throws (`Error` messages below are fixed strings; a
 *      wrapped cause is attached as `.cause`, never stringified into the
 *      message itself, and callers must not stringify a token-bearing
 *      cause into a user-visible response either).
 *   12. Concurrent refreshes for the SAME dashboard user are single-flighted
 *      through `refreshLocks` (bounded: at most one in-flight Discord
 *      refresh call per user ID at any time) -- a second caller arriving
 *      while a refresh is already in flight awaits the SAME promise rather
 *      than starting a second Discord refresh call (which could otherwise
 *      race two refreshes against Discord's OWN refresh-token rotation and
 *      have the loser's stale token silently invalidate the winner's new
 *      one).
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
  /** Per-dashboard-user in-flight refresh promise -- the single-flight lock (contract point 12). */
  private readonly refreshLocks = new Map<number, Promise<RefreshedAccessToken>>();

  constructor(
    private readonly db: Kysely<DB>,
    private readonly config: AppConfig,
  ) {}

  /**
   * Runs `call` with the user's current decrypted access token. On a
   * Discord 401, refreshes exactly once (single-flighted) and retries `call`
   * exactly once with the new token. Any non-401 error from `call` (network
   * failure, 403, 5xx, malformed body) propagates UNCHANGED -- only a 401 is
   * refresh-eligible.
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
      // Contract point 5-7: one controlled, single-flighted refresh, then one retry.
      const refreshed = await this.refreshOnce(dashboardUserId, userRow.discord_refresh_token_enc);
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

  private async refreshOnce(
    dashboardUserId: number,
    encryptedRefreshToken: Buffer,
  ): Promise<RefreshedAccessToken> {
    const existing = this.refreshLocks.get(dashboardUserId);
    if (existing) {
      return existing;
    }
    const promise = this.doRefresh(dashboardUserId, encryptedRefreshToken).finally(() => {
      this.refreshLocks.delete(dashboardUserId);
    });
    this.refreshLocks.set(dashboardUserId, promise);
    return promise;
  }

  private async doRefresh(
    dashboardUserId: number,
    encryptedRefreshToken: Buffer,
  ): Promise<RefreshedAccessToken> {
    const key = this.config.session.tokenEncryptionKey;
    const currentRefreshToken = decryptSecret(encryptedRefreshToken, key);

    let tokenResponse;
    try {
      tokenResponse = await refreshDiscordToken(this.config.discord, currentRefreshToken);
    } catch (err) {
      if (err instanceof DiscordTokenExchangeError) {
        // Contract point 8: refresh itself failed (revoked grant, network
        // failure, malformed response) -- reauth required, no further retry.
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
    const encryptedRefreshToken2 = encryptSecret(rotatedRefreshTokenPlain, key);

    await updateDashboardUserTokens(this.db, dashboardUserId, {
      encryptedAccessToken,
      encryptedRefreshToken: encryptedRefreshToken2,
      tokenExpiresAt,
    });

    return { accessToken: tokenResponse.access_token };
  }
}
