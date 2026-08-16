// SCREENS/AUTH.md §OAuth error — "three distinct causes, each its own
// message_key ... never a raw Discord error string surfaced to the user."
// Same content on mobile/desktop (the spec's own wireframe note: "an error
// state doesn't need desktop-specific layout").
import { useEffect, useRef } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import { useTranslation } from "react-i18next";
import { useBccIcon } from "../../design-system/icons.js";

export type OAuthErrorReason = "oauth_denied" | "state_mismatch" | "token_exchange_failed";

const REASON_TO_KEY: Record<OAuthErrorReason, string> = {
  oauth_denied: "auth.error.denied",
  state_mismatch: "auth.error.stateMismatch",
  token_exchange_failed: "auth.error.tokenExchangeFailed",
};

export function isOAuthErrorReason(value: string | null): value is OAuthErrorReason {
  return value === "oauth_denied" || value === "state_mismatch" || value === "token_exchange_failed";
}

export function OAuthErrorScreen({
  reason,
  onTryAgain,
}: {
  reason: OAuthErrorReason;
  onTryAgain: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const WarningIcon = useBccIcon("alert-triangle");
  const headingRef = useRef<HTMLHeadingElement>(null);

  // ACCESSIBILITY: "error heading is the page's h1, receives focus on
  // render (screen-reader users land directly on the explanation)."
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <Box
      data-testid="oauth-error-screen"
      sx={(theme) => ({
        minHeight: "100dvh",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 2,
        padding: 3,
        textAlign: "center",
        backgroundColor: theme.vars.palette.bcc.surface.default,
      })}
    >
      <WarningIcon color="warning" sx={{ fontSize: 48 }} aria-hidden="true" />
      <Typography
        variant="h1"
        component="h1"
        tabIndex={-1}
        ref={headingRef}
        sx={{ outline: "none" }}
        data-testid="oauth-error-heading"
      >
        {t("auth.error.heading")}
      </Typography>
      <Typography
        variant="body1"
        color="text.secondary"
        sx={{ maxWidth: 420 }}
        data-testid="oauth-error-detail"
      >
        {t(REASON_TO_KEY[reason])}
      </Typography>
      <Button variant="contained" onClick={onTryAgain} data-testid="oauth-error-try-again">
        {t("auth.error.tryAgain")}
      </Button>
    </Box>
  );
}
