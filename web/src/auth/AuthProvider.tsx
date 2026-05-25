import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from "react";
import { fetchSession, login as loginRequest, logout as logoutRequest, type AppUser } from "../lib/api";

const tokenKey = "muzare-session-token";

type AuthState = {
  user: AppUser | null;
  token: string | null;
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [token, setToken] = useState<string | null>(() => window.localStorage.getItem(tokenKey));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    void fetchSession(token)
      .then((session) => {
        if (active) setUser(session.user);
      })
      .catch(() => {
        if (!active) return;
        window.localStorage.removeItem(tokenKey);
        setToken(null);
        setUser(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [token]);

  const login = useCallback(async (email: string, password: string) => {
    const session = await loginRequest(email, password);
    window.localStorage.setItem(tokenKey, session.token);
    setToken(session.token);
    setUser(session.user);
  }, []);

  const logout = useCallback(async () => {
    if (token) {
      await logoutRequest(token).catch(() => undefined);
    }
    window.localStorage.removeItem(tokenKey);
    setToken(null);
    setUser(null);
  }, [token]);

  const value = useMemo(() => ({ user, token, loading, login, logout }), [user, token, loading, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider.");
  return context;
}
