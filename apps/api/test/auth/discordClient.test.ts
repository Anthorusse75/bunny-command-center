import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  refreshDiscordToken,
  DiscordTokenExchangeError,
} from "../../src/auth/discordClient.js";
import type { DiscordOAuthConfig } from "../../src/config.js";
import { startDiscordTestDouble, type DiscordTestDouble } from "../helpers/discordTestDouble.js";

function testDiscordConfig(overrides: Partial<DiscordOAuthConfig> = {}): DiscordOAuthConfig {
  return {
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    redirectUri: "http://127.0.0.1/api/auth/callback",
    scope: "identify guilds guilds.members.read",
    authorizeBaseUrl: "https://discord.com/oauth2/authorize",
    tokenUrl: "https://discord.com/api/oauth2/token",
    apiBaseUrl: "https://discord.com/api",
    ...overrides,
  };
}

describe("buildAuthorizeUrl", () => {
  it("carries client_id, redirect_uri, response_type, scope, state and the S256 code_challenge", () => {
    const url = new URL(
      buildAuthorizeUrl(testDiscordConfig(), { state: "the-state", codeChallenge: "the-challenge" }),
    );
    expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1/api/auth/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("identify guilds guilds.members.read");
    expect(url.searchParams.get("state")).toBe("the-state");
    expect(url.searchParams.get("code_challenge")).toBe("the-challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  // Copilot review finding 4 (Step 04 review pass): `prompt=consent`
  // unconditionally forced re-consent on every login, contradicting this
  // project's own "consent shown only once" design intent for the
  // `guilds`/`guilds.members.read` scope grant. Discord's own docs
  // (docs.discord.com/developers/topics/oauth2) confirm `prompt=consent`
  // forces reapproval even for a user who already granted the identical
  // scopes; omitting `prompt` entirely lets Discord apply its own default
  // (skip consent for a returning user with a matching existing grant).
  it("never sends a prompt parameter — never forces repeated consent for a user who already granted these scopes", () => {
    const url = new URL(buildAuthorizeUrl(testDiscordConfig(), { state: "s", codeChallenge: "c" }));
    expect(url.searchParams.has("prompt")).toBe(false);
  });
});

/**
 * External-review Finding 2: `refreshDiscordToken` previously accepted any
 * HTTP 200 whose body merely had a string `access_token`, then cast the
 * rest of the body to `DiscordTokenResponse` unchecked -- a malformed
 * `expires_in` (missing, wrong type, non-finite, <= 0) could reach
 * `DiscordTokenService.doRefresh`'s `tokenExpiresAt` computation and
 * produce an Invalid Date instead of a controlled refresh-error path. This
 * suite proves the hardened validation directly against the real local
 * Discord test double (a genuine HTTP round trip, not a hand-built object).
 */
describe("refreshDiscordToken — response validation (external-review Finding 2)", () => {
  let discord: DiscordTestDouble;

  beforeEach(async () => {
    discord = await startDiscordTestDouble();
  });
  afterEach(async () => {
    await discord.close();
  });

  function config(): DiscordOAuthConfig {
    return testDiscordConfig({
      authorizeBaseUrl: discord.baseUrl,
      tokenUrl: discord.tokenUrl,
      apiBaseUrl: discord.apiBaseUrl,
    });
  }

  it("A. HTTP 200 missing expires_in is rejected with a DiscordTokenExchangeError", async () => {
    discord.state.refreshSuccessBodyOverride = { access_token: "foo" };
    await expect(refreshDiscordToken(config(), "some-refresh-token")).rejects.toBeInstanceOf(
      DiscordTokenExchangeError,
    );
  });

  const malformedExpiresIn: Array<{ label: string; value: unknown }> = [
    { label: "string instead of number", value: "604800" },
    { label: "NaN", value: Number.NaN },
    { label: "Infinity", value: Number.POSITIVE_INFINITY },
    { label: "zero", value: 0 },
    { label: "negative", value: -604800 },
    { label: "null", value: null },
  ];
  for (const { label, value } of malformedExpiresIn) {
    it(`B. HTTP 200 with an invalid expires_in (${label}) is rejected`, async () => {
      discord.state.refreshSuccessBodyOverride = { access_token: "foo", expires_in: value };
      await expect(refreshDiscordToken(config(), "some-refresh-token")).rejects.toBeInstanceOf(
        DiscordTokenExchangeError,
      );
    });
  }

  const malformedRefreshToken: Array<{ label: string; value: unknown }> = [
    { label: "empty string", value: "" },
    { label: "a number", value: 12345 },
    { label: "null", value: null },
  ];
  for (const { label, value } of malformedRefreshToken) {
    it(`C. HTTP 200 with a present-but-malformed refresh_token (${label}) is rejected`, async () => {
      discord.state.refreshSuccessBodyOverride = {
        access_token: "foo",
        expires_in: 604800,
        refresh_token: value,
      };
      await expect(refreshDiscordToken(config(), "some-refresh-token")).rejects.toBeInstanceOf(
        DiscordTokenExchangeError,
      );
    });
  }

  it("D. a valid response WITH a rotated refresh_token succeeds and carries it through", async () => {
    discord.state.nextRefreshAccessToken = "fresh-access-token";
    discord.state.nextRefreshRefreshToken = "rotated-refresh-token";
    const result = await refreshDiscordToken(config(), "some-refresh-token");
    expect(result.access_token).toBe("fresh-access-token");
    expect(result.refresh_token).toBe("rotated-refresh-token");
    expect(result.expires_in).toBeGreaterThan(0);
  });

  it("E. a valid response with NO new refresh_token succeeds, returning an empty string (the documented 'not rotated' signal DiscordTokenService.doRefresh's fallback relies on)", async () => {
    discord.state.nextRefreshAccessToken = "fresh-access-token";
    discord.state.nextRefreshRefreshToken = null; // field omitted entirely
    const result = await refreshDiscordToken(config(), "some-refresh-token");
    expect(result.access_token).toBe("fresh-access-token");
    expect(result.refresh_token).toBe("");
  });

  it("a genuinely malformed body never reaches the caller as a usable DiscordTokenResponse (no NaN/Invalid-Date-shaped value slips through)", async () => {
    discord.state.refreshSuccessBodyOverride = { access_token: "foo", expires_in: "not-a-number" };
    try {
      await refreshDiscordToken(config(), "some-refresh-token");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DiscordTokenExchangeError);
      // The error message itself never embeds the refresh token used.
      expect((err as Error).message).not.toContain("some-refresh-token");
    }
  });
});
