import { config } from "../config";

export type AppRole = "admin" | "operator" | "viewer";

export type AppUser = {
  id: string;
  email: string;
  displayName: string | null;
  role: AppRole;
};

export type Session = {
  user: AppUser;
  permissions: {
    canWrite: boolean;
    canAdminister: boolean;
  };
};

export type LoginResult = {
  token: string;
  user: AppUser;
};

export type BootstrapData = {
  user: AppUser;
  farms: Array<{ id: string; name: string; location: string | null; owner: string | null }>;
  seasons: Array<{ id: string; farmId: string; name: string; year: number }>;
};

async function apiRequest<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(`${config.apiUrl}${path}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `Request failed with status ${response.status}.`);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const login = (email: string, password: string) =>
  apiRequest<LoginResult>("/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });

export const logout = (token: string) => apiRequest<void>("/v1/auth/logout", { method: "POST" }, token);
export const fetchSession = (token: string) => apiRequest<Session>("/v1/session", {}, token);
export const fetchBootstrap = (token: string) => apiRequest<BootstrapData>("/v1/bootstrap", {}, token);
