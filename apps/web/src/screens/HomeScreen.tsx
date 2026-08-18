// `/` — Home. SCREENS/HOME.md's "No guild at all" marketing state is the
// ONE piece of real Home content this step ships (it's routing-relevant:
// whether the user has any usable guild at all). Every other widget arrives
// in Step 14 — with at least one usable guild, this renders a deliberately
// near-empty placeholder, not a stub of Step 14's real widgets
// (IMPLEMENTATION/06_multi_guild_navigation.md's own scope line).
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import CircularProgress from "@mui/material/CircularProgress";
import CheckCircleOutlined from "@mui/icons-material/CheckCircleOutlined";
import { useTranslation } from "react-i18next";
import { useGuildList } from "../features/guilds/index.js";
import { PageHeading } from "../navigation/PageHeading.js";

/**
 * EXTERNAL REVIEW CORRECTION (Step 06, Copilot review pass, Finding 5 —
 * product-significant): this screen previously only destructured
 * `data`/`isPending` from `useGuildList()` — a FAILED request (network
 * error, 500, etc.) also resolves to `isPending: false`/`data: undefined`
 * once retries are exhausted, which fell straight through
 * `hasUsableGuild = (data?.guilds.length ?? 0) > 0` into the SUCCESSFUL
 * empty-list marketing state (`ZeroGuildState`) — presenting a genuine
 * technical failure as "you have zero guilds, here's how to get Bunny."
 * `SCREENS/ERROR_STATES.md`'s "500 — Unexpected server error" contract
 * ("[Try again]", never a disguised success state) is now honored via the
 * dedicated `HomeLoadErrorState` below.
 */
function HomeLoadErrorState({
  onRetry,
  isRetrying,
}: {
  onRetry: () => void;
  isRetrying: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Box
      data-testid="home-load-error"
      sx={{ maxWidth: 480, textAlign: "center", marginInline: "auto", paddingBlockStart: 8 }}
    >
      <PageHeading text={t("home.loadError.title")} />
      <Typography variant="body1" color="text.secondary" sx={{ marginBlockEnd: 3 }}>
        {t("home.loadError.body")}
      </Typography>
      <Button data-testid="home-load-error-retry" variant="contained" onClick={onRetry} disabled={isRetrying}>
        {t("common.actions.retry")}
      </Button>
    </Box>
  );
}

const FEATURE_KEYS = [
  "home.zeroGuild.features.upload",
  "home.zeroGuild.features.ocr",
  "home.zeroGuild.features.premiumplus",
  "home.zeroGuild.features.stock",
  "home.zeroGuild.features.leaderboards",
  "home.zeroGuild.features.notifications",
  "home.zeroGuild.features.forecasts",
];

export function HomeScreen(): React.JSX.Element {
  const { t } = useTranslation();
  const { data, isPending, isError, refetch, isRefetching } = useGuildList();

  if (isPending) {
    return (
      <Box role="status" aria-live="polite" sx={{ display: "flex", justifyContent: "center", padding: 6 }}>
        <CircularProgress aria-label={t("common.state.loading")} />
      </Box>
    );
  }

  if (isError) {
    return <HomeLoadErrorState onRetry={() => void refetch()} isRetrying={isRefetching} />;
  }

  const hasUsableGuild = (data?.guilds.length ?? 0) > 0;
  if (!hasUsableGuild) {
    return <ZeroGuildState canInvite={data?.canInviteBunnyAnywhere ?? false} inviteUrl={data?.inviteUrl} />;
  }

  return (
    <Box sx={{ maxWidth: 640 }}>
      <PageHeading text={t("home.placeholder.title")} />
      <Typography variant="body1" color="text.secondary">
        {t("home.placeholder.body")}
      </Typography>
    </Box>
  );
}

/**
 * SCREENS/HOME.md §"No guild at all": "full marketing treatment,
 * illustration, feature list ... Never looks like an error page." Both
 * documented sub-cases are covered: `canInvite` (a real, working
 * Discord-bot-invite link) and the else branch ("Ask your guild's admin to
 * invite Bunny"). Test cases explicitly required for both.
 */
function ZeroGuildState({
  canInvite,
  inviteUrl,
}: {
  canInvite: boolean;
  inviteUrl: string | undefined;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Box
      data-testid="zero-guild-state"
      sx={{ maxWidth: 560, marginInline: "auto", textAlign: "center", paddingBlockStart: 4 }}
    >
      <PageHeading text={t("home.zeroGuild.title")} />
      <Typography variant="body1" color="text.secondary" sx={{ marginBlockEnd: 3 }}>
        {t("home.zeroGuild.tagline")}
      </Typography>
      <List sx={{ textAlign: "start", marginBlockEnd: 3 }}>
        {FEATURE_KEYS.map((key) => (
          <ListItem key={key} disableGutters>
            <ListItemIcon sx={{ minWidth: 36 }}>
              <CheckCircleOutlined color="success" fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={t(key)} />
          </ListItem>
        ))}
      </List>
      {canInvite && inviteUrl ? (
        <Button data-testid="invite-bunny-cta" variant="contained" href={inviteUrl}>
          {t("home.zeroGuild.inviteCta")}
        </Button>
      ) : (
        <Box data-testid="cannot-invite-message">
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            {t("home.zeroGuild.cannotInvite")}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t("home.zeroGuild.cannotInviteBody")}
          </Typography>
        </Box>
      )}
    </Box>
  );
}
