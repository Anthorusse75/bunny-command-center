// 03_INFORMATION_ARCHITECTURE.md §Guild-scoped vs global routes: "A
// stale/invalid guildId in the URL (guild removed, user kicked, access
// revoked while the tab was open) redirects to a 'no longer accessible'
// state, never a raw 403" (SCREENS/ERROR_STATES.md). Rendered by
// `GuildRouteGuard.tsx` on a real 404 from `GET /api/guilds/:guildId` —
// deliberately distinct wording from the generic `NotFoundScreen` (a
// genuinely unknown ROUTE) and from `ForbiddenScreen` (membership confirmed,
// tier denied) so a screen reader/sighted user never confuses "this guild
// isn't yours (anymore)" with "this page doesn't exist" or "you lack a
// permission".
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { PageHeading } from "../navigation/PageHeading.js";

export function GuildNotAccessibleScreen(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Box sx={{ maxWidth: 480, textAlign: "center", marginInline: "auto", paddingBlockStart: 8 }}>
      <PageHeading text={t("errors.guildNotAccessible.title")} />
      <Typography variant="body1" color="text.secondary" sx={{ marginBlockEnd: 3 }}>
        {t("errors.guildNotAccessible.body")}
      </Typography>
      <Button component={Link} to="/" variant="contained">
        {t("errors.guildNotAccessible.cta")}
      </Button>
    </Box>
  );
}
