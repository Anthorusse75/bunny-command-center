import { describe, expect, it } from "vitest";
import { resolveRequestedBy } from "../../src/notifications/requestedBy.js";

const config = { superadmin: { discordUserId: "900000000000000001" } };

describe("resolveRequestedBy — ADR-013 corrected 2026-08-11, second pass", () => {
  it("human-triggered: uses the real acting user's Discord snowflake, defaulting role to USER", () => {
    const result = resolveRequestedBy(config, { discordUserId: "111111111111111111" });
    expect(result).toEqual({ discordUserId: "111111111111111111", role: "USER" });
  });

  it("human-triggered: honors an explicit role when the caller supplies one", () => {
    const result = resolveRequestedBy(config, { discordUserId: "111111111111111111", role: "GUILD_ADMIN" });
    expect(result).toEqual({ discordUserId: "111111111111111111", role: "GUILD_ADMIN" });
  });

  it("system-generated (no human actor): uses PLATFORM_SUPERADMIN_DISCORD_ID with role SYSTEM", () => {
    const result = resolveRequestedBy(config, undefined);
    expect(result).toEqual({ discordUserId: "900000000000000001", role: "SYSTEM" });
  });

  it("is deterministic across repeated calls for the SAME logical trigger (idempotency requirement)", () => {
    const a = resolveRequestedBy(config, undefined);
    const b = resolveRequestedBy(config, undefined);
    expect(a).toEqual(b);
    const c = resolveRequestedBy(config, { discordUserId: "222222222222222222" });
    const d = resolveRequestedBy(config, { discordUserId: "222222222222222222" });
    expect(c).toEqual(d);
  });
});
