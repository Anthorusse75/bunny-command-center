// Shared test-only helpers for the Step 06 multi-guild E2E suite
// (multi-guild.spec.ts, multi-guild-mobile.spec.ts). A plain helper module,
// not a spec file itself — Playwright forbids one spec file importing
// another directly.
import { expect, type Page } from "@playwright/test";

export interface GuildFixture {
  id: string;
  owner: boolean;
  permissions: string;
  name: string;
}

let guildCounter = 0;
export function guildId(): string {
  guildCounter += 1;
  return `77700000000000${String(guildCounter).padStart(4, "0")}`;
}

export async function seedGuild(page: Page, id: string, displayName: string, enabled = true): Promise<void> {
  const res = await page.request.get("/api/__test__/seed-guild", {
    params: { guildId: id, displayName, enabled: String(enabled) },
  });
  expect(res.ok()).toBe(true);
}

export async function loginAs(page: Page, discordUserId: string, guilds: GuildFixture[]): Promise<void> {
  await page.goto(
    `/api/__test__/login?discordUserId=${encodeURIComponent(discordUserId)}&guilds=${encodeURIComponent(
      JSON.stringify(guilds),
    )}`,
  );
}

let userCounter = 800000000000000000n;
export function freshDiscordUserId(): string {
  userCounter += 1n;
  return userCounter.toString();
}
