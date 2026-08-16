// The single place that decides which of SCREENS/AUTH.md's states renders:
// loading -> Login (+ OAuth error, driven by ?error=) -> authenticated
// children, with the session-expired overlay layered on top whenever it
// applies. `apps/web/src/app/App.tsx` mounts this once, wrapping the whole
// authenticated app surface — Step 06's real router replaces "children" with
// real routes without needing to touch this gating logic.
import { useCallback, useState } from "react";
import { useAuth } from "./AuthProvider.js";
import { LoginScreen } from "./LoginScreen.js";
import { OAuthErrorScreen, isOAuthErrorReason } from "./OAuthErrorScreen.js";
import { RedirectingScreen } from "./RedirectingScreen.js";
import { SessionExpiredBanner } from "./SessionExpiredBanner.js";

function readErrorParam(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("error");
}

function clearErrorParam(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.delete("error");
  window.history.replaceState(null, "", url.pathname + url.search);
}

export function AuthGate({ children }: { children?: React.ReactNode }): React.JSX.Element {
  const { status, sessionExpired } = useAuth();
  const [errorParam, setErrorParam] = useState<string | null>(() => readErrorParam());

  const handleTryAgain = useCallback(() => {
    clearErrorParam();
    setErrorParam(null);
  }, []);

  if (status === "loading") {
    return <RedirectingScreen />;
  }

  if (status === "unauthenticated") {
    if (errorParam && isOAuthErrorReason(errorParam)) {
      return <OAuthErrorScreen reason={errorParam} onTryAgain={handleTryAgain} />;
    }
    return <LoginScreen />;
  }

  return (
    <>
      {children}
      {sessionExpired ? <SessionExpiredBanner /> : null}
    </>
  );
}
