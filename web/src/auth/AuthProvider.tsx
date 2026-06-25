import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from "react";
import { ApiError, fetchSession, login as loginRequest, logout as logoutRequest, selectWorkspace, type AppUser } from "../lib/api";
import { queryClient } from "../lib/query-client";
import { clearWorkspaceCache } from "../services/syncService";

const tokenKey = "muzare-session-token";
const cachedUserKey = "muzare-cached-user";
const cachedUser = () => {
  try {
    return JSON.parse(window.localStorage.getItem(cachedUserKey) ?? "null") as AppUser | null;
  } catch {
    return null;
  }
};

type AuthState = {
  user: AppUser | null;
  token: string | null;
  loading: boolean;
  sessionRefreshing: boolean;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  switchWorkspace(workspaceId: string): Promise<void>;
  updateUser(user: AppUser): void;
  completeSession(token: string, user: AppUser): Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const [user, setUser] = useState<AppUser | null>(() => cachedUser());
  const [token, setToken] = useState<string | null>(() => window.localStorage.getItem(tokenKey));
  const [loading, setLoading] = useState(() => Boolean(window.localStorage.getItem(tokenKey)) && !cachedUser());
  const [sessionRefreshing, setSessionRefreshing] = useState(() => Boolean(window.localStorage.getItem(tokenKey)));

  useEffect(() => {
    if (!token) {
      setUser(null);
      setLoading(false);
      setSessionRefreshing(false);
      return;
    }

    let active = true;
    if (!cachedUser()) setLoading(true);
    setSessionRefreshing(true);
    void fetchSession(token)
      .then((session) => {
        if (active) {
          window.localStorage.setItem(cachedUserKey, JSON.stringify(session.user));
          setUser(session.user);
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (!(error instanceof ApiError && [401, 403].includes(error.status)) && cachedUser()) {
          setUser(cachedUser());
          return;
        }
        window.localStorage.removeItem(tokenKey);
        window.localStorage.removeItem(cachedUserKey);
        void clearWorkspaceCache();
        queryClient.clear();
        setToken(null);
        setUser(null);
      })
      .finally(() => {
        if (active) {
          setLoading(false);
          setSessionRefreshing(false);
        }
      });

    return () => {
      active = false;
    };
  }, [token]);

  const login = useCallback(async (email: string, password: string) => {
    const session = await loginRequest(email, password);
    window.localStorage.setItem(tokenKey, session.token);
    window.localStorage.setItem(cachedUserKey, JSON.stringify(session.user));
    setToken(session.token);
    setUser(session.user);
  }, []);

  const logout = useCallback(async () => {
    if (token) {
      await logoutRequest(token).catch(() => undefined);
    }
    window.localStorage.removeItem(tokenKey);
    window.localStorage.removeItem(cachedUserKey);
    await clearWorkspaceCache();
    queryClient.clear();
    setToken(null);
    setUser(null);
  }, [token]);

  const switchWorkspace = useCallback(async (workspaceId: string) => {
    if (!token || workspaceId === user?.workspaceId) return;
    const session = await selectWorkspace(token, workspaceId);
    await clearWorkspaceCache();
    queryClient.clear();
    window.localStorage.setItem(cachedUserKey, JSON.stringify(session.user));
    setUser(session.user);
  }, [token, user?.workspaceId]);

  const updateUser = useCallback((nextUser: AppUser) => {
    window.localStorage.setItem(cachedUserKey, JSON.stringify(nextUser));
    setUser(nextUser);
  }, []);

  const completeSession = useCallback(async (nextToken: string, nextUser: AppUser) => {
    window.localStorage.setItem(tokenKey, nextToken);
    window.localStorage.setItem(cachedUserKey, JSON.stringify(nextUser));
    await clearWorkspaceCache();
    queryClient.clear();
    setToken(nextToken);
    setUser(nextUser);
  }, []);

  const value = useMemo(() => ({ user, token, loading, sessionRefreshing, login, logout, switchWorkspace, updateUser, completeSession }), [user, token, loading, sessionRefreshing, login, logout, switchWorkspace, updateUser, completeSession]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider.");
  return context;
}
