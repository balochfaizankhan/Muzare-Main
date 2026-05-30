import { config } from "../config";

export type PlatformRole = "platform_admin" | "platform_support";
export type WorkspaceRole = "workspace_owner" | "workspace_manager" | "supervisor" | "operator" | "viewer";
export type AppRole = PlatformRole | WorkspaceRole;
export type Permission =
  | "CREATE_WORKSPACE" | "DELETE_WORKSPACE" | "VIEW_WORKSPACES" | "VIEW_USERS" | "MANAGE_SUBSCRIPTIONS"
  | "MANAGE_BILLING" | "MANAGE_PLATFORM_SETTINGS" | "VIEW_AUDIT_LOGS" | "VIEW_SYSTEM_HEALTH"
  | "APPROVE_EXPENSE" | "APPROVE_ATTENDANCE" | "APPROVE_SALE" | "APPROVE_DISPATCH"
  | "MANAGE_TEAM" | "MANAGE_RECORDS" | "SUBMIT_RECORDS" | "VIEW_REPORTS";

export type AppUser = {
  id: string;
  workspaceId: string | null;
  workspaceName: string | null;
  email: string;
  displayName: string | null;
  role: AppRole;
  platformRole: PlatformRole | null;
  memberships: Array<{ workspaceId: string; workspaceName: string; role: WorkspaceRole; active: boolean }>;
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

export type AdminDashboardData = {
  totalWorkspaces: number; activeWorkspaces: number; suspendedWorkspaces: number; pendingWorkspaceRequests: number;
  totalUsers: number; totalActiveUsers: number; subscriptionRevenue: number; expiringSubscriptions: number; systemHealth: string;
};
export type AdminWorkspace = {
  id: string; name: string; slug: string; contactEmail: string; contactPhone: string | null;
  status: "pending" | "approved" | "rejected" | "suspended"; createdAt: string;
};
export type OperationalEntity = "labourer" | "attendance" | "account" | "advance" | "dispatch" | "sale" | "voucher" | "partnerEntry" | "inventoryEntry";
export type OperationalRecordEnvelope = {
  workspaceId: string; farmId?: string | null; seasonId?: string | null; entity: OperationalEntity;
  record: { id: string; createdAt: string; updatedAt: string; [key: string]: unknown };
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
export const fetchAdminDashboard = (token: string) => apiRequest<AdminDashboardData>("/v1/admin/dashboard", {}, token);
export const fetchAdminWorkspaces = (token: string) => apiRequest<{ workspaces: AdminWorkspace[] }>("/v1/admin/workspaces", {}, token);
export const createAdminWorkspace = (token: string, input: { name: string; contactEmail: string }) =>
  apiRequest<void>("/v1/admin/workspaces", { method: "POST", body: JSON.stringify(input) }, token);
export const suspendAdminWorkspace = (token: string, workspaceId: string) =>
  apiRequest<void>(`/v1/admin/workspaces/${workspaceId}/suspend`, { method: "POST" }, token);
export const deleteAdminWorkspace = (token: string, workspaceId: string) =>
  apiRequest<void>(`/v1/admin/workspaces/${workspaceId}`, { method: "DELETE" }, token);
export const fetchApprovals = (token: string) =>
  apiRequest<{ requests: PendingApproval[] }>("/v1/admin/approvals", {}, token);
export const approveSignup = (token: string, userId: string) =>
  apiRequest<void>("/v1/admin/approvals/approve", { method: "POST", body: JSON.stringify({ userId }) }, token);
export const rejectSignup = (token: string, userId: string) =>
  apiRequest<void>("/v1/admin/approvals/reject", { method: "POST", body: JSON.stringify({ userId }) }, token);
export const saveOperationalRecord = (token: string, input: OperationalRecordEnvelope) =>
  apiRequest<{ record: OperationalRecordEnvelope["record"]; conflict: boolean }>("/v1/workspace/operational-records", { method: "POST", body: JSON.stringify(input) }, token);
export const fetchOperationalRecords = (token: string, workspaceId: string) =>
  apiRequest<{ records: OperationalRecordEnvelope[] }>(`/v1/workspace/${workspaceId}/operational-records`, {}, token);
