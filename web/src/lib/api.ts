import { config } from "../config";

export type AppRole = "admin" | "operator" | "viewer";

export type AppUser = {
  id: string;
  workspaceId: string | null;
  workspaceName: string | null;
  email: string;
  displayName: string | null;
  role: AppRole;
  status: "pending" | "approved" | "rejected" | "suspended";
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

export type SignupRequest = {
  workspaceName: string;
  ownerName: string;
  email: string;
  phone?: string;
  password: string;
};

export type PendingApproval = {
  userId: string;
  workspaceId: string;
  workspaceName: string;
  ownerName: string | null;
  email: string;
  phone: string | null;
  createdAt: string;
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

export const signup = (input: SignupRequest) =>
  apiRequest<{ status: "pending"; message: string }>("/v1/auth/signup", {
    method: "POST",
    body: JSON.stringify(input),
  });

export const logout = (token: string) => apiRequest<void>("/v1/auth/logout", { method: "POST" }, token);
export const fetchSession = (token: string) => apiRequest<Session>("/v1/session", {}, token);
export const fetchBootstrap = (token: string) => apiRequest<BootstrapData>("/v1/bootstrap", {}, token);
export const fetchApprovals = (token: string) =>
  apiRequest<{ requests: PendingApproval[] }>("/v1/admin/approvals", {}, token);
export const approveSignup = (token: string, userId: string) =>
  apiRequest<void>("/v1/admin/approvals/approve", { method: "POST", body: JSON.stringify({ userId }) }, token);
export const rejectSignup = (token: string, userId: string) =>
  apiRequest<void>("/v1/admin/approvals/reject", { method: "POST", body: JSON.stringify({ userId }) }, token);
