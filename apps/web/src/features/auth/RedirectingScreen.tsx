// SCREENS/AUTH.md §OAuth redirect/loading: "a full-page loading state with
// the Bunny CC mark and a spinner, no interactive content". Reused as the
// app's initial auth-bootstrap loading state too (checking
// `GET /api/auth/session` before anything else can render) — the spec
// defines no separate visual for that moment, and reusing this one is the
// smallest robust choice consistent with the architecture (documented in
// this step's HANDOVER).
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Typography from "@mui/material/Typography";
import { useTranslation } from "react-i18next";

export function RedirectingScreen(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Box
      data-testid="auth-redirecting-screen"
      role="status"
      sx={(theme) => ({
        minHeight: "100dvh",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 2,
        backgroundColor: theme.vars.palette.bcc.surface.default,
      })}
    >
      <CircularProgress aria-hidden="true" />
      <Typography variant="body2" color="text.secondary">
        {t("auth.redirecting")}
      </Typography>
    </Box>
  );
}
