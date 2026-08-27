/**
 * HTTP client for Bunny OCR's `GET /internal/guilds/{guild_id}/channels`
 * (Step 10 correction round, Gap 2 — sibling repo `02_NEW_BOT_OCR`, branch
 * `dashboard/step-10-channel-catalog`,
 * `functions/internal_channel_catalog.py`). Backs the onboarding
 * Incoming/Hero/Community channel pickers' live dropdown data AND the
 * live existence check on every channel-section save
 * (`11_GUILD_CONFIGURATION.md`'s "never silently accept an unverified
 * channel id" audit-gap closure).
 *
 * Documented contract (read directly from the sibling repo's real,
 * unmodified source — not guessed):
 *   `Authorization: Bearer <BUNNY_INTERNAL_API_TOKEN>`
 *   200 `{ "guild_id": "<snowflake string>", "channels": [{ "id": string,
 *        "name": string, "position": number, "type": string,
 *        "can_read_history": boolean, "can_view_channel": boolean,
 *        "can_send_messages": boolean }] }`
 *   — `can_view_channel`/`can_send_messages` added by
 *     `02_NEW_BOT_OCR`'s `dashboard/step-10-channel-catalog` branch, commit
 *     on top of the original Gap 2 endpoint (Step 10 external-review Phase
 *     2): VIEW_CHANNEL and READ_MESSAGE_HISTORY are distinct Discord
 *     permission bits (read-history alone never implies visibility), and
 *     SEND_MESSAGES backs the "Bunny & permissions" live checklist's
 *     community-channel requirement. All three booleans are computed off
 *     the SAME `permissions_for(guild.me)` call on Bunny's side and are
 *     always present (never omitted) in every channel entry.
 *   400 non-numeric guild id (should never happen here — this client is
 *       always called with an already-snowflake-validated guildId)
 *   401 missing/bad bearer token
 *   404 Bunny is not a member of the guild
 *   502 serialization failure
 *   503 server misconfigured / token unset (Bunny-side)
 *
 * Every outcome is a typed, discriminated `BunnyChannelCatalogResult` —
 * NEVER a thrown raw error/exception out of `fetchGuildChannelCatalog`
 * (this module's own single entrypoint), matching this step's brief:
 * "success / Bunny unreachable / non-200 status / malformed response — all
 * as distinct, typed outcomes."
 */
import type { AppConfig } from "../config.js";

export interface BunnyChannel {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  readonly type: string;
  readonly canReadHistory: boolean;
  readonly canViewChannel: boolean;
  readonly canSendMessages: boolean;
}

export type BunnyChannelCatalogResult =
  /** Real, successful catalog fetch. */
  | { readonly ok: true; readonly channels: readonly BunnyChannel[] }
  /** No `BUNNY_INTERNAL_API_URL`/`BUNNY_INTERNAL_API_TOKEN` configured on THIS Dashboard instance (`config.bunnyInternalApi` is `undefined`) — distinct from Bunny itself being unreachable. */
  | { readonly ok: false; readonly reason: "NOT_CONFIGURED" }
  /** `fetch()` itself threw — DNS failure, connection refused, timeout, TLS error, etc. */
  | { readonly ok: false; readonly reason: "UNREACHABLE"; readonly detail: string }
  /** Bunny answered with a real HTTP status, but not a success we can use (401/500/502/503/etc.) — `status` is the real code Bunny returned, for logging. */
  | { readonly ok: false; readonly reason: "UPSTREAM_ERROR"; readonly status: number }
  /** Bunny answered 404 — it is not (or no longer) a member of this guild. */
  | { readonly ok: false; readonly reason: "GUILD_NOT_FOUND" }
  /** Bunny answered 200 but the body doesn't match the documented shape — never trusted/parsed permissively. */
  | { readonly ok: false; readonly reason: "MALFORMED_RESPONSE"; readonly detail: string };

function parseChannelsBody(guildId: string, body: unknown): BunnyChannel[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.guild_id !== "string" || record.guild_id !== guildId) return undefined;
  if (!Array.isArray(record.channels)) return undefined;
  const channels: BunnyChannel[] = [];
  for (const raw of record.channels) {
    if (
      typeof raw !== "object" ||
      raw === null ||
      typeof (raw as { id?: unknown }).id !== "string" ||
      typeof (raw as { name?: unknown }).name !== "string" ||
      typeof (raw as { position?: unknown }).position !== "number" ||
      typeof (raw as { type?: unknown }).type !== "string" ||
      typeof (raw as { can_read_history?: unknown }).can_read_history !== "boolean" ||
      typeof (raw as { can_view_channel?: unknown }).can_view_channel !== "boolean" ||
      typeof (raw as { can_send_messages?: unknown }).can_send_messages !== "boolean"
    ) {
      return undefined;
    }
    const r = raw as {
      id: string;
      name: string;
      position: number;
      type: string;
      can_read_history: boolean;
      can_view_channel: boolean;
      can_send_messages: boolean;
    };
    channels.push({
      id: r.id,
      name: r.name,
      position: r.position,
      type: r.type,
      canReadHistory: r.can_read_history,
      canViewChannel: r.can_view_channel,
      canSendMessages: r.can_send_messages,
    });
  }
  return channels;
}

/**
 * The ONE function that ever calls Bunny's internal channel-catalog
 * endpoint. `guildId` MUST already be a syntactically valid Discord
 * snowflake (every real call site resolves it via `requireTier`/
 * `requireGuildAdmin` first) — this client does not re-validate it, it only
 * URL-encodes it.
 */
export async function fetchGuildChannelCatalog(
  config: AppConfig,
  guildId: string,
): Promise<BunnyChannelCatalogResult> {
  const bunnyConfig = config.bunnyInternalApi;
  if (!bunnyConfig) {
    return { ok: false, reason: "NOT_CONFIGURED" };
  }

  let response: Response;
  try {
    response = await fetch(`${bunnyConfig.baseUrl}/internal/guilds/${encodeURIComponent(guildId)}/channels`, {
      headers: { Authorization: `Bearer ${bunnyConfig.token}` },
    });
  } catch (err) {
    return { ok: false, reason: "UNREACHABLE", detail: (err as Error).message };
  }

  if (response.status === 404) {
    return { ok: false, reason: "GUILD_NOT_FOUND" };
  }
  if (!response.ok) {
    return { ok: false, reason: "UPSTREAM_ERROR", status: response.status };
  }

  const body: unknown = await response.json().catch(() => null);
  const channels = parseChannelsBody(guildId, body);
  if (channels === undefined) {
    return {
      ok: false,
      reason: "MALFORMED_RESPONSE",
      detail: "response body did not match the documented { guild_id, channels[] } contract",
    };
  }
  return { ok: true, channels };
}
