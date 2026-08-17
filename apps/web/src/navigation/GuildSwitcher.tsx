// Desktop guild switcher — "lives in the sidebar header, always visible,
// one click to open, type-to-filter for users in many guilds"
// (09_MULTI_GUILD_MODEL.md §Guild switching, 03_INFORMATION_ARCHITECTURE.md).
// Favorites-first-then-alphabetical ordering is NOT reimplemented here — it
// comes straight from the real `GET /api/users/me/guilds` response
// (`apps/api/src/guilds/guildsService.ts`'s `buildGuildList`), this
// component only filters/renders it and never re-sorts.
import { useId, useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import ListSubheader from "@mui/material/ListSubheader";
import Divider from "@mui/material/Divider";
import TextField from "@mui/material/TextField";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import ExpandMoreOutlined from "@mui/icons-material/ExpandMoreOutlined";
import StarOutlined from "@mui/icons-material/StarOutlined";
import StarBorderOutlined from "@mui/icons-material/StarBorderOutlined";
import GroupsOutlined from "@mui/icons-material/GroupsOutlined";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { useGuildList, useFavoriteGuildMutation, type GuildListEntry } from "../features/guilds/index.js";
import { useToast } from "../design-system/index.js";
import { buildGuildSwitchPath } from "./guildSwitchPath.js";

function filterByName(guilds: GuildListEntry[], query: string): GuildListEntry[] {
  if (!query.trim()) return guilds;
  const q = query.trim().toLocaleLowerCase();
  return guilds.filter((g) => (g.name ?? g.guildId).toLocaleLowerCase().includes(q));
}

export function GuildSwitcher(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { data } = useGuildList();
  const favoriteMutation = useFavoriteGuildMutation();
  const { showToast } = useToast();

  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const menuId = useId();

  const guilds = data?.guilds ?? [];
  const currentGuildId = /^\/guild\/([^/]+)/.exec(location.pathname)?.[1];
  const current = guilds.find((g) => g.guildId === currentGuildId) ?? guilds[0];

  const filtered = useMemo(() => filterByName(guilds, query), [guilds, query]);
  const favorites = filtered.filter((g) => g.isFavorite);
  const others = filtered.filter((g) => !g.isFavorite);

  const open = Boolean(anchorEl);

  function handleSelect(guildId: string): void {
    setAnchorEl(null);
    setQuery("");
    void navigate(buildGuildSwitchPath(location.pathname, guildId));
  }

  function handleToggleFavorite(event: React.MouseEvent, guild: GuildListEntry): void {
    event.stopPropagation();
    favoriteMutation.mutate(
      { guildId: guild.guildId, isFavorite: !guild.isFavorite },
      {
        onSuccess: () => {
          showToast({
            tone: "success",
            messageKey: guild.isFavorite
              ? "guild.switcher.unfavoritedToast"
              : "guild.switcher.favoritedToast",
            values: { guildName: guild.name ?? guild.guildId },
          });
        },
      },
    );
  }

  if (guilds.length === 0) {
    return <Box sx={{ paddingInline: 1, paddingBlock: 1 }} />;
  }

  return (
    <Box>
      <Button
        data-testid="guild-switcher-trigger"
        onClick={(e) => setAnchorEl(e.currentTarget)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={t("a11y.nav.guildSwitcher")}
        startIcon={<GroupsOutlined fontSize="small" />}
        endIcon={<ExpandMoreOutlined fontSize="small" />}
        sx={{
          width: "100%",
          justifyContent: "space-between",
          textTransform: "none",
          textAlign: "start",
        }}
      >
        <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {current?.name ?? t("guild.switcher.title")}
        </Box>
      </Button>
      <Menu
        id={menuId}
        anchorEl={anchorEl}
        open={open}
        onClose={() => setAnchorEl(null)}
        slotProps={{ list: { dense: true, sx: { minWidth: 280, maxWidth: 360 } } }}
      >
        <Box sx={{ paddingInline: 2, paddingBlockEnd: 1 }}>
          <TextField
            autoFocus
            size="small"
            fullWidth
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("guild.switcher.searchPlaceholder")}
            slotProps={{ htmlInput: { "aria-label": t("a11y.nav.guildSwitcherSearch") } }}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </Box>
        {favorites.length === 0 && others.length === 0 ? (
          <MenuItem disabled>{t("guild.switcher.empty")}</MenuItem>
        ) : null}
        {favorites.length > 0 ? <ListSubheader>{t("guild.switcher.favoritesHeading")}</ListSubheader> : null}
        {favorites.map((g) => (
          <GuildMenuRow
            key={g.guildId}
            guild={g}
            onSelect={handleSelect}
            onToggleFavorite={handleToggleFavorite}
          />
        ))}
        {others.length > 0 ? <ListSubheader>{t("guild.switcher.allHeading")}</ListSubheader> : null}
        {others.map((g) => (
          <GuildMenuRow
            key={g.guildId}
            guild={g}
            onSelect={handleSelect}
            onToggleFavorite={handleToggleFavorite}
          />
        ))}
        {data && data.canInviteBunnyAnywhere ? (
          <Box>
            <Divider />
            <MenuItem
              component="a"
              href={data.inviteUrl}
              data-testid="invite-bunny-menu-item"
              aria-label={t("a11y.nav.inviteBunny")}
            >
              {t("common.inviteBunny.ctaCount", { count: data.inviteEligibleGuilds.length })}
            </MenuItem>
          </Box>
        ) : null}
      </Menu>
    </Box>
  );
}

function GuildMenuRow({
  guild,
  onSelect,
  onToggleFavorite,
}: {
  guild: GuildListEntry;
  onSelect: (guildId: string) => void;
  onToggleFavorite: (event: React.MouseEvent, guild: GuildListEntry) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <MenuItem onClick={() => onSelect(guild.guildId)} data-testid={`guild-option-${guild.guildId}`}>
      <IconButton
        size="small"
        edge="start"
        onClick={(e) => onToggleFavorite(e, guild)}
        aria-label={
          guild.isFavorite
            ? t("a11y.nav.favoriteOn", { guildName: guild.name ?? guild.guildId })
            : t("a11y.nav.favoriteOff", { guildName: guild.name ?? guild.guildId })
        }
        sx={{ marginInlineEnd: 1 }}
      >
        {guild.isFavorite ? (
          <StarOutlined fontSize="small" color="warning" />
        ) : (
          <StarBorderOutlined fontSize="small" />
        )}
      </IconButton>
      <Typography component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis" }}>
        {guild.name ?? guild.guildId}
      </Typography>
    </MenuItem>
  );
}
