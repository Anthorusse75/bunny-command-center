// Mobile guild picker — "reachable from the 'Guild' bottom-nav tab as a
// picker sheet" (09_MULTI_GUILD_MODEL.md §Guild switching). A full-screen
// bottom sheet (MUI `Drawer anchor="bottom"`), same real ordered/filtered
// data as the desktop `GuildSwitcher`, same `buildGuildSwitchPath` rule so
// mobile and desktop can never diverge on the "preserve current domain"
// behavior.
import { useMemo, useState } from "react";
import Drawer from "@mui/material/Drawer";
import Box from "@mui/material/Box";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import ListSubheader from "@mui/material/ListSubheader";
import Divider from "@mui/material/Divider";
import TextField from "@mui/material/TextField";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import CloseOutlined from "@mui/icons-material/CloseOutlined";
import StarOutlined from "@mui/icons-material/StarOutlined";
import StarBorderOutlined from "@mui/icons-material/StarBorderOutlined";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { useGuildList, useFavoriteGuildMutation, type GuildListEntry } from "../features/guilds/index.js";
import { buildGuildSwitchPath } from "./guildSwitchPath.js";

function filterByName(guilds: GuildListEntry[], query: string): GuildListEntry[] {
  if (!query.trim()) return guilds;
  const q = query.trim().toLocaleLowerCase();
  return guilds.filter((g) => (g.name ?? g.guildId).toLocaleLowerCase().includes(q));
}

export interface GuildPickerSheetProps {
  open: boolean;
  onClose: () => void;
}

export function GuildPickerSheet({ open, onClose }: GuildPickerSheetProps): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { data } = useGuildList();
  const favoriteMutation = useFavoriteGuildMutation();
  const [query, setQuery] = useState("");

  const guilds = data?.guilds ?? [];
  const filtered = useMemo(() => filterByName(guilds, query), [guilds, query]);
  const favorites = filtered.filter((g) => g.isFavorite);
  const others = filtered.filter((g) => !g.isFavorite);

  function handleSelect(guildId: string): void {
    onClose();
    setQuery("");
    void navigate(buildGuildSwitchPath(location.pathname, guildId));
  }

  return (
    <Drawer
      anchor="bottom"
      open={open}
      onClose={onClose}
      data-testid="guild-picker-sheet"
      slotProps={{ paper: { sx: { maxHeight: "80vh", borderTopLeftRadius: 16, borderTopRightRadius: 16 } } }}
    >
      <Box role="dialog" aria-modal="true" aria-label={t("guild.switcher.title")} sx={{ padding: 2 }}>
        <Box
          sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBlockEnd: 1 }}
        >
          <Typography variant="h6" component="h2">
            {t("guild.switcher.title")}
          </Typography>
          <IconButton onClick={onClose} aria-label={t("common.actions.close")} autoFocus>
            <CloseOutlined />
          </IconButton>
        </Box>
        <TextField
          size="small"
          fullWidth
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("guild.switcher.searchPlaceholder")}
          slotProps={{ htmlInput: { "aria-label": t("a11y.nav.guildSwitcherSearch") } }}
          sx={{ marginBlockEnd: 1 }}
        />
        {favorites.length === 0 && others.length === 0 ? (
          // Rendered OUTSIDE <List> — a <ul> must directly contain only
          // real listitems (axe-core's "list" rule, found by the real
          // browser scan); an empty-state message is not a listitem.
          <Typography variant="body2" color="text.secondary" sx={{ paddingInline: 2 }}>
            {t("guild.switcher.empty")}
          </Typography>
        ) : null}
        <List sx={{ overflowY: "auto" }}>
          {favorites.length > 0 ? (
            <ListSubheader>{t("guild.switcher.favoritesHeading")}</ListSubheader>
          ) : null}
          {favorites.map((g) => (
            <GuildRow
              key={g.guildId}
              guild={g}
              onSelect={handleSelect}
              onToggleFavorite={favoriteMutation.mutate}
            />
          ))}
          {others.length > 0 ? <ListSubheader>{t("guild.switcher.allHeading")}</ListSubheader> : null}
          {others.map((g) => (
            <GuildRow
              key={g.guildId}
              guild={g}
              onSelect={handleSelect}
              onToggleFavorite={favoriteMutation.mutate}
            />
          ))}
        </List>
        {data && data.canInviteBunnyAnywhere ? (
          <>
            <Divider />
            <ListItemButton
              component="a"
              href={data.inviteUrl}
              data-testid="invite-bunny-mobile"
              aria-label={t("a11y.nav.inviteBunny")}
            >
              <ListItemText
                primary={t("common.inviteBunny.ctaCount", { count: data.inviteEligibleGuilds.length })}
              />
            </ListItemButton>
          </>
        ) : null}
      </Box>
    </Drawer>
  );
}

function GuildRow({
  guild,
  onSelect,
  onToggleFavorite,
}: {
  guild: GuildListEntry;
  onSelect: (guildId: string) => void;
  onToggleFavorite: (args: { guildId: string; isFavorite: boolean }) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <ListItem disablePadding>
      <ListItemButton
        onClick={() => onSelect(guild.guildId)}
        data-testid={`guild-option-mobile-${guild.guildId}`}
        sx={{ minHeight: 44 }}
      >
        <ListItemIcon
          sx={{ minWidth: 40 }}
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite({ guildId: guild.guildId, isFavorite: !guild.isFavorite });
          }}
        >
          <IconButton
            size="small"
            aria-label={
              guild.isFavorite
                ? t("a11y.nav.favoriteOn", { guildName: guild.name ?? guild.guildId })
                : t("a11y.nav.favoriteOff", { guildName: guild.name ?? guild.guildId })
            }
          >
            {guild.isFavorite ? (
              <StarOutlined fontSize="small" color="warning" />
            ) : (
              <StarBorderOutlined fontSize="small" />
            )}
          </IconButton>
        </ListItemIcon>
        <ListItemText primary={guild.name ?? guild.guildId} />
      </ListItemButton>
    </ListItem>
  );
}
