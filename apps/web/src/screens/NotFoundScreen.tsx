// SCREENS/ERROR_STATES.md §404: "Standard 'This page doesn't exist' with a
// link Home — used for genuinely unknown routes". This is the React Router
// data router's `errorElement`/catch-all match, NOT the guild-specific
// "no longer accessible" state (`GuildNotAccessibleScreen.tsx` — a distinct
// wording per ERROR_STATES.md's "every failure mode is handled honestly and
// specifically").
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { PageHeading } from "../navigation/PageHeading.js";

export function NotFoundScreen(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Box sx={{ maxWidth: 480, textAlign: "center", marginInline: "auto", paddingBlockStart: 8 }}>
      <PageHeading text={t("errors.notFoundPage.title")} />
      <Typography variant="body1" color="text.secondary" sx={{ marginBlockEnd: 3 }}>
        {t("errors.notFoundPage.body")}
      </Typography>
      <Button component={Link} to="/" variant="contained">
        {t("errors.notFoundPage.cta")}
      </Button>
    </Box>
  );
}
