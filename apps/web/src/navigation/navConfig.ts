// The single source of truth for domain ordering, route paths, and
// visibility rules (03_INFORMATION_ARCHITECTURE.md's domain table +
// "Desktop navigation"/"Mobile navigation" sections). Both `SidebarNav.tsx`
// (desktop) and `BottomNav.tsx`/`MoreSheet.tsx` (mobile) read from this ONE
// list rather than each re-deriving the domain order — so mobile and
// desktop can never silently drift apart on ordering or destination set.
import HomeOutlined from "@mui/icons-material/HomeOutlined";
import CloudUploadOutlined from "@mui/icons-material/CloudUploadOutlined";
import GroupsOutlined from "@mui/icons-material/GroupsOutlined";
import HistoryOutlined from "@mui/icons-material/HistoryOutlined";
import EmojiEventsOutlined from "@mui/icons-material/EmojiEventsOutlined";
import NotificationsOutlined from "@mui/icons-material/NotificationsOutlined";
import ChecklistOutlined from "@mui/icons-material/ChecklistOutlined";
import AdminPanelSettingsOutlined from "@mui/icons-material/AdminPanelSettingsOutlined";
import BuildOutlined from "@mui/icons-material/BuildOutlined";
import ShieldOutlined from "@mui/icons-material/ShieldOutlined";
import TravelExploreOutlined from "@mui/icons-material/TravelExploreOutlined";
import PersonOutlined from "@mui/icons-material/PersonOutlined";
import type { SvgIconComponent } from "@mui/icons-material";
import type { GuildOverview } from "../features/guilds/index.js";

/** Every domain this step's route table covers (03_INFORMATION_ARCHITECTURE.md's domain table, in desktop sidebar order). */
export type NavDomainKey =
  | "home"
  | "upload"
  | "guild"
  | "contributions"
  | "leaderboard"
  | "notifications"
  | "onboarding"
  | "guildAdmin"
  | "technical"
  | "superadmin"
  | "heroDiscovery"
  | "profile";

export interface NavContext {
  /** The guild the "Guild" family of destinations should resolve to — the current route's guildId if already on one, else the user's last-used/favorite guild. `undefined` when the caller has zero usable guilds. */
  defaultGuildId: string | undefined;
  /** The resolved tier for `defaultGuildId`, if known (drives which conditional destinations show) — `undefined` while unknown/loading, treated as "not yet provable, don't show admin-only items". */
  overview: GuildOverview | undefined;
  isSuperadmin: boolean;
}

export interface NavItem {
  key: NavDomainKey;
  /** i18n key under `common.nav.*`. */
  labelKey: string;
  icon: SvgIconComponent;
  /** Resolves the real path for the current context; `undefined` if this destination isn't reachable right now (e.g. Guild with zero guilds). */
  path: (ctx: NavContext) => string | undefined;
  /** Whether this destination is shown at all right now — conditional items (Onboarding/Guild Admin/Technical/Superadmin/Hero Discovery) per 03_INFORMATION_ARCHITECTURE.md. */
  visible: (ctx: NavContext) => boolean;
  /** Bottom-nav-eligible (03_INFORMATION_ARCHITECTURE.md's fixed 5: Home/Upload/Guild/Leaderboard/More). */
  inBottomNav: boolean;
  /** Groups sidebar items with dividers between them, per 03_INFORMATION_ARCHITECTURE.md §Desktop navigation. */
  group: "primary" | "guildAdmin" | "platform" | "profile";
}

const hasGuild = (ctx: NavContext): boolean => ctx.defaultGuildId !== undefined;
const isGuildAdmin = (ctx: NavContext): boolean =>
  ctx.overview !== undefined && (ctx.overview.tier === "GUILD_ADMIN" || ctx.overview.tier === "SUPERADMIN");

