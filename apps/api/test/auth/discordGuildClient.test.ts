import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startDiscordTestDouble, type DiscordTestDouble } from "../helpers/discordTestDouble.js";
import {
  fetchUserGuilds,
  fetchGuildMember,
  hasAdministratorPermission,
  isDiscordUnauthorized,
  DiscordGuildFetchError,
} from "../../src/auth/discordGuildClient.js";

const DISCORD_ADMINISTRATOR_BIT = 0x8n;

describe("hasAdministratorPermission — BigInt-exact bitfield parsing, never Number(...)", () => {
  it("detects the ADMINISTRATOR bit set among other bits", () => {
    const value = (DISCORD_ADMINISTRATOR_BIT | 0x1n | 0x2n).toString();
    expect(hasAdministratorPermission(value)).toBe(true);
  });

  it("returns false when the bit is absent", () => {
    expect(hasAdministratorPermission("1")).toBe(false); // CREATE_INSTANT_INVITE only
    expect(hasAdministratorPermission("0")).toBe(false);
  });

  it("correctly evaluates a permission value beyond Number.MAX_SAFE_INTEGER", () => {
    // A large, real-shaped Discord permission bitmask that would lose
    // precision under Number(...) — still correctly detects the bit.
    const huge = (1n << 60n) | DISCORD_ADMINISTRATOR_BIT;
    expect(huge).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    expect(hasAdministratorPermission(huge.toString())).toBe(true);
  });

  it("fails closed (false) on a malformed, non-numeric permissions string", () => {
    expect(hasAdministratorPermission("not-a-number")).toBe(false);
    expect(hasAdministratorPermission("")).toBe(false);
  });
});

describe("discordGuildClient: fetchUserGuilds / fetchGuildMember (against the local Discord test double)", () => {
  let discord: DiscordTestDouble;

  beforeEach(async () => {
    discord = await startDiscordTestDouble();
  });
  afterEach(async () => {
    await discord.close();
  });

  function config() {
    return {
      clientId: "x",
      clientSecret: "x",
      redirectUri: "http://localhost/callback",
      scope: "identify guilds guilds.members.read",
      authorizeBaseUrl: discord.baseUrl,
      tokenUrl: discord.tokenUrl,
      apiBaseUrl: discord.apiBaseUrl,
    };
  }

  it("fetchUserGuilds returns the fixture guild list on a valid access token", async () => {
    discord.state.guilds = [
      { id: "111111111111111111", owner: true, permissions: "8" },
      { id: "222222222222222222", owner: false, permissions: "0" },
    ];
    const guilds = await fetchUserGuilds(config(), discord.state.currentAccessToken);
    expect(guilds).toEqual(discord.state.guilds);
  });

  it("fetchUserGuilds throws a status-401 DiscordGuildFetchError for a stale/invalid token", async () => {
    discord.state.guilds = [{ id: "1", owner: false, permissions: "0" }];
    await expect(fetchUserGuilds(config(), "stale-token")).rejects.toMatchObject({
      name: "DiscordGuildFetchError",
      status: 401,
    });
  });

  it("isDiscordUnauthorized correctly narrows only a real 401 DiscordGuildFetchError", async () => {
    try {
      await fetchUserGuilds(config(), "stale-token");
      expect.unreachable();
    } catch (err) {
      expect(isDiscordUnauthorized(err)).toBe(true);
    }
    discord.state.guildsForcedStatus = 500;
    try {
      await fetchUserGuilds(config(), discord.state.currentAccessToken);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DiscordGuildFetchError);
      expect(isDiscordUnauthorized(err)).toBe(false); // 500, not 401
    }
  });

  it("fetchGuildMember returns the fixture roles array for a valid token", async () => {
    discord.state.memberRolesByGuild.set("111111111111111111", ["role-a", "role-b"]);
    const member = await fetchGuildMember(config(), discord.state.currentAccessToken, "111111111111111111");
    expect(member.roles).toEqual(["role-a", "role-b"]);
  });

  it("fetchGuildMember returns an empty roles array for a guild with no configured fixture", async () => {
    const member = await fetchGuildMember(config(), discord.state.currentAccessToken, "999999999999999999");
    expect(member.roles).toEqual([]);
  });

  it("fetchGuildMember throws a status-401 DiscordGuildFetchError for a stale token", async () => {
    await expect(fetchGuildMember(config(), "stale-token", "111111111111111111")).rejects.toMatchObject({
      status: 401,
    });
  });
});
