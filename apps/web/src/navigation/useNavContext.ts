// Assembles the `NavContext` every nav-visibility/path decision
// (navConfig.ts) reads — one hook, called once per render by
// AppShell/SidebarNav/BottomNav/MoreSheet, so mobile and desktop always see
// exactly the same resolved context.
import { useAuth } from "../features/auth/index.js";
import { useGuildOverview } from "../features/guilds/index.js";
import { useDefaultGuildId } from "./useDefaultGuildId.js";
import type { NavContext } from "./navConfig.js";

export function useNavContext(): NavContext {
  const defaultGuildId = useDefaultGuildId();
  const { data: overview } = useGuildOverview(defaultGuildId);
  const { isSuperadmin } = useAuth();
  return { defaultGuildId, overview, isSuperadmin };
}
