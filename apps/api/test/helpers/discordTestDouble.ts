/**
 * A controlled, local, real HTTP Discord OAuth test double
 * (31_TEST_STRATEGY.md: "acceptable to use a controlled local Discord OAuth
 * HTTP test double for deterministic protocol/error testing"). Implements
 * just enough of `POST /oauth2/token` and `GET /api/users/@me` to drive every
 * documented success/failure branch of `apps/api/src/auth/discordClient.ts`
 * deterministically — this is explicitly NOT proof that real Discord OAuth
 * works (see this step's HANDOVER).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface DiscordTestDoubleState {
  /** When set, `/oauth2/token` responds with this HTTP status and body instead of a success payload. */
  tokenExchangeStatus: number | undefined;
  tokenExchangeBody: unknown;
  /** When set, `/api/users/@me` responds with this HTTP status and body instead of a success payload. */
  identityStatus: number | undefined;
  identityBody: unknown;
  /** The `id` the success-path identity response returns — overridable so a test can drive the flow with a specific (e.g. deliberately unsafe-as-a-JS-number) Discord snowflake. */
  identityUserId: string;
  /** Records every `code`/`code_verifier` pair presented to the token endpoint, for replay assertions. */
  receivedTokenRequests: { code: string; codeVerifier: string }[];
}

export interface DiscordTestDouble {
  baseUrl: string;
  tokenUrl: string;
  apiBaseUrl: string;
  state: DiscordTestDoubleState;
  close(): Promise<void>;
}

export async function startDiscordTestDouble(): Promise<DiscordTestDouble> {
  const state: DiscordTestDoubleState = {
    tokenExchangeStatus: undefined,
    tokenExchangeBody: undefined,
    identityStatus: undefined,
    identityBody: undefined,
    identityUserId: "700000000001",
    receivedTokenRequests: [],
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");

      if (req.url === "/oauth2/token" && req.method === "POST") {
        const params = new URLSearchParams(body);
        state.receivedTokenRequests.push({
          code: params.get("code") ?? "",
          codeVerifier: params.get("code_verifier") ?? "",
        });

        if (state.tokenExchangeStatus !== undefined) {
          res.writeHead(state.tokenExchangeStatus, { "Content-Type": "application/json" });
          res.end(JSON.stringify(state.tokenExchangeBody ?? { error: "forced_test_failure" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: "fake-access-token-value",
            refresh_token: "fake-refresh-token-value",
            expires_in: 604800,
            token_type: "Bearer",
            scope: "identify guilds guilds.members.read",
          }),
        );
        return;
      }

      if (req.url === "/api/users/@me" && req.method === "GET") {
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
