/**
 * A controlled, local, real HTTP test double for Bunny OCR's real
 * `GET /internal/guilds/{guild_id}/channels` (Step 10 correction round,
 * Gap 2 — mirrors `discordTestDouble.ts`'s own established convention of a
 * real local HTTP server rather than a mocked `fetch`, per
 * 31_TEST_STRATEGY.md's "acceptable to use a controlled local HTTP test
 * double for deterministic protocol/error testing").
 *
 * Default behavior is DELIBERATELY permissive: any guild id with no explicit
 * `channelsByGuild` entry gets `defaultChannels` — a synthetic catalog
 * covering the "500000000000000NNN" snowflake numbering convention this
 * whole test SUITE already uses for channel ids (`routes.test.ts` predates
 * Gap 2 and has dozens of hardcoded channel-id literals in exactly this
 * range) — so every EXISTING test that saves a channel section keeps working
 * unchanged, with no per-test registration needed. A test that specifically
 * needs to prove the "channel does not exist" or "Bunny unreachable/error"
 * paths registers an explicit (possibly empty) `channelsByGuild` entry, sets
 * `forcedStatus`, or points `config.bunnyInternalApi.baseUrl` at a closed
 * port entirely (for a genuine `UNREACHABLE`, not just a non-200 status).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface BunnyChannelFixture {
  id: string;
  name: string;
  position: number;
  type: string;
  can_read_history: boolean;
  can_view_channel: boolean;
  can_send_messages: boolean;
}

/** Step 10 external-review Phase 2, Section 13 — the role-catalog sibling endpoint's fixture shape (already-merged `origin/V2.0` contract, unmodified by this correction round). */
export interface BunnyRoleFixture {
  id: string;
  name: string;
  color: number;
  position: number;
  managed: boolean;
  mentionable: boolean;
  hoist: boolean;
}

export interface BunnyInternalApiTestDoubleState {
  /** The bearer token this double accepts — tests configure `config.bunnyInternalApi.token` to match. */
  token: string;
  channelsByGuild: Map<string, BunnyChannelFixture[]>;
  defaultChannels: BunnyChannelFixture[];
  rolesByGuild: Map<string, BunnyRoleFixture[]>;
  defaultRoles: BunnyRoleFixture[];
  /** When set, overrides the response status/body UNCONDITIONALLY (ignores auth/guild lookup entirely) — simulates a non-200 upstream error or a malformed 200 body. Applies to BOTH the channel and role catalog endpoints, matching a real Bunny instance being genuinely down for everything at once. */
  forcedStatus: number | undefined;
  forcedBody: unknown;
}

export interface BunnyInternalApiTestDouble {
  baseUrl: string;
  state: BunnyInternalApiTestDoubleState;
  close(): Promise<void>;
}

/** Synthetic default catalog: one channel entry per id in this suite's own "500000000000000NNN" numbering convention, NNN from 1 to 200 — comfortably covers every literal channel id this test suite uses anywhere, present or future, without per-test registration. */
function buildDefaultChannels(): BunnyChannelFixture[] {
  const channels: BunnyChannelFixture[] = [];
  for (let n = 1; n <= 200; n += 1) {
    const id = `50000000000000${String(n).padStart(4, "0")}`;
    channels.push({
      id,
      name: `test-channel-${n}`,
      position: n,
      type: "text",
      can_read_history: true,
      can_view_channel: true,
      can_send_messages: true,
    });
  }
  return channels;
}

/** Synthetic default role catalog: one entry per id in the same "500000000000000NNN" numbering convention, distinct from channel ids only by starting at a different base so a test can never confuse a default role id for a default channel id. */
function buildDefaultRoles(): BunnyRoleFixture[] {
  const roles: BunnyRoleFixture[] = [];
  for (let n = 1; n <= 50; n += 1) {
    const id = `60000000000000${String(n).padStart(4, "0")}`;
    roles.push({
      id,
      name: `test-role-${n}`,
      color: 0,
      position: n,
      managed: false,
      mentionable: true,
      hoist: false,
    });
  }
  return roles;
}

export async function startBunnyInternalApiTestDouble(
  token = "test-bunny-internal-api-token",
): Promise<BunnyInternalApiTestDouble> {
  const state: BunnyInternalApiTestDoubleState = {
    token,
    channelsByGuild: new Map(),
    defaultChannels: buildDefaultChannels(),
    rolesByGuild: new Map(),
    defaultRoles: buildDefaultRoles(),
    forcedStatus: undefined,
    forcedBody: undefined,
  };

  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    const channelsMatch = /^\/internal\/guilds\/([^/]+)\/channels$/.exec(url);
    const rolesMatch = /^\/internal\/guilds\/([^/]+)\/roles$/.exec(url);
    const match = channelsMatch ?? rolesMatch;

    if (!match || req.method !== "GET") {
      res.writeHead(404);
      res.end();
      return;
    }

    if (state.forcedStatus !== undefined) {
      res.writeHead(state.forcedStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state.forcedBody ?? { error: "forced_test_failure" }));
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${state.token}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const guildId = decodeURIComponent(match[1]!);
    if (!/^\d+$/.test(guildId)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_guild_id" }));
      return;
    }

    if (channelsMatch) {
      const channels = state.channelsByGuild.get(guildId) ?? state.defaultChannels;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ guild_id: guildId, channels }));
      return;
    }

    const roles = state.rolesByGuild.get(guildId) ?? state.defaultRoles;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ guild_id: guildId, roles }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    state,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
