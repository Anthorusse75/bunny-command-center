// `/guild/:guildId` — the ONE guild-scoped screen with real (if minimal)
// content this step ships: it reads the real, server-authorized overview
// (`GuildRouteGuard`'s context) and renders the guild's actual name/bot
// presence. Full PremiumPlus/stock/forecast content is Step 13's scope.
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useTranslation } from "react-i18next";
import { useGuildOverviewContext } from "../navigation/GuildRouteGuard.js";
import { PageHeading } from "../navigation/PageHeading.js";

export function GuildOverviewScreen(): React.JSX.Element {
  const { t } = useTranslation();
  const overview = useGuildOverviewContext();
  const title = overview.displayName
    ? t("guild.overview.title", { guildName: overview.displayName })
    : t("guild.overview.titleFallback");

  return (
    <Box sx={{ maxWidth: 640 }}>
      <PageHeading text={title} />
      {!overview.botPresent ? (
        <Typography variant="body1" color="warning.main" sx={{ marginBlockEnd: 2 }}>
          {t("guild.overview.botNotPresent")}
        </Typography>
      ) : null}
      <Typography variant="body1" color="text.secondary">
        {t("guild.overview.placeholderBody")}
      </Typography>
    </Box>
  );
}
