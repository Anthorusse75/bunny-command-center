// Desktop guild switcher — "lives in the sidebar header, always visible,
// one click to open, type-to-filter for users in many guilds"
// (09_MULTI_GUILD_MODEL.md §Guild switching, 03_INFORMATION_ARCHITECTURE.md).
// Favorites-first-then-alphabetical ordering is NOT reimplemented here — it
// comes straight from the real `GET /api/users/me/guilds` response
// (`apps/api/src/guilds/guildsService.ts`'s `buildGuildList`), this
// component only filters/renders it and never re-sorts.
//
// Built on `Popover` + a real `List` (not `Menu`/`MenuItem`) — DELIBERATE,
// documented choice: each row needs TWO independent interactive actions
// (select the guild, toggle favorite), and `MenuItem` renders as
// `<li role="menuitem">` with `ButtonBase` semantics — nesting a real
// `IconButton` inside it is a genuine nested-interactive-controls defect
// (axe-core's "nested-interactive" rule; a real-browser Playwright
// accessibility-tree snapshot caught the equivalent bug in the mobile
// picker sheet, which used to nest the same way). `List`/`ListItem`'s
// `secondaryAction` prop is MUI's own documented pattern for exactly this
// row shape — the IconButton renders as a SIBLING of `ListItemButton`, both
// children of `ListItem`, never nested — matching `GuildPickerSheet.tsx`'s
// (mobile) row structure exactly, so desktop and mobile share one correct
// pattern instead of two different accessibility postures.
import { useId, useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Popover from "@mui/material/Popover";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
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
  const popoverId = useId();

  const guilds = data?.guilds ?? [];
  const currentGuildId = /^\/guild\/([^/]+)/.exec(location.pathname)?.[1];
  const current = guilds.find((g) => g.guildId === currentGuildId) ?? guilds[0];

  const filtered = useMemo(() => filterByName(guilds, query), [guilds, query]);
  const favorites = filtered.filter((g) => g.isFavorite);
  const others = filtered.filter((g) => !g.isFavorite);

  const open = Boolean(anchorEl);

  function handleClose(): void {
    setAnchorEl(null);
    setQuery("");
  }

  function handleSelect(guildId: string): void {
    handleClose();
    void navigate(buildGuildSwitchPath(location.pathname, guildId));
  }

  function handleToggleFavorite(guild: GuildListEntry): void {
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
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
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
      <Popover
        id={popoverId}
        anchorEl={anchorEl}
        open={open}
        onClose={handleClose}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        slotProps={{
          paper: { sx: { minWidth: 280, maxWidth: 360, maxHeight: 480 } },
        }}
      >
        <Box role="dialog" aria-label={t("guild.switcher.title")} sx={{ paddingBlock: 1 }}>
          <Box sx={{ paddingInline: 2, paddingBlockEnd: 1 }}>
            <TextField
              autoFocus
              size="small"
              fullWidth
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("guild.switcher.searchPlaceholder")}
              slotProps={{ htmlInput: { "aria-label": t("a11y.nav.guildSwitcherSearch") } }}
            />
          </Box>
          {favorites.length === 0 && others.length === 0 ? (
            // Rendered OUTSIDE <List> — a <ul> must directly contain only
            // real listitems (axe-core's "list" rule, same rationale as
            // GuildPickerSheet.tsx's identical empty-state placement).
            <Typography variant="body2" color="text.secondary" sx={{ paddingInline: 2 }}>
              {t("guild.switcher.empty")}
            </Typography>
          ) : null}
          <List dense sx={{ overflowY: "auto", maxHeight: 320 }}>
            {favorites.length > 0 ? (
              <ListSubheader>{t("guild.switcher.favoritesHeading")}</ListSubheader>
            ) : null}
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
          </List>
          {data && data.canInviteBunnyAnywhere ? (
            <Box>
              <Divider />
              <List dense disablePadding>
                <ListItem disablePadding>
                  <ListItemButton
                    component="a"
                    href={data.inviteUrl}
                    data-testid="invite-bunny-menu-item"
                    aria-label={t("a11y.nav.inviteBunny")}
                  >
                    <ListItemText
                      primary={t("common.inviteBunny.ctaCount", { count: data.inviteEligibleGuilds.length })}
                    />
                  </ListItemButton>
                </ListItem>
              </List>
            </Box>
          ) : null}
        </Box>
      </Popover>
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
  onToggleFavorite: (guild: GuildListEntry) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <ListItem
      disablePadding
      secondaryAction={
        <IconButton
          edge="end"
          size="small"
          onClick={() => onToggleFavorite(guild)}
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
      }
    >
      <ListItemButton
        onClick={() => onSelect(guild.guildId)}
        data-testid={`guild-option-${guild.guildId}`}
        sx={{ paddingInlineEnd: 6 }}
      >
        <ListItemText
          primary={
            <Typography
              component="span"
              sx={{ overflow: "hidden", textOverflow: "ellipsis", display: "block" }}
            >
              {guild.name ?? guild.guildId}
            </Typography>
          }
        />
      </ListItemButton>
    </ListItem>
  );
}
