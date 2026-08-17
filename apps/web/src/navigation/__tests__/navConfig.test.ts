// D-018 / 03_INFORMATION_ARCHITECTURE.md §Mobile navigation: "≤5
// destinations" — a hard cap, tested directly against the exported list so
// a future addition can't silently blow past it. Also covers the
// conditional Guild-Admin/Superadmin visibility rules both SidebarNav and
// MoreSheet rely on.
import { describe, expect, it } from "vitest";
import { BOTTOM_NAV_ITEMS, moreMenuItems, sidebarGroups, NAV_ITEMS, type NavContext } from "../navConfig.js";

const baseCtx: NavContext = { defaultGuildId: undefined, overview: undefined, isSuperadmin: false };

describe("BOTTOM_NAV_ITEMS", () => {
  it("has exactly 5 entries (Home, Upload, Guild, Leaderboard, + More is rendered separately)", () => {
    expect(BOTTOM_NAV_ITEMS).toHaveLength(4);
    expect(BOTTOM_NAV_ITEMS.map((i) => i.key)).toEqual(["home", "upload", "guild", "leaderboard"]);
  });

  it("with the fixed 'More' slot, the mobile bottom nav never exceeds 5 total destinations", () => {
    expect(BOTTOM_NAV_ITEMS.length + 1).toBeLessThanOrEqual(5);
  });
});

describe("navConfig visibility rules", () => {
  it("Onboarding/Guild Admin/Technical are hidden with no guild context", () => {
    const items = moreMenuItems(baseCtx);
    expect(items.map((i) => i.key)).not.toContain("onboarding");
    expect(items.map((i) => i.key)).not.toContain("guildAdmin");
    expect(items.map((i) => i.key)).not.toContain("technical");
  });

  it("Onboarding/Guild Admin/Technical show for a resolved GUILD_ADMIN tier", () => {
    const ctx: NavContext = {
      defaultGuildId: "1",
      overview: { guildId: "1", tier: "GUILD_ADMIN", botPresent: true, enabled: true, displayName: "G" },
      isSuperadmin: false,
    };
    const items = moreMenuItems(ctx);
    expect(items.map((i) => i.key)).toEqual(
      expect.arrayContaining(["onboarding", "guildAdmin", "technical"]),
    );
  });

  it("plain USER tier does NOT see Onboarding/Guild Admin (never a client-invented promotion)", () => {
    const ctx: NavContext = {
      defaultGuildId: "1",
      overview: { guildId: "1", tier: "USER", botPresent: true, enabled: true, displayName: "G" },
      isSuperadmin: false,
    };
    const items = moreMenuItems(ctx);
    expect(items.map((i) => i.key)).not.toContain("onboarding");
    expect(items.map((i) => i.key)).not.toContain("guildAdmin");
  });

  it("Superadmin/Hero Discovery only appear for isSuperadmin, independent of guild tier", () => {
    const notSuper = moreMenuItems({ ...baseCtx, isSuperadmin: false });
    expect(notSuper.map((i) => i.key)).not.toContain("superadmin");
    expect(notSuper.map((i) => i.key)).not.toContain("heroDiscovery");

    const isSuper = moreMenuItems({ ...baseCtx, isSuperadmin: true });
    expect(isSuper.map((i) => i.key)).toEqual(expect.arrayContaining(["superadmin", "heroDiscovery"]));
  });

  it("Technical is visible for Superadmin even without Guild-Admin tier in the default guild", () => {
    const ctx: NavContext = { defaultGuildId: "1", overview: undefined, isSuperadmin: true };
    expect(moreMenuItems(ctx).map((i) => i.key)).toContain("technical");
  });

  it("Guild path resolves to undefined with zero guilds — never a dead-link crash", () => {
    const guildItem = NAV_ITEMS.find((i) => i.key === "guild")!;
    expect(guildItem.path(baseCtx)).toBeUndefined();
  });

  it("sidebarGroups omits every group whose items are all invisible right now", () => {
    const groups = sidebarGroups(baseCtx);
    expect(groups.some((g) => g.group === "guildAdmin")).toBe(false);
    expect(groups.some((g) => g.group === "platform")).toBe(false);
    expect(groups.some((g) => g.group === "primary")).toBe(true);
    expect(groups.some((g) => g.group === "profile")).toBe(true);
  });
});
