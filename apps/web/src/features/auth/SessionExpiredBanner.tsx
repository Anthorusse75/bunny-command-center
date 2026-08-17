// SCREENS/AUTH.md §Session expired (mid-session): "an in-context
// banner/toast (not a full-page redirect if avoidable) ... preserves the
// current view behind a dimmed overlay so the user doesn't lose their
// place." Rendered globally by AuthGate whenever `useAuth().sessionExpired`
// is true — driven by apiClient.ts's shared 401 interceptor, "not per-screen
// bespoke handling."
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import { useTranslation } from "react-i18next";
import { useAuth } from "./AuthProvider.js";

export function SessionExpiredBanner(): React.JSX.Element {
  const { t } = useTranslation();
  const { login } = useAuth();

  return (
    <Box
      data-testid="session-expired-overlay"
      role="alertdialog"
      aria-labelledby="session-expired-message"
      sx={(theme) => ({
        position: "fixed",
        inset: 0,
        zIndex: theme.zIndex.modal,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        // Dimmed overlay behind the banner (spec: "preserves the current
        // view behind a dimmed overlay"), the banner itself sits above it.
        backgroundColor: theme.vars.palette.bcc.scrim,
        paddingTop: 4,
      })}
    >
      <Box
        data-testid="session-expired-banner"
        sx={(theme) => ({
          display: "flex",
          alignItems: "center",
          gap: 2,
          padding: 2,
          borderRadius: `${theme.bcc.radius.md}px`,
          backgroundColor: theme.vars.palette.bcc.surface.elevated,
          boxShadow: theme.shadows[8],
        })}
      >
        <Typography id="session-expired-message" variant="body1">
          {t("auth.sessionExpired.message")}
        </Typography>
        <Button
          variant="contained"
          size="small"
          onClick={() => login()}
          data-testid="session-expired-login-again"
        >
          {t("auth.sessionExpired.loginAgain")}
        </Button>
      </Box>
    </Box>
  );
}
