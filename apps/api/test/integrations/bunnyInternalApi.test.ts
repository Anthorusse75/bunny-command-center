/**
 * Unit tests for `apps/api/src/integrations/bunnyInternalApi.ts` (Step 10
 * correction round, Gap 2). Bunny is a genuine external-service boundary
 * (not a database), so mocking it here via a real local HTTP test double
 * (`bunnyInternalApiTestDouble.ts`, mirroring `discordTestDouble.ts`'s own
 * established convention) is legitimate — this repo's "no mocked DB" rule
 * does not forbid mocking a real external HTTP dependency
 * (31_TEST_STRATEGY.md).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/config.js";
import { fetchGuildChannelCatalog } from "../../src/integrations/bunnyInternalApi.js";
import {
  startBunnyInternalApiTestDouble,
  type BunnyInternalApiTestDouble,
} from "../helpers/bunnyInternalApiTestDouble.js";

function baseConfig(bunnyInternalApi?: AppConfig["bunnyInternalApi"]): AppConfig {
  return {
    port: 0,
    logLevel: "silent",
    appVersion: "test",
    db: { host: "127.0.0.1", port: 3306, user: "x", password: "x", database: "x" },
    sse: {
      heartbeatSeconds: 15,
      pollIntervalMs: 3000,
      maxQueuedFramesPerConnection: 200,
      maxRowsPerSourcePerTick: 500,
    },
    discord: {
      clientId: "x",
      clientSecret: "x",
      redirectUri: "http://localhost/callback",
      scope: "identify guilds guilds.members.read",
      authorizeBaseUrl: "http://127.0.0.1:0",
      tokenUrl: "http://127.0.0.1:0",
      apiBaseUrl: "http://127.0.0.1:0",
    },
    session: {
      cookieName: "bcc_session",
      transactionCookieName: "bcc_oauth_txn",
      transactionSigningKey: Buffer.alloc(32, 0x11),
      tokenEncryptionKey: Buffer.alloc(32, 0x22),
      slidingTtlMs: 1000,
      absoluteTtlMs: 1000,
      sweepIntervalMs: 1000,
    },
    superadmin: { discordUserId: "900000000000000001" },
    ...(bunnyInternalApi ? { bunnyInternalApi } : {}),
  };
}

describe("fetchGuildChannelCatalog (Bunny internal API client)", () => {
  let bunny: BunnyInternalApiTestDouble;

  beforeAll(async () => {
    bunny = await startBunnyInternalApiTestDouble();
  });

  afterAll(async () => {
    await bunny.close();
  });

  it("returns NOT_CONFIGURED when no bunnyInternalApi config is set on this Dashboard instance", async () => {
    const result = await fetchGuildChannelCatalog(baseConfig(undefined), "600000000000000001");
    expect(result).toEqual({ ok: false, reason: "NOT_CONFIGURED" });
  });

  it("returns the real, parsed channel catalog on a genuine 200 success", async () => {
    bunny.state.channelsByGuild.set("600000000000000002", [
      { id: "500000000000000001", name: "incoming", position: 0, type: "text", can_read_history: true },
      { id: "500000000000000002", name: "hero", position: 1, type: "text", can_read_history: false },
    ]);
    const config = baseConfig({ baseUrl: bunny.baseUrl, token: bunny.state.token });
    const result = await fetchGuildChannelCatalog(config, "600000000000000002");
    expect(result).toEqual({
      ok: true,
      channels: [
        { id: "500000000000000001", name: "incoming", position: 0, type: "text", canReadHistory: true },
        { id: "500000000000000002", name: "hero", position: 1, type: "text", canReadHistory: false },
      ],
    });
  });

  it("returns UNREACHABLE when Bunny cannot be reached at all (connection refused)", async () => {
    // Port 1 is a real, syntactically valid port nothing listens on — a
    // genuine network-level failure, not a forced HTTP status.
    const config = baseConfig({ baseUrl: "http://127.0.0.1:1", token: "irrelevant" });
    const result = await fetchGuildChannelCatalog(config, "600000000000000003");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("UNREACHABLE");
    }
  });

  it("returns GUILD_NOT_FOUND on a real 404 (Bunny is not a member of the guild)", async () => {
    bunny.state.forcedStatus = 404;
    try {
      const config = baseConfig({ baseUrl: bunny.baseUrl, token: bunny.state.token });
      const result = await fetchGuildChannelCatalog(config, "600000000000000004");
      expect(result).toEqual({ ok: false, reason: "GUILD_NOT_FOUND" });
    } finally {
      bunny.state.forcedStatus = undefined;
    }
  });

  it("returns UPSTREAM_ERROR with the real status on a non-200/404 response (401/503/502)", async () => {
    for (const status of [401, 502, 503]) {
      bunny.state.forcedStatus = status;
      try {
        const config = baseConfig({ baseUrl: bunny.baseUrl, token: bunny.state.token });
        const result = await fetchGuildChannelCatalog(config, "600000000000000005");
        expect(result).toEqual({ ok: false, reason: "UPSTREAM_ERROR", status });
      } finally {
        bunny.state.forcedStatus = undefined;
      }
    }
  });

  it("returns MALFORMED_RESPONSE when the 200 body doesn't match the documented contract", async () => {
    bunny.state.forcedStatus = 200;
    bunny.state.forcedBody = { totally: "not the right shape" };
    try {
      const config = baseConfig({ baseUrl: bunny.baseUrl, token: bunny.state.token });
      const result = await fetchGuildChannelCatalog(config, "600000000000000006");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("MALFORMED_RESPONSE");
      }
    } finally {
      bunny.state.forcedStatus = undefined;
      bunny.state.forcedBody = undefined;
    }
  });

  it("returns MALFORMED_RESPONSE when a channel entry is missing a required field", async () => {
    bunny.state.forcedStatus = 200;
    bunny.state.forcedBody = {
      guild_id: "600000000000000007",
      channels: [{ id: "500000000000000001", name: "incoming" /* missing position/type/can_read_history */ }],
    };
    try {
      const config = baseConfig({ baseUrl: bunny.baseUrl, token: bunny.state.token });
      const result = await fetchGuildChannelCatalog(config, "600000000000000007");
      expect(result.ok).toBe(false);
      if (!result.ok && result.reason === "MALFORMED_RESPONSE") {
        expect(result.detail).toContain("did not match");
      } else {
        expect.fail(`expected MALFORMED_RESPONSE, got ${JSON.stringify(result)}`);
      }
    } finally {
      bunny.state.forcedStatus = undefined;
      bunny.state.forcedBody = undefined;
    }
  });
});
