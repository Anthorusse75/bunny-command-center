// SCREENS/ERROR_STATES.md §403: membership confirmed, tier denied (e.g. a
// USER hitting a Guild-Admin-only area). Distinct from
// `GuildNotAccessibleScreen` (non-member, 404) — the 403/404 distinction is
// itself part of the authorization contract (08_AUTHORIZATION_AND_RBAC.md),
// so the two screens intentionally never share wording.
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { PageHeading } from "../navigation/PageHeading.js";

export function ForbiddenScreen(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Box sx={{ maxWidth: 480, textAlign: "center", marginInline: "auto", paddingBlockStart: 8 }}>
      <PageHeading text={t("errors.forbiddenGuild.title")} />
      <Typography variant="body1" color="text.secondary" sx={{ marginBlockEnd: 3 }}>
        {t("errors.forbiddenGuild.body")}
      </Typography>
      <Button component={Link} to="/" variant="contained">
        {t("errors.forbiddenGuild.cta")}
      </Button>
    </Box>
  );
}
