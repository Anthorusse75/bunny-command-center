/**
 * Auth bootstrap for the whole app (04_discord_oauth_sessions.md's
 * frontend/auth scope). Fetches `GET /api/auth/session` once on mount
 * (cookie-based — nothing to pass explicitly, `apiClient.ts` sends
 * `credentials: "include"`), exposes the result as `{status, user}`, and
 * subscribes to the shared 401 interceptor
 * (`apiClient.ts::onSessionExpired`) so ANY later API call's 401 flips
 * `sessionExpired` true for the global banner
 * (SCREENS/AUTH.md §Session expired).
 *
 * Never trusts anything client-supplied as an authorization source of truth
 * (27_SECURITY.md) — this is purely a READBACK of the server's own
 * `requireAuth` decision; the browser-visible `user` object is UI
 * convenience only, never re-used as an authorization check anywhere else in
 * the app.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { apiJson, onSessionExpired } from "./apiClient.js";

export interface AuthUser {
  id: number;
  discordUserId: string;
  username: string;
  avatarHash: string | null;
  locale: string;
  themeName: string;
  themeMode: string;
}

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface SessionResponse {
  user: AuthUser;
  sessionId: string;
  /** Step 06 addition (apps/api/src/auth/routes.ts) — display-only navigation input, never an authorization source (see that route's own doc comment). */
  isSuperadmin: boolean;
}

interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  /** Step 06 addition — see `SessionResponse.isSuperadmin`'s doc comment. `false` while `status !== "authenticated"`. */
  isSuperadmin: boolean;
  /** True once an authenticated request has come back 401 (session revoked/expired mid-use). */
  sessionExpired: boolean;
  /** Begins the OAuth flow (07_DISCORD_OAUTH.md: "GET /api/auth/login (navigation, not XHR)"). `redirectPath` is validated server-side too (`isSafeInternalRedirectPath`) — this is not the security boundary, just UX convenience. */
  login: (redirectPath?: string) => void;
  refresh: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children?: React.ReactNode }): React.JSX.Element {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isSuperadmin, setIsSuperadmin] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    apiJson<SessionResponse>("/api/auth/session", { suppressSessionExpiredNotification: true })
      .then((session) => {
        if (cancelled) return;
        setUser(session.user);
        setIsSuperadmin(session.isSuperadmin);
        setStatus("authenticated");
        setSessionExpired(false);
      })
      .catch(() => {
        if (cancelled) return;
        setUser(null);
        setIsSuperadmin(false);
        setStatus("unauthenticated");
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  useEffect(() => onSessionExpired(() => setSessionExpired(true)), []);

  const login = useCallback((redirectPath?: string) => {
    const target =
      redirectPath ??
      (typeof window !== "undefined" ? window.location.pathname + window.location.search : "/");
    window.location.assign(`/api/auth/login?redirect=${encodeURIComponent(target)}`);
  }, []);

  const refresh = useCallback(() => setRefreshToken((n) => n + 1), []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, isSuperadmin, sessionExpired, login, refresh }),
    [status, user, isSuperadmin, sessionExpired, login, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used inside <AuthProvider>.");
  }
  return value;
}
