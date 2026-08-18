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

// `RUN_ID` (real wall-clock load time, ms) makes IDs unique ACROSS spec
// files, not just within one — Playwright reloads this module fresh per
// spec file (confirmed empirically: a plain per-file counter restarting at
// 1 collided with `multi-guild.spec.ts`'s own guild/user #1 once both files
// ran in the same `npx playwright test` invocation), while the real E2E
// MySQL database (`bunny_cc_e2e`) persists across the WHOLE run, not per
// file. A colliding discordUserId/guildId pair silently inherits another
// test's real, already-persisted membership/preference state instead of
// starting fresh — this produced a guild missing from a picker's rendered
// list that looked like an app bug (and briefly was misdiagnosed as one)
// but was actually two unrelated tests sharing one real identity by
// accident. The per-call counter still guarantees uniqueness for calls
// within the same file/millisecond.
const RUN_ID = Date.now();

let guildCounter = 0;
export function guildId(): string {
  guildCounter += 1;
  return `777${RUN_ID}${String(guildCounter).padStart(3, "0")}`;
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

let userCounter = 0;
export function freshDiscordUserId(): string {
  userCounter += 1;
  return `800${RUN_ID}${String(userCounter).padStart(3, "0")}`;
}
