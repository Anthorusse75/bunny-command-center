import { describe, expect, it } from "vitest";
import { buildAuthorizeUrl } from "../../src/auth/discordClient.js";
import type { DiscordOAuthConfig } from "../../src/config.js";

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
