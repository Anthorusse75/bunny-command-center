// `/admin/platform/*` — platform-scoped, Superadmin-only
// (03_INFORMATION_ARCHITECTURE.md). Gated on the real, server-computed
// `isSuperadmin` flag from `GET /api/auth/session` (apps/api/src/auth/routes.ts's
// Step 06 addition — see that route's doc comment: a genuine server
// decision, not a client-invented claim), never a client-side guess. No
// second real business endpoint exists for this step's placeholder content
// (see SuperadminScreen.tsx / HeroDiscoveryScreen.tsx for the i18n keys
// those placeholders render) — the real platform-scoped
// `requireTier('SUPERADMIN')` API routes are Step 11's scope
// (`24_API_CONTRACTS.md`'s admin/platform table).
import CircularProgress from "@mui/material/CircularProgress";
import Box from "@mui/material/Box";
import { useTranslation } from "react-i18next";
import { useAuth } from "../features/auth/index.js";
import { ForbiddenScreen } from "../screens/ForbiddenScreen.js";

export function SuperadminRouteGuard({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { t } = useTranslation();
  const { status, isSuperadmin } = useAuth();

  if (status === "loading") {
    return (
      <Box role="status" aria-live="polite" sx={{ display: "flex", justifyContent: "center", padding: 6 }}>
        <CircularProgress aria-label={t("common.state.loading")} />
      </Box>
    );
  }

  if (!isSuperadmin) {
    return <ForbiddenScreen />;
  }

  return <>{children}</>;
}
