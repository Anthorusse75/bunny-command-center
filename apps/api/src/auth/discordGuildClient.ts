/**
 * The two Discord OAuth calls Guild Admin Resolution needs
 * (08_AUTHORIZATION_AND_RBAC.md, ADR-004 corrected 2026-08-11 second pass):
 *   GET /users/@me/guilds                 -- membership, Owner, Administrator permission
 *   GET /users/@me/guilds/{guild_id}/member -- the caller's OWN role list in that guild
 *
 * Both are the CALLER'S OWN OAuth session (`guilds`/`guilds.members.read`
 * scopes, already granted at Step-04 login) -- zero dependency on Bunny OCR
 * being reachable (ADR-004's whole point). Mirrors `discordClient.ts`'s
 * conventions exactly: configurable base URLs (so tests point this at the
 * local Discord test double, never real discord.com), typed errors carrying
 * the real HTTP status (needed by `discordTokenService.ts` to detect a 401
 * specifically and trigger the refresh lifecycle), and no logging of the
 * access token anywhere in this module.
 */
import type { DiscordOAuthConfig } from "../config.js";

export interface DiscordGuildSummary {
  id: string;
  owner: boolean;
  /**
   * Discord's raw bitmask, serialized as a STRING (Discord's own API
   * convention -- permission bitfields can exceed 32 bits and are never
   * sent as a JSON number for the same precision reason Snowflakes aren't).
   * Never parsed with `Number(...)`/`parseInt(...)` -- see
   * `hasAdministratorPermission` below, which uses `BigInt(...)`.
   */
  permissions: string;
}

export interface DiscordGuildMember {
  roles: string[];
}

export class DiscordGuildFetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DiscordGuildFetchError";
  }
}

/** True exactly when the HTTP status this module's calls failed with was a 401 (access-token expiry) — the ONE condition `discordTokenService.ts` treats as refresh-eligible, per 07_DISCORD_OAUTH.md's "whenever a Discord API call ... returns a 401 due to access_token expiry." */
export function isDiscordUnauthorized(err: unknown): err is DiscordGuildFetchError {
  return err instanceof DiscordGuildFetchError && err.status === 401;
}

async function parseJsonArray(response: Response): Promise<unknown[]> {
  const json: unknown = await response.json().catch(() => null);
  if (!Array.isArray(json)) {
    throw new DiscordGuildFetchError("Discord endpoint returned a non-array response body.", response.status);
  }
  // `Array.isArray` narrows `unknown` to `any[]` in TypeScript's lib types
  // (not `unknown[]`) -- explicit cast keeps this function's own declared
  // `unknown[]` return type honest without leaking an implicit `any`.
  return json as unknown[];
}

export async function fetchUserGuilds(
  config: DiscordOAuthConfig,
  accessToken: string,
): Promise<DiscordGuildSummary[]> {
  let response: Response;
  try {
    response = await fetch(`${config.apiBaseUrl}/users/@me/guilds`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    throw new DiscordGuildFetchError(`Discord guild-list endpoint unreachable: ${(err as Error).message}`, 0);
  }
  if (!response.ok) {
    throw new DiscordGuildFetchError(
      `Discord guild-list fetch failed with status ${response.status}`,
      response.status,
    );
  }
  const rows = await parseJsonArray(response);
  const guilds: DiscordGuildSummary[] = [];
  for (const row of rows) {
    if (
      typeof row !== "object" ||
      row === null ||
      typeof (row as { id?: unknown }).id !== "string" ||
      // Guild Snowflakes are digit-only strings — checked as a STRING
      // pattern only, same rationale as discordClient.ts's identity check.
      !/^\d{1,20}$/.test((row as { id: string }).id) ||
      typeof (row as { owner?: unknown }).owner !== "boolean" ||
      typeof (row as { permissions?: unknown }).permissions !== "string"
    ) {
      throw new DiscordGuildFetchError(
        "Discord guild-list endpoint returned a malformed guild entry.",
        response.status,
      );
    }
    guilds.push({
      id: (row as { id: string }).id,
      owner: (row as { owner: boolean }).owner,
      permissions: (row as { permissions: string }).permissions,
    });
  }
  return guilds;
}

export async function fetchGuildMember(
  config: DiscordOAuthConfig,
  accessToken: string,
  guildId: string,
): Promise<DiscordGuildMember> {
  let response: Response;
  try {
    response = await fetch(`${config.apiBaseUrl}/users/@me/guilds/${encodeURIComponent(guildId)}/member`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    throw new DiscordGuildFetchError(
      `Discord guild-member endpoint unreachable: ${(err as Error).message}`,
      0,
    );
  }
  if (!response.ok) {
    throw new DiscordGuildFetchError(
      `Discord guild-member fetch failed with status ${response.status}`,
      response.status,
    );
  }
  const json: unknown = await response.json().catch(() => null);
  if (
    typeof json !== "object" ||
    json === null ||
    !Array.isArray((json as { roles?: unknown }).roles) ||
    !(json as { roles: unknown[] }).roles.every((r) => typeof r === "string")
  ) {
    throw new DiscordGuildFetchError(
      "Discord guild-member endpoint returned a malformed response body.",
      response.status,
    );
  }
  return { roles: (json as { roles: string[] }).roles };
}

/** Discord permission bit `ADMINISTRATOR` (docs.discord.com/developers/topics/permissions): `0x0000000000000008`. */
const ADMINISTRATOR_BIT = 0x8n;

/**
 * Parses Discord's permission bitfield STRING with `BigInt`, never
 * `Number(...)`/`parseInt(...)` (the field can legitimately exceed
 * `Number.MAX_SAFE_INTEGER` for accounts with many permission bits set,
 * same class of risk as a Snowflake — 08_AUTHORIZATION_AND_RBAC.md's
 * "Permission bitfields must also avoid unsafe JS-number coercion").
 * Fails closed (`false`) on a non-numeric string rather than throwing —
 * a malformed permissions field must never accidentally grant admin.
 */
export function hasAdministratorPermission(permissions: string): boolean {
  let value: bigint;
  try {
    value = BigInt(permissions);
  } catch {
    return false;
  }
  return (value & ADMINISTRATOR_BIT) === ADMINISTRATOR_BIT;
}
