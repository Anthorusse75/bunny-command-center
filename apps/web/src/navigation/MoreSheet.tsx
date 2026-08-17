// Mobile "More" — everything NOT in the fixed 5-slot bottom nav, "grouped
// like the desktop sidebar" (21_MOBILE_UX.md §Navigation). Never a dumping
// ground for desktop-only actions (this step's explicit rule) — only real
// navigation destinations from the same `NAV_ITEMS` list desktop uses.
import Drawer from "@mui/material/Drawer";
import Box from "@mui/material/Box";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import CloseOutlined from "@mui/icons-material/CloseOutlined";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { moreMenuItems, type NavContext } from "./navConfig.js";

export interface MoreSheetProps {
  open: boolean;
  onClose: () => void;
  ctx: NavContext;
}

export function MoreSheet({ open, onClose, ctx }: MoreSheetProps): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const items = moreMenuItems(ctx);

  return (
    <Drawer
      anchor="bottom"
      open={open}
      onClose={onClose}
      data-testid="more-sheet"
      slotProps={{ paper: { sx: { maxHeight: "80vh", borderTopLeftRadius: 16, borderTopRightRadius: 16 } } }}
    >
      <Box role="dialog" aria-modal="true" aria-label={t("common.nav.more")} sx={{ padding: 2 }}>
        <Box
          sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBlockEnd: 1 }}
        >
          <Typography variant="h6" component="h2">
            {t("common.nav.more")}
          </Typography>
          <IconButton onClick={onClose} aria-label={t("common.actions.close")} autoFocus>
            <CloseOutlined />
          </IconButton>
        </Box>
        <List>
          {items.map((item) => {
            const Icon = item.icon;
            const path = item.path(ctx);
            return (
              // <ListItem disablePadding> renders the real <li> a <List>'s
              // <ul> needs (axe-core's "list" rule, found by the real
              // browser scan — see SidebarNav.tsx's identical fix for the
              // full rationale).
              <ListItem key={item.key} disablePadding>
                <ListItemButton
                  data-testid={`more-item-${item.key}`}
                  disabled={!path}
                  sx={{ minHeight: 44 }}
                  onClick={() => {
                    if (!path) return;
                    onClose();
                    void navigate(path);
                  }}
                >
                  <ListItemIcon>
                    <Icon fontSize="small" />
                  </ListItemIcon>
                  <ListItemText primary={t(item.labelKey)} />
                </ListItemButton>
              </ListItem>
            );
          })}
        </List>
      </Box>
    </Drawer>
  );
}