export const NAV_ITEMS: NavItem[] = [
  {
    key: "home",
    labelKey: "common.nav.home",
    icon: HomeOutlined,
    path: () => "/",
    visible: () => true,
    inBottomNav: true,
    group: "primary",
  },
  {
    key: "upload",
    labelKey: "common.nav.upload",
    icon: CloudUploadOutlined,
    path: () => "/upload",
    visible: () => true,
    inBottomNav: true,
    group: "primary",
  },
  {
    key: "guild",
    labelKey: "common.nav.guild",
    icon: GroupsOutlined,
    path: (ctx) => (ctx.defaultGuildId ? `/guild/${ctx.defaultGuildId}` : undefined),
    visible: () => true,
    inBottomNav: true,
    group: "primary",
  },
  {
    key: "contributions",
    labelKey: "common.nav.contributions",
    icon: HistoryOutlined,
    path: () => "/contributions",
    visible: () => true,
    inBottomNav: false,
    group: "primary",
  },
  {
    key: "leaderboard",
    labelKey: "common.nav.leaderboard",
    icon: EmojiEventsOutlined,
    path: (ctx) => (ctx.defaultGuildId ? `/guild/${ctx.defaultGuildId}/leaderboard` : undefined),
    visible: () => true,
    inBottomNav: true,
    group: "primary",
  },
  {
    key: "notifications",
    labelKey: "common.nav.notifications",
    icon: NotificationsOutlined,
    path: () => "/notifications",
    visible: () => true,
    inBottomNav: false,
    group: "primary",
  },
  {
    key: "onboarding",
    labelKey: "common.nav.onboarding",
    icon: ChecklistOutlined,
    path: (ctx) => (ctx.defaultGuildId ? `/guild/${ctx.defaultGuildId}/onboarding` : undefined),
    visible: (ctx) => hasGuild(ctx) && isGuildAdmin(ctx),
    inBottomNav: false,
    group: "guildAdmin",
  },
  {
    key: "guildAdmin",
    labelKey: "common.nav.guildAdmin",
    icon: AdminPanelSettingsOutlined,
    path: (ctx) => (ctx.defaultGuildId ? `/guild/${ctx.defaultGuildId}/admin` : undefined),
    visible: (ctx) => hasGuild(ctx) && isGuildAdmin(ctx),
    inBottomNav: false,
    group: "guildAdmin",
  },
  {
    key: "technical",
    labelKey: "common.nav.technical",
    icon: BuildOutlined,
    path: (ctx) => (ctx.defaultGuildId ? `/guild/${ctx.defaultGuildId}/technical` : undefined),
    visible: (ctx) => (hasGuild(ctx) && isGuildAdmin(ctx)) || ctx.isSuperadmin,
    inBottomNav: false,
    group: "guildAdmin",
  },
  {
    key: "superadmin",
    labelKey: "common.nav.superadmin",
    icon: ShieldOutlined,
    path: () => "/admin/platform",
    visible: (ctx) => ctx.isSuperadmin,
    inBottomNav: false,
    group: "platform",
  },
  {
    key: "heroDiscovery",
    labelKey: "common.nav.heroDiscovery",
    icon: TravelExploreOutlined,
    path: () => "/admin/platform/hero-discovery",
    visible: (ctx) => ctx.isSuperadmin,
    inBottomNav: false,
    group: "platform",
  },
  {
    key: "profile",
    labelKey: "common.nav.profile",
    icon: PersonOutlined,
    path: () => "/profile",
    visible: () => true,
    inBottomNav: false,
    group: "profile",
  },
];

/** The fixed 5 mobile bottom-nav slots, in order: Home, Upload, Guild, Leaderboard, More (03_INFORMATION_ARCHITECTURE.md). "More" itself isn't a `NavItem` — `BottomNav.tsx` renders it as a fixed 5th slot. */
export const BOTTOM_NAV_ITEMS: NavItem[] = NAV_ITEMS.filter((item) => item.inBottomNav);

/** Everything "More" expands to on mobile — every item NOT already in the fixed bottom-nav row, filtered by visibility (03_INFORMATION_ARCHITECTURE.md: "More expands to: Contributions, Notifications, Onboarding (if applicable), Guild Admin (if applicable), Technical (if applicable), Superadmin (if applicable), Profile"). */
export function moreMenuItems(ctx: NavContext): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.inBottomNav && item.visible(ctx));
}

/** Desktop sidebar items grouped with divider boundaries, per group order above. */
export function sidebarGroups(ctx: NavContext): { group: NavItem["group"]; items: NavItem[] }[] {
  const groups: NavItem["group"][] = ["primary", "guildAdmin", "platform", "profile"];
  return groups
    .map((group) => ({ group, items: NAV_ITEMS.filter((item) => item.group === group && item.visible(ctx)) }))
    .filter((g) => g.items.length > 0);
}
