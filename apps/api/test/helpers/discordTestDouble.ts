/**
 * A controlled, local, real HTTP Discord OAuth test double
 * (31_TEST_STRATEGY.md: "acceptable to use a controlled local Discord OAuth
 * HTTP test double for deterministic protocol/error testing"). Implements
 * just enough of `POST /oauth2/token`, `GET /api/users/@me`,
 * `GET /api/users/@me/guilds`, and `GET /api/users/@me/guilds/{id}/member`
 * to drive every documented success/failure branch of
 * `apps/api/src/auth/discordClient.ts` and `discordGuildClient.ts`
 * deterministically — this is explicitly NOT proof that real Discord OAuth
 * works (see this step's HANDOVER).
 *
 * Step 05 addition: the guild-list/member endpoints validate the caller's
 * Bearer token against `state.currentAccessToken` (starting at the
 * login-granted `fake-access-token-value`) and respond 401 for any other
 * value — a real, behaviorally faithful simulation of "the access token
 * expired." `POST /oauth2/token`'s `grant_type=refresh_token` branch
 * records every refresh attempt (`receivedRefreshRequests`) and, on
 * success, advances `state.currentAccessToken` to
 * `state.nextRefreshAccessToken` — so a test can drive the FULL real
 * refresh-then-retry lifecycle end to end (a stale-token retry still 401s;
 * a correctly-refreshed-token retry succeeds) without any test-only
 * "succeed on the Nth call" flag, and `refreshExchangeStatus`/
 * `refreshExchangeBody` force the refresh call itself to fail, for the
 * refresh-failure/re-login path.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface DiscordGuildFixture {
  id: string;
  owner: boolean;
  permissions: string;
}

export interface DiscordTestDoubleState {
  /** When set, `/oauth2/token` (authorization_code grant) responds with this HTTP status and body instead of a success payload. */
  tokenExchangeStatus: number | undefined;
  tokenExchangeBody: unknown;
  /** When set, `/api/users/@me` responds with this HTTP status and body instead of a success payload. */
  identityStatus: number | undefined;
  identityBody: unknown;
  /** The `id` the success-path identity response returns — overridable so a test can drive the flow with a specific (e.g. deliberately unsafe-as-a-JS-number) Discord snowflake. */
  identityUserId: string;
  /** Records every `code`/`code_verifier` pair presented to the token endpoint, for replay assertions. */
  receivedTokenRequests: { code: string; codeVerifier: string }[];

  /** The Bearer token `/users/@me/guilds` and `/users/@me/guilds/{id}/member` currently accept — starts at the login-granted access token, advances on a successful refresh. */
  currentAccessToken: string;
  /** Guild-list fixture data (`GET /users/@me/guilds` success body). */
  guilds: DiscordGuildFixture[];
  /** Overrides the guild-list response status UNCONDITIONALLY (ignores the Bearer-token check entirely) — for simulating a non-401 failure, or a 401 that persists even after a real refresh ("repeated 401 after refresh" regression case). */
  guildsForcedStatus: number | undefined;
  guildsForcedBody: unknown;

  /** Per-guild member `roles` fixture (`GET /users/@me/guilds/{id}/member` success body). */
  memberRolesByGuild: Map<string, string[]>;
  /** Same override semantics as `guildsForcedStatus`, for the member endpoint. */
  memberForcedStatus: number | undefined;
  memberForcedBody: unknown;

  /** When set, `/oauth2/token` (refresh_token grant) responds with this HTTP status/body instead of a success payload — the refresh-failure path. */
  refreshExchangeStatus: number | undefined;
  refreshExchangeBody: unknown;
  /** The access_token a SUCCESSFUL refresh returns; also becomes the new `currentAccessToken`. */
  nextRefreshAccessToken: string;
  /** The refresh_token a successful refresh returns — `null` omits the field entirely (simulates Discord NOT rotating it, per 07_DISCORD_OAUTH.md's "if Discord rotates the refresh token" being conditional). */
  nextRefreshRefreshToken: string | null;
  /** Records every `refresh_token` value presented to the token endpoint's refresh grant, for single-flight/concurrency and replay assertions. */
  receivedRefreshRequests: { refreshToken: string }[];
}

export interface DiscordTestDouble {
  baseUrl: string;
  tokenUrl: string;
  apiBaseUrl: string;
  state: DiscordTestDoubleState;
  close(): Promise<void>;
}

const DEFAULT_LOGIN_ACCESS_TOKEN = "fake-access-token-value";

