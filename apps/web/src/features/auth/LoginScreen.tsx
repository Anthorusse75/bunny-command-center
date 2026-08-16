// SCREENS/AUTH.md §Login — single entry point, unauthenticated. Same
// component renders both the mobile and desktop wireframes (MUI breakpoints
// swap the layout, matching `AppShell`'s existing responsive convention —
// `useIsDesktopLayout`), never two separate components for one screen.
import { useState } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import { useTranslation } from "react-i18next";
import { useIsDesktopLayout } from "../../theme/useBreakpoints.js";
import { useAuth } from "./AuthProvider.js";
import { LocaleSelector } from "../../theme/components/AppearanceSelectors.js";

export function LoginScreen(): React.JSX.Element {
  const { t } = useTranslation();
  const { login } = useAuth();
  const isDesktop = useIsDesktopLayout();
  const [redirecting, setRedirecting] = useState(false);

  const handleLogin = (): void => {
    // STATES: "loading (CTA shows a spinner while the redirect is in
    // flight, disabled to prevent double-click)" — the redirect itself is a
    // real full-page navigation (window.location.assign), so this state is
    // only ever visible for the brief window before the browser actually
    // leaves the page.
    setRedirecting(true);
    login();
  };

  return (
    <Box
      data-testid="login-screen"
      sx={(theme) => ({
        minHeight: "100dvh",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: theme.vars.palette.bcc.surface.default,
      })}
    >
      <Box sx={{ display: "flex", justifyContent: "flex-end", padding: 2 }}>
        <LocaleSelector />
      </Box>
      <Box
        sx={{
          flexGrow: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 3,
          gap: 4,
          flexDirection: isDesktop ? "row" : "column",
        }}
      >
        {isDesktop ? (
          <Box
            data-testid="login-illustration"
            aria-hidden="true"
            sx={(theme) => ({
              width: 320,
              height: 320,
              borderRadius: `${theme.bcc.radius.lg}px`,
              backgroundColor: theme.vars.palette.bcc.surface.elevated,
              border: `1px solid ${theme.vars.palette.bcc.border}`,
            })}
          />
        ) : null}

        <Box
          sx={{
            maxWidth: 420,
            display: "flex",
            flexDirection: "column",
            gap: 2,
            textAlign: isDesktop ? "left" : "center",
          }}
        >
          <Typography variant={isDesktop ? "h2" : "h1"} component="h1">
            {t("auth.login.title")}
          </Typography>
          <Typography variant="body1" color="text.secondary">
            {t("auth.login.tagline")}
          </Typography>
          <Button
            variant="contained"
            size="large"
            onClick={handleLogin}
            disabled={redirecting}
            data-testid="login-cta"
            startIcon={redirecting ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            {t("auth.login.cta")}
          </Button>
        </Box>
      </Box>
    </Box>
  );
}
