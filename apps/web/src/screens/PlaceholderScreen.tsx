// Generic placeholder content for every domain this step routes to but
// doesn't build the real feature for yet (IMPLEMENTATION/06_multi_guild_navigation.md:
// "placeholder/'coming soon' content for every domain not yet built").
// Deliberately NOT a generic "Something went wrong"-style error page
// (SCREENS/ERROR_STATES.md's rule applies to failures; this is a genuinely
// successful, authorized render of a not-yet-built area) — each caller
// supplies its own specific, per-domain i18n title/body key, never shared
// generic wording, so a screen reader user and a sighted user both get a
// real answer to "what is this page for" rather than a blank "coming soon".
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useTranslation } from "react-i18next";
import { PageHeading } from "../navigation/PageHeading.js";

export interface PlaceholderScreenProps {
  titleKey: string;
  bodyKey: string;
}

export function PlaceholderScreen({ titleKey, bodyKey }: PlaceholderScreenProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Box sx={{ maxWidth: 640 }}>
      <PageHeading text={t(titleKey)} />
      <Typography variant="body1" color="text.secondary">
        {t(bodyKey)}
      </Typography>
    </Box>
  );
}
