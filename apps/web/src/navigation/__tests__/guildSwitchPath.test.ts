// 03_INFORMATION_ARCHITECTURE.md §Inter-guild navigation: "Switching guilds
// preserves the current domain." Pure-function unit coverage — both the
// desktop `GuildSwitcher` and mobile `GuildPickerSheet` call this SAME
// function, so this test file is the one place the rule itself is proven.
import { describe, expect, it } from "vitest";
import { buildGuildSwitchPath } from "../guildSwitchPath.js";

describe("buildGuildSwitchPath", () => {
  it("preserves the sub-path when switching guild on a guild-scoped screen (leaderboard)", () => {
    expect(buildGuildSwitchPath("/guild/111/leaderboard", "222")).toBe("/guild/222/leaderboard");
  });

  it("preserves a deeper sub-path (admin)", () => {
    expect(buildGuildSwitchPath("/guild/111/admin", "222")).toBe("/guild/222/admin");
  });

  it("preserves the overview route itself (no sub-path)", () => {
    expect(buildGuildSwitchPath("/guild/111", "222")).toBe("/guild/222");
  });

  it("falls back to the new guild's overview when NOT currently on a guild-scoped screen (never bounces to Home)", () => {
    expect(buildGuildSwitchPath("/", "222")).toBe("/guild/222");
    expect(buildGuildSwitchPath("/upload", "222")).toBe("/guild/222");
    expect(buildGuildSwitchPath("/contributions", "222")).toBe("/guild/222");
  });

  it("never matches a path that merely starts with /guild without a real segment boundary", () => {
    expect(buildGuildSwitchPath("/guildsomething", "222")).toBe("/guild/222");
  });
});
