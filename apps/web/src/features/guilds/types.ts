// Step-06 multi-guild types — re-exported from the shared Zod-derived
// contracts (`packages/shared/src/types/guilds.ts`), the single source of
// truth for shapes crossing apps/web <-> apps/api (24_API_CONTRACTS.md,
// ADR-014).
//
// EXTERNAL REVIEW CORRECTION (Step 06 correction pass): this file used to
// hand-duplicate its own plain TS interfaces instead of importing from
// `packages/shared` — which had already drifted from what the real backend
// returns (`postFavorite()`/`patchHomeVisibility()` claimed
// `Promise<GuildListEntry>`, but `apps/api/src/guilds/routes.ts` actually
// returns the narrower `GuildPreferenceResponse` shape — see `api.ts`'s
// matching correction). Re-exporting from shared makes that kind of drift a
// compile error instead of a silent runtime mismatch.
export type {
  GuildListEntry,
  GuildListResponse,
  GuildOverview,
  GuildTier,
  GuildPreferenceResponse,
} from "@bunny-command-center/shared";