export async function startDiscordTestDouble(): Promise<DiscordTestDouble> {
  const state: DiscordTestDoubleState = {
    tokenExchangeStatus: undefined,
    tokenExchangeBody: undefined,
    identityStatus: undefined,
    identityBody: undefined,
    identityUserId: "700000000001",
    receivedTokenRequests: [],

    currentAccessToken: DEFAULT_LOGIN_ACCESS_TOKEN,
    guilds: [],
    guildsForcedStatus: undefined,
    guildsForcedBody: undefined,

    memberRolesByGuild: new Map(),
    memberForcedStatus: undefined,
    memberForcedBody: undefined,

    refreshExchangeStatus: undefined,
    refreshExchangeBody: undefined,
    nextRefreshAccessToken: "fake-refreshed-access-token-value",
    nextRefreshRefreshToken: "fake-rotated-refresh-token-value",
    receivedRefreshRequests: [],
  };

  function bearerToken(req: http.IncomingMessage): string | undefined {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return undefined;
    }
    return header.slice("Bearer ".length);
  }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      const url = req.url ?? "";
      const memberMatch = /^\/api\/users\/@me\/guilds\/([^/]+)\/member$/.exec(url);

      if (url === "/oauth2/token" && req.method === "POST") {
        const params = new URLSearchParams(body);
        const grantType = params.get("grant_type");

        if (grantType === "refresh_token") {
          const refreshToken = params.get("refresh_token") ?? "";
          state.receivedRefreshRequests.push({ refreshToken });

          if (state.refreshExchangeStatus !== undefined) {
            res.writeHead(state.refreshExchangeStatus, { "Content-Type": "application/json" });
            res.end(JSON.stringify(state.refreshExchangeBody ?? { error: "forced_refresh_failure" }));
            return;
          }
          state.currentAccessToken = state.nextRefreshAccessToken;
          const responseBody: Record<string, unknown> = {
            access_token: state.nextRefreshAccessToken,
            expires_in: 604800,
            token_type: "Bearer",
            scope: "identify guilds guilds.members.read",
          };
          if (state.nextRefreshRefreshToken !== null) {
            responseBody["refresh_token"] = state.nextRefreshRefreshToken;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(responseBody));
          return;
        }

        // authorization_code grant (login flow) — unchanged from Step 04.
        state.receivedTokenRequests.push({
          code: params.get("code") ?? "",
          codeVerifier: params.get("code_verifier") ?? "",
        });

        if (state.tokenExchangeStatus !== undefined) {
          res.writeHead(state.tokenExchangeStatus, { "Content-Type": "application/json" });
          res.end(JSON.stringify(state.tokenExchangeBody ?? { error: "forced_test_failure" }));
          return;
        }
        state.currentAccessToken = DEFAULT_LOGIN_ACCESS_TOKEN;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: DEFAULT_LOGIN_ACCESS_TOKEN,
            refresh_token: "fake-refresh-token-value",
            expires_in: 604800,
            token_type: "Bearer",
            scope: "identify guilds guilds.members.read",
          }),
        );
        return;
      }

      if (url === "/api/users/@me" && req.method === "GET") {
        if (state.identityStatus !== undefined) {
          res.writeHead(state.identityStatus, { "Content-Type": "application/json" });
          res.end(JSON.stringify(state.identityBody ?? { message: "forced test failure" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ id: state.identityUserId, username: "TestDiscordUser", avatar: "abc123hash" }),
        );
        return;
      }

      if (url === "/api/users/@me/guilds" && req.method === "GET") {
        if (state.guildsForcedStatus !== undefined) {
          res.writeHead(state.guildsForcedStatus, { "Content-Type": "application/json" });
          res.end(JSON.stringify(state.guildsForcedBody ?? { message: "forced test failure" }));
          return;
        }
        const token = bearerToken(req);
        if (token !== state.currentAccessToken) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "401: Unauthorized", code: 0 }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(state.guilds));
        return;
      }

      if (memberMatch && req.method === "GET") {
        const guildId = decodeURIComponent(memberMatch[1]!);
        if (state.memberForcedStatus !== undefined) {
          res.writeHead(state.memberForcedStatus, { "Content-Type": "application/json" });
          res.end(JSON.stringify(state.memberForcedBody ?? { message: "forced test failure" }));
          return;
        }
        const token = bearerToken(req);
        if (token !== state.currentAccessToken) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "401: Unauthorized", code: 0 }));
          return;
        }
        const roles = state.memberRolesByGuild.get(guildId) ?? [];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ roles, nick: null, joined_at: "2020-01-01T00:00:00.000000+00:00" }));
        return;
      }

      res.writeHead(404);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    tokenUrl: `${baseUrl}/oauth2/token`,
    apiBaseUrl: `${baseUrl}/api`,
    state,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
