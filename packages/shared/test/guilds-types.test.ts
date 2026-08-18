// EXTERNAL REVIEW FINDING 2 — Step 06's shared Zod schemas
// (`packages/shared/src/types/guilds.ts`). Proves the schemas themselves
// are correct in isolation; `apps/api/test/guilds/routes.test.ts` proves
// they're actually wired into the real routes.
import { describe, expect, it } from "vitest";
import {
  discordSnowflakeSchema,
  guildIdParamSchema,
  favoriteRequestSchema,
  homeVisibilityRequestSchema,
  guildPreferenceResponseSchema,
  guildListEntrySchema,
  guildListResponseSchema,
  guildOverviewResponseSchema,
} from "../src/types/guilds.js";

describe("discordSnowflakeSchema", () => {
  it("accepts a real-shaped 19-digit snowflake, past Number.MAX_SAFE_INTEGER", () => {
    const result = discordSnowflakeSchema.safeParse("9223372036854775807");
    expect(result.success).toBe(true);
    if (result.success) {
      // Never coerced to a number — must stay the exact string.
      expect(result.data).toBe("9223372036854775807");
      expect(typeof result.data).toBe("string");
    }
  });

  it.each([
    ["too short (14 digits)", "12345678901234"],
    ["too long (21 digits)", "123456789012345678901"],
    ["contains letters", "12345678901234abc"],
    ["empty string", ""],
    ["SQL-injection-shaped garbage", "'; DROP TABLE guilds; --"],
    ["a JSON number, not a string shape at all", "1.5"],
  ])("rejects %s", (_label, value) => {
    expect(discordSnowflakeSchema.safeParse(value).success).toBe(false);
  });
});

describe("guildIdParamSchema", () => {
  it("accepts an object with exactly one valid guildId key", () => {
    expect(guildIdParamSchema.safeParse({ guildId: "111111111111111111" }).success).toBe(true);
  });

  it("rejects extra keys (.strict())", () => {
    expect(guildIdParamSchema.safeParse({ guildId: "111111111111111111", extra: "nope" }).success).toBe(
      false,
    );
  });

  it("rejects a missing guildId", () => {
    expect(guildIdParamSchema.safeParse({}).success).toBe(false);
  });
});

describe("favoriteRequestSchema / homeVisibilityRequestSchema", () => {
  it("accepts the documented boolean body shape", () => {
    expect(favoriteRequestSchema.safeParse({ isFavorite: true }).success).toBe(true);
    expect(homeVisibilityRequestSchema.safeParse({ homeVisible: false }).success).toBe(true);
  });

  it.each([{ isFavorite: "yes" }, { isFavorite: 1 }, { isFavorite: null }, {}])(
    "rejects a non-boolean isFavorite body %j",
    (body) => {
      expect(favoriteRequestSchema.safeParse(body).success).toBe(false);
    },
  );

  it("rejects extra keys (.strict())", () => {
    expect(favoriteRequestSchema.safeParse({ isFavorite: true, extra: 1 }).success).toBe(false);
  });
});

describe("guildPreferenceResponseSchema — the REAL shape of POST .../favorite and PATCH .../home-visibility", () => {
  it("accepts the real backend response shape (never GuildListEntry's extra fields)", () => {
    const result = guildPreferenceResponseSchema.safeParse({
      guildId: "111111111111111111",
      isFavorite: true,
      favoritedAt: "2026-08-18T00:00:00.000Z",
      homeVisible: false,
      lastUsedAt: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a GuildListEntry-shaped payload — proves the two are genuinely distinct contracts, not accidentally compatible", () => {
    const guildListEntryShaped = {
      guildId: "111111111111111111",
      name: "Alpha",
      icon: null,
      botPresent: true,
      enabled: true,
      isOwner: false,
      canAdminister: false,
      isFavorite: true,
      favoritedAt: null,
      homeVisible: true,
      lastUsedAt: null,
    };
    expect(guildPreferenceResponseSchema.safeParse(guildListEntryShaped).success).toBe(false);
  });
});

describe("guildListEntrySchema / guildListResponseSchema", () => {
  const entry = {
    guildId: "111111111111111111",
    name: "Alpha Guild",
    icon: null,
    botPresent: true,
    enabled: true,
    isOwner: false,
    canAdminister: false,
    isFavorite: false,
    favoritedAt: null,
    homeVisible: false,
    lastUsedAt: null,
  };

  it("accepts a full real-shaped entry and list response", () => {
    expect(guildListEntrySchema.safeParse(entry).success).toBe(true);
    expect(
      guildListResponseSchema.safeParse({
        guilds: [entry],
        inviteEligibleGuilds: [],
        canInviteBunnyAnywhere: false,
        inviteUrl: "https://discord.com/oauth2/authorize?client_id=x&scope=bot",
      }).success,
    ).toBe(true);
  });

  it("rejects an entry missing a required field", () => {
    const withoutCanAdminister: Partial<typeof entry> = { ...entry };
    delete withoutCanAdminister.canAdminister;
    expect(guildListEntrySchema.safeParse(withoutCanAdminister).success).toBe(false);
  });
});

describe("guildOverviewResponseSchema", () => {
  it("accepts every real tier value", () => {
    for (const tier of ["USER", "GUILD_ADMIN", "SUPERADMIN"] as const) {
      expect(
        guildOverviewResponseSchema.safeParse({
          guildId: "111111111111111111",
          tier,
          botPresent: true,
          enabled: true,
          displayName: "Alpha",
        }).success,
      ).toBe(true);
    }
  });

  it("rejects an invalid tier value", () => {
    expect(
      guildOverviewResponseSchema.safeParse({
        guildId: "111111111111111111",
        tier: "OWNER", // not a real tier
        botPresent: true,
        enabled: true,
        displayName: "Alpha",
      }).success,
    ).toBe(false);
  });
});
