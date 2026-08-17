/**
 * 08_AUTHORIZATION_AND_RBAC.md §Permission freshness / D-070, this step's
 * spec: "cache keys MUST include at least: dashboard user identity, guild
 * ID, relevant authorization input/source; never share a decision between
 * users; never share a decision between guilds; expiration must be
 * explicit; provide explicit invalidation."
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GuildAuthCache, guildsListCacheKey, guildMemberCacheKey } from "../../src/auth/guildAuthCache.js";

describe("GuildAuthCache", () => {
  it("returns undefined for a never-set key", () => {
    const cache = new GuildAuthCache(60_000, () => 0);
    expect(cache.get(guildsListCacheKey("u1"))).toBeUndefined();
  });

  it("returns the stored value before expiry", () => {
    const cache = new GuildAuthCache(60_000, () => 0);
    cache.set(guildsListCacheKey("u1"), ["guildA"]);
    expect(cache.get(guildsListCacheKey("u1"))).toEqual(["guildA"]);
  });

  it("expires explicitly at the configured TTL — not a moment before or after", () => {
    let now = 0;
    const cache = new GuildAuthCache(60_000, () => now);
    cache.set(guildsListCacheKey("u1"), "value");
    now = 59_999;
    expect(cache.get(guildsListCacheKey("u1"))).toBe("value");
    now = 60_000;
    expect(cache.get(guildsListCacheKey("u1"))).toBeUndefined();
  });

  it("never shares a decision between two different users, even for the identical guild/source", () => {
    const cache = new GuildAuthCache(60_000, () => 0);
    cache.set(guildMemberCacheKey("userA", "guild1"), ["role-x"]);
    expect(cache.get(guildMemberCacheKey("userB", "guild1"))).toBeUndefined();
  });

  it("never shares a decision between two different guilds for the SAME user (guild-member source)", () => {
    const cache = new GuildAuthCache(60_000, () => 0);
    cache.set(guildMemberCacheKey("userA", "guild1"), ["role-x"]);
    expect(cache.get(guildMemberCacheKey("userA", "guild2"))).toBeUndefined();
  });

  it("the guild-LIST source is cached per-user (guild-independent by design — one Discord call covers every guild), documented and tested explicitly", () => {
    const cache = new GuildAuthCache(60_000, () => 0);
    cache.set(guildsListCacheKey("userA"), ["guild1", "guild2"]);
    // Same cache entry regardless of which guild is being checked against it.
    expect(cache.get(guildsListCacheKey("userA"))).toEqual(["guild1", "guild2"]);
  });

  it("invalidate() removes exactly the targeted entry, never any other", () => {
    const cache = new GuildAuthCache(60_000, () => 0);
    cache.set(guildsListCacheKey("userA"), "list-A");
    cache.set(guildMemberCacheKey("userA", "guild1"), "member-A-1");
    cache.set(guildMemberCacheKey("userB", "guild1"), "member-B-1");

    cache.invalidate(guildMemberCacheKey("userA", "guild1"));

    expect(cache.get(guildMemberCacheKey("userA", "guild1"))).toBeUndefined();
    expect(cache.get(guildsListCacheKey("userA"))).toBe("list-A");
    expect(cache.get(guildMemberCacheKey("userB", "guild1"))).toBe("member-B-1");
  });

  it("invalidateUserGuild() clears both sources for that (user, guild) pair, and no other user/guild", () => {
    const cache = new GuildAuthCache(60_000, () => 0);
    cache.set(guildsListCacheKey("userA"), "list-A");
    cache.set(guildMemberCacheKey("userA", "guild1"), "member-A-1");
    cache.set(guildsListCacheKey("userB"), "list-B");
    cache.set(guildMemberCacheKey("userB", "guild1"), "member-B-1");

    cache.invalidateUserGuild("userA", "guild1");

    expect(cache.get(guildsListCacheKey("userA"))).toBeUndefined();
    expect(cache.get(guildMemberCacheKey("userA", "guild1"))).toBeUndefined();
    expect(cache.get(guildsListCacheKey("userB"))).toBe("list-B");
    expect(cache.get(guildMemberCacheKey("userB", "guild1"))).toBe("member-B-1");
  });

  it("the U+0000 key separator prevents a cross-component collision a plain join without a separator could otherwise produce", () => {
    const cache = new GuildAuthCache(60_000, () => 0);
    // Without ANY separator, discordUserId="12"+guildId="34" would
    // concatenate to the exact same raw string as discordUserId="1"+
    // guildId="234" ("1234" either way) -- two genuinely different callers
    // colliding onto one cached authorization decision. The real key
    // function must keep these fully distinct.
    cache.set(guildMemberCacheKey("12", "34"), "decision-for-user-12-guild-34");
    cache.set(guildMemberCacheKey("1", "234"), "decision-for-user-1-guild-234");

    expect(cache.get(guildMemberCacheKey("12", "34"))).toBe("decision-for-user-12-guild-34");
    expect(cache.get(guildMemberCacheKey("1", "234"))).toBe("decision-for-user-1-guild-234");
  });

  it("source hygiene regression: guildAuthCache.ts's own source file contains no literal NUL (0x00) byte, so Git always treats it as a normal text file", () => {
    const filePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "src",
      "auth",
      "guildAuthCache.ts",
    );
    const raw = readFileSync(filePath);
    expect(raw.includes(0x00)).toBe(false);
  });
});
