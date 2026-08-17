// Fills AppShell's `bottom-nav-items` slot with the real, fixed 5
// destinations (03_INFORMATION_ARCHITECTURE.md §Mobile navigation: "Home ·
// Upload · Guild · Leaderboard · More", D-018's "≤5 destinations").
// "More" opens `MoreSheet` (everything else, grouped like the desktop
// sidebar) rather than becoming a dumping ground for desktop-only actions
// (this step's explicit "H. MOBILE/TABLET NAVIGATION" rule).
import { useState } from "react";
import ButtonBase from "@mui/material/ButtonBase";
import Typography from "@mui/material/Typography";
import MoreHorizOutlined from "@mui/icons-material/MoreHorizOutlined";
import { useTranslation } from "react-i18next";
import { NavLink, useLocation, useNavigate } from "react-router";
import { BOTTOM_NAV_ITEMS } from "./navConfig.js";
import { useNavContext } from "./useNavContext.js";
import { GuildPickerSheet } from "./GuildPickerSheet.js";
import { MoreSheet } from "./MoreSheet.js";

const GUILD_ROUTE_RE = /^\/guild\/[^/]+/;

export function BottomNav(): React.JSX.Element {
  const { t } = useTranslation();
  const ctx = useNavContext();
  const location = useLocation();
  const navigate = useNavigate();
  const [guildSheetOpen, setGuildSheetOpen] = useState(false);
  const [moreSheetOpen, setMoreSheetOpen] = useState(false);

  return (
    <>
      {BOTTOM_NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        const label = t(item.labelKey);

        if (item.key === "guild") {
          const isOnGuildRoute = GUILD_ROUTE_RE.test(location.pathname);
          const path = item.path(ctx);
          return (
            <ButtonBase
              key={item.key}
              data-testid="bottom-nav-guild"
              onClick={() => {
                if (isOnGuildRoute || !path) {
                  setGuildSheetOpen(true);
                } else {
                  void navigate(path);
                }
              }}
              aria-current={isOnGuildRoute ? "page" : undefined}
              sx={navButtonSx}
            >
              <Icon fontSize="small" />
              <Typography variant="caption">{label}</Typography>
            </ButtonBase>
          );
        }

        if (item.key === "home" || item.key === "upload" || item.key === "leaderboard") {
          const path = item.path(ctx) ?? "/";
          return (
            <ButtonBase
              key={item.key}
              component={NavLink}
              to={path}
              end={item.key === "home"}
              data-testid={`bottom-nav-${item.key}`}
              sx={navButtonSx}
            >
              <Icon fontSize="small" />
              <Typography variant="caption">{label}</Typography>
            </ButtonBase>
          );
        }
        return null;
      })}
      <ButtonBase
        data-testid="bottom-nav-more"
        onClick={() => setMoreSheetOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={moreSheetOpen}
        aria-label={t("a11y.nav.moreMenu")}
        sx={navButtonSx}
      >
        <MoreHorizOutlined fontSize="small" />
        <Typography variant="caption">{t("common.nav.more")}</Typography>
      </ButtonBase>

      <GuildPickerSheet open={guildSheetOpen} onClose={() => setGuildSheetOpen(false)} />
      <MoreSheet open={moreSheetOpen} onClose={() => setMoreSheetOpen(false)} ctx={ctx} />
    </>
  );
}

const navButtonSx = {
  flex: 1,
  minHeight: 44,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 0.25,
  "&[aria-current='page']": { color: "primary.main" },
} as const;
