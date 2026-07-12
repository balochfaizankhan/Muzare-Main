import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from "react";
import { ApiError, fetchSession, login as loginRequest, logout as logoutRequest, selectWorkspace, type AppUser } from "../lib/api";
import { setPermissionContextUser } from "../lib/permissions";
import { queryClient } from "../lib/query-client";
import { markStartup } from "../lib/startupPerf";

const tokenKey = "muzare-session-token";
const cachedUserKey = "muzare-cached-user";
const lastWorkspaceKey = "muzare-last-workspace-id";
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

async function reconcileWorkspacePreference(
  token: string,
  user: AppUser,
): Promise<AppUser> {
  const preferredWorkspaceId = window.localStorage.getItem(lastWorkspaceKey);
  if (!preferredWorkspaceId || preferredWorkspaceId === user.workspaceId) return user;
  if (!user.memberships.some((membership) => membership.active && membership.workspaceId === preferredWorkspaceId)) return user;
  const session = await selectWorkspace(token, preferredWorkspaceId);
  return session.user;
}

async function clearWorkspaceCache() {
  const { clearWorkspaceCache: clearWorkspaceCacheFromSync } = await import("../services/syncService");
  await clearWorkspaceCacheFromSync();
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const [user, setUser] = useState<AppUser | null>(() => cachedUser());
  const [token, setToken] = useState<string | null>(() => window.localStorage.getItem(tokenKey));
  const [loading, setLoading] = useState(() => Boolean(window.localStorage.getItem(tokenKey)) && !cachedUser());
  const [sessionRefreshing, setSessionRefreshing] = useState(() => Boolean(window.localStorage.getItem(tokenKey)));

  useEffect(() => {
    setPermissionContextUser(sessionRefreshing ? null : user);
  }, [sessionRefreshing, user]);

  useEffect(() => {
    if (!token) {
      setUser(null);
      setLoading(false);
      setSessionRefreshing(false);
      markStartup("session-cleared");
      return;
    }

    let active = true;
    if (!cachedUser()) setLoading(true);
    setSessionRefreshing(true);
    markStartup("session-refresh-start");
    void fetchSession(token)
      .then((session) => {
        if (active) {
          window.localStorage.setItem(cachedUserKey, JSON.stringify(session.user));
          if (session.user.workspaceId) window.localStorage.setItem(lastWorkspaceKey, session.user.workspaceId);
          setUser(session.user);
          markStartup("session-restored", { workspaceId: session.user.workspaceId, role: session.user.role });
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (!(error instanceof ApiError && [401, 403].includes(error.status)) && cachedUser()) {
          setUser(cachedUser());
          markStartup("session-restored-from-cache");
          return;
        }
        window.localStorage.removeItem(tokenKey);
        window.localStorage.removeItem(cachedUserKey);
        void clearWorkspaceCache();
        queryClient.clear();
        setToken(null);
        setUser(null);
        markStartup("session-invalidated", { status: error instanceof ApiError ? error.status : "unknown" });
      })
      .finally(() => {
        if (active) {
          setLoading(false);
          setSessionRefreshing(false);
          markStartup("session-refresh-finished");
        }
      });

    return () => {
      active = false;
    };
  }, [token]);

  const login = useCallback(async (email: string, password: string) => {
    const session = await loginRequest(email, password);
    const nextUser = await reconcileWorkspacePreference(session.token, session.user);
    window.localStorage.setItem(tokenKey, session.token);
    window.localStorage.setItem(cachedUserKey, JSON.stringify(nextUser));
    if (nextUser.workspaceId) window.localStorage.setItem(lastWorkspaceKey, nextUser.workspaceId);
    setToken(session.token);
    setUser(nextUser);
    markStartup("login-complete", { workspaceId: nextUser.workspaceId, role: nextUser.role });
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
    markStartup("logout-complete");
  }, [token]);

  const switchWorkspace = useCallback(async (workspaceId: string) => {
    if (!token || workspaceId === user?.workspaceId) return;
    const session = await selectWorkspace(token, workspaceId);
    await clearWorkspaceCache();
    queryClient.clear();
    window.localStorage.setItem(cachedUserKey, JSON.stringify(session.user));
    window.localStorage.setItem(lastWorkspaceKey, workspaceId);
    setUser(session.user);
    markStartup("workspace-switched", { workspaceId });
  }, [token, user?.workspaceId]);

  const updateUser = useCallback((nextUser: AppUser) => {
    window.localStorage.setItem(cachedUserKey, JSON.stringify(nextUser));
    if (nextUser.workspaceId) window.localStorage.setItem(lastWorkspaceKey, nextUser.workspaceId);
    setUser(nextUser);
  }, []);

  const completeSession = useCallback(async (nextToken: string, nextUser: AppUser) => {
    window.localStorage.setItem(tokenKey, nextToken);
    window.localStorage.setItem(cachedUserKey, JSON.stringify(nextUser));
    if (nextUser.workspaceId) window.localStorage.setItem(lastWorkspaceKey, nextUser.workspaceId);
    await clearWorkspaceCache();
    queryClient.clear();
    setToken(nextToken);
    setUser(nextUser);
    markStartup("session-completed", { workspaceId: nextUser.workspaceId, role: nextUser.role });
  }, []);

  const value = useMemo(() => ({ user, token, loading, sessionRefreshing, login, logout, switchWorkspace, updateUser, completeSession }), [user, token, loading, sessionRefreshing, login, logout, switchWorkspace, updateUser, completeSession]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider.");
  return context;
}
