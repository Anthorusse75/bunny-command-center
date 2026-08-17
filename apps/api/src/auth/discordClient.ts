/**
 * Discord OAuth2 HTTP calls (07_DISCORD_OAUTH.md's sequence diagram: token
 * exchange, `GET /users/@me`). Uses the Bunny OCR Discord APPLICATION's
 * client ID/secret (`config.discord`) — never `BOT_OCR`, which this module
 * never reads or references.
 *
 * `authorizeBaseUrl`/`tokenUrl`/`apiBaseUrl` are configurable (see
 * `config.ts`) specifically so integration tests can point this client at a
 * local, controlled HTTP test double instead of the real discord.com hosts
 * (31_TEST_STRATEGY.md: "acceptable to use a controlled local Discord OAuth
 * HTTP test double for deterministic protocol/error testing") — production
 * defaults to the real Discord hosts.
 *
 * SSRF note (27_SECURITY.md §SSRF): every URL this module fetches is built
 * from server-side config only — never from any client-supplied value.
 */
import type { DiscordOAuthConfig } from "../config.js";

export interface DiscordTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

export interface DiscordUser {
  id: string;
  username: string;
  avatar: string | null;
}

export class DiscordTokenExchangeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DiscordTokenExchangeError";
  }
}

export class DiscordIdentityFetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DiscordIdentityFetchError";
  }
}

/**
 * Deliberately omits `prompt` (Copilot review, Step 04 review pass):
 * Discord's own docs (docs.discord.com/developers/topics/oauth2) document
 * `prompt=consent` as forcing the user to REAPPROVE every single login, even
 * one that already granted the exact same scopes — directly contradicting
 * this PR's own stated rationale for granting `guilds`/`guilds.members.read`
 * now ("so the OAuth consent screen is only shown once"). No project
 * document (`07_DISCORD_OAUTH.md`, `ADR-004`, the Step-04 implementation
 * file) specifies a `prompt` value at all — the original unconditional
 * `prompt=consent` was an undocumented implementation choice, not something
 * the canonical architecture required. Omitting the parameter entirely lets
 * Discord apply its own documented default: a returning user who already
 * granted the current scope set skips the consent screen; anyone who
 * hasn't (or whose grant no longer covers the requested scopes) still sees
 * it. Not replaced with `prompt=none` either — that would suppress consent
 * even for a genuinely first-time authorization, which no project document
 * calls for.
 */
export function buildAuthorizeUrl(
  config: DiscordOAuthConfig,
  params: { state: string; codeChallenge: string },
): string {
  const url = new URL(config.authorizeBaseUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/**
 * Never logs `code`, `codeVerifier`, `client_secret`, or the resulting
 * tokens (30_OBSERVABILITY_AND_AUDIT.md: "What is never logged" —
 * enforced by never passing these to a logger anywhere in this function,
 * and by the caller doing the same with this function's return value).
 */
export async function exchangeCodeForToken(
  config: DiscordOAuthConfig,
  params: { code: string; codeVerifier: string },
): Promise<DiscordTokenResponse> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: config.redirectUri,
    code_verifier: params.codeVerifier,
  });

  let response: Response;
  try {
    response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (err) {
    throw new DiscordTokenExchangeError(`Discord token endpoint unreachable: ${(err as Error).message}`, 0);
  }

  if (!response.ok) {
    throw new DiscordTokenExchangeError(
      `Discord token exchange failed with status ${response.status}`,
      response.status,
    );
  }

  const json: unknown = await response.json().catch(() => null);
  if (
    typeof json !== "object" ||
    json === null ||
    typeof (json as DiscordTokenResponse).access_token !== "string" ||
    typeof (json as DiscordTokenResponse).refresh_token !== "string" ||
    typeof (json as DiscordTokenResponse).expires_in !== "number"
  ) {
    throw new DiscordTokenExchangeError(
      "Discord token endpoint returned a malformed response body.",
      response.status,
    );
  }
  return json as DiscordTokenResponse;
}

export async function fetchDiscordIdentity(
  config: DiscordOAuthConfig,
  accessToken: string,
): Promise<DiscordUser> {
  let response: Response;
  try {
    response = await fetch(`${config.apiBaseUrl}/users/@me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    throw new DiscordIdentityFetchError(
      `Discord identity endpoint unreachable: ${(err as Error).message}`,
      0,
    );
  }

  if (!response.ok) {
    throw new DiscordIdentityFetchError(
      `Discord identity fetch failed with status ${response.status}`,
      response.status,
    );
  }

  const json: unknown = await response.json().catch(() => null);
  if (
    typeof json !== "object" ||
    json === null ||
    typeof (json as DiscordUser).id !== "string" ||
    // Snowflakes are digit-only strings, up to 64 bits (commonly 18-19
    // decimal digits) — this is checked as a STRING pattern, never by
    // parsing the value into a number (Number.MAX_SAFE_INTEGER is only
    // 16 digits; parsing a real snowflake to validate it would defeat the
    // entire point of keeping it a string). A malformed/empty id fails
    // closed here rather than silently reaching the DB layer.
    !/^\d{1,20}$/.test((json as DiscordUser).id) ||
    typeof (json as DiscordUser).username !== "string"
  ) {
    throw new DiscordIdentityFetchError(
      "Discord identity endpoint returned a malformed response body.",
      response.status,
    );
  }
  return {
    // The exact string Discord returned, untouched — never routed through
    // Number(...)/parseInt(...)/unary +/any numeric coercion anywhere in
    // this codebase's Step-04 identity path (userRepo.ts's
    // DashboardUserRow.discord_user_id doc comment has the full rationale).
    id: (json as DiscordUser).id,
    username: (json as DiscordUser).username,
    avatar: (json as { avatar?: string | null }).avatar ?? null,
  };
}

/** Refresh flow (07_DISCORD_OAUTH.md §Discord token refresh) — same endpoint, `grant_type=refresh_token`. */
export async function refreshDiscordToken(
  config: DiscordOAuthConfig,
  refreshToken: string,
): Promise<DiscordTokenResponse> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  let response: Response;
  try {
    response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (err) {
    throw new DiscordTokenExchangeError(`Discord token refresh unreachable: ${(err as Error).message}`, 0);
  }
  if (!response.ok) {
    throw new DiscordTokenExchangeError(
      `Discord token refresh failed with status ${response.status}`,
      response.status,
    );
  }
  const json: unknown = await response.json().catch(() => null);
  if (
    typeof json !== "object" ||
    json === null ||
    typeof (json as DiscordTokenResponse).access_token !== "string"
  ) {
    throw new DiscordTokenExchangeError(
      "Discord token refresh returned a malformed response body.",
      response.status,
    );
  }
  return json as DiscordTokenResponse;
}
