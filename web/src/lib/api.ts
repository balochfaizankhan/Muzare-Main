import { config } from "../config";

export type PlatformRole = "platform_admin" | "platform_support";
export type WorkspaceRole = "workspace_owner" | "workspace_manager" | "supervisor" | "operator" | "viewer";
export type AppRole = PlatformRole | WorkspaceRole;
export type Permission =
  | "CREATE_WORKSPACE" | "DELETE_WORKSPACE" | "VIEW_WORKSPACES" | "VIEW_USERS" | "MANAGE_SUBSCRIPTIONS"
  | "MANAGE_BILLING" | "MANAGE_PLATFORM_SETTINGS" | "VIEW_AUDIT_LOGS" | "VIEW_SYSTEM_HEALTH"
  | "APPROVE_EXPENSE" | "APPROVE_ATTENDANCE" | "APPROVE_SALE" | "APPROVE_DISPATCH"
  | "MANAGE_TEAM" | "MANAGE_FARMS" | "MANAGE_SEASONS" | "MANAGE_EXPENSE_CATEGORIES" | "IMPORT_ATTENDANCE" | "MANAGE_RECORDS" | "SUBMIT_RECORDS" | "VIEW_REPORTS";

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
  activeFarmId: string | null;
  activeSeasonId: string | null;
  farms: Farm[];
  seasons: Season[];
};

export type Farm = {
  id: string; workspaceId: string; name: string; location: string | null; owner: string | null; remarks: string | null;
  contactName: string | null; contactEmail: string | null; contactPhone: string | null; active: boolean;
};

export type FarmInput = {
  name: string; location?: string; owner?: string; remarks?: string;
  contactName?: string; contactEmail?: string; contactPhone?: string;
};

export type SeasonStatus = "planned" | "active" | "closed" | "archived";
export type Season = {
  id: string; workspaceId: string; farmId: string; name: string; cropType: string | null; year: number;
  startsOn: string; expectedEndsOn: string | null; actualEndsOn: string | null; status: SeasonStatus; notes: string | null;
};
export type SeasonInput = {
  name: string; cropType?: string; startsOn: string; expectedEndsOn?: string; actualEndsOn?: string;
  status: SeasonStatus; notes?: string;
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
export type AttendanceReportStatus = "present" | "half_day" | "absent";
export type AttendanceReportRecord = {
  id: string; labourerId: string; labourName: string; dailyWage: number; date: string; status: AttendanceReportStatus;
};
export type AttendanceReportSummary = {
  id: string; name: string; dailyWage: number; presentDays: number; halfDays: number; absentDays: number;
  payableDays: number; totalWage: number; records: AttendanceReportRecord[];
};
export type AttendanceReportAdvance = { id: string; labourerId: string; date: string; amount: number };
export type AttendanceReportData = {
  records: AttendanceReportRecord[]; summaries: AttendanceReportSummary[]; advances: AttendanceReportAdvance[]; dates: string[];
  metadata: { farmName: string; seasonName: string; from: string; to: string; generatedAt: string; generatedBy: string } | null;
};
export type AttendanceReportFilters = {
  farmId: string; seasonId: string; from: string; to: string; labourId?: string; status?: AttendanceReportStatus;
};
export type AttendanceImportCell = { column: string; date: string; status: AttendanceReportStatus | null; advanceAmount: number | null; raw: string };
export type AttendanceImportRow = {
  rowIndex: number; labourName: string; cells: AttendanceImportCell[]; matchedLabourerId: string | null; suggestedLabourerId: string | null;
  csvAdvance: number | null; calculatedAdvance: number;
};
export type AttendanceImportPreview = {
  rows: AttendanceImportRow[]; dateColumns: Array<{ column: string; date: string }>; errors: string[]; warnings: string[];
  labourers: Array<{ id: string; name: string; dailyWage: number }>;
  summary: {
    labourRows: number; dateColumns: number; attendanceRecords: number; dailyAdvances: number; advanceTotal: number;
    duplicateRecords: number; duplicateAdvances: number; advanceRecordsToCreate: number;
    unknownLabourRows: number; errors: string[]; warnings: string[];
  };
};
export type AttendanceImportMapping = { rowIndex: number; action: "match" | "create" | "skip"; labourerId?: string; dailyWage?: number; group?: string };
export type AttendanceImportResult = {
  attendanceCreated: number; attendanceUpdated: number; attendanceSkipped: number; advancesCreated: number; duplicateAdvancesSkipped: number;
  totalAdvanceImported: number; labourersCreated: number; errors: string[];
};
export type ExpenseSubcategory = { id: string; categoryId: string; name: string; sortOrder: number; isSystem: boolean; active: boolean };
export type ExpenseCategory = { id: string; name: string; sortOrder: number; isSystem: boolean; subcategories: ExpenseSubcategory[] };

async function apiRequest<T>(path: string, options: RequestInit = {}, token?: string, requestOptions: { timeoutMs?: number; debugLabel?: string } = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const controller = new AbortController();
  const timeout = requestOptions.timeoutMs ? window.setTimeout(() => controller.abort(), requestOptions.timeoutMs) : null;
  if (import.meta.env.DEV && requestOptions.debugLabel) console.info(`[${requestOptions.debugLabel}] request`, options.body ? JSON.parse(String(options.body)) : undefined);
  let response: Response;
  try {
    response = await fetch(`${config.apiUrl}${path}`, { ...options, headers, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Import is taking longer than expected. Please check import history or try again.");
    throw error;
  } finally {
    if (timeout) window.clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string; fields?: string[] } | null;
    if (import.meta.env.DEV && requestOptions.debugLabel) console.error(`[${requestOptions.debugLabel}] response`, response.status, body);
    const fields = body?.fields?.length ? ` Missing or invalid fields: ${body.fields.join(", ")}.` : "";
    throw new Error(`${body?.message ?? `Request failed with status ${response.status}.`}${fields}`);
  }

  if (response.status === 204) return undefined as T;
  const body = (await response.json()) as T;
  if (import.meta.env.DEV && requestOptions.debugLabel) console.info(`[${requestOptions.debugLabel}] response`, response.status, body);
  return body;
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
export const selectWorkspace = (token: string, workspaceId: string) =>
  apiRequest<{ user: AppUser }>("/v1/session/workspace", { method: "POST", body: JSON.stringify({ workspaceId }) }, token);
export const fetchBootstrap = (token: string) => apiRequest<BootstrapData>("/v1/bootstrap", {}, token);
export const fetchWorkspaceFarms = (token: string, workspaceId: string) =>
  apiRequest<{ farms: Farm[]; activeFarmId: string | null }>(`/v1/workspace/${workspaceId}/farms`, {}, token);
export const createWorkspaceFarm = (token: string, workspaceId: string, input: FarmInput) =>
  apiRequest<{ farm: Farm }>(`/v1/workspace/${workspaceId}/farms`, { method: "POST", body: JSON.stringify(input) }, token);
export const updateWorkspaceFarm = (token: string, workspaceId: string, farmId: string, input: FarmInput) =>
  apiRequest<{ farm: Farm }>(`/v1/workspace/${workspaceId}/farms/${farmId}`, { method: "PATCH", body: JSON.stringify(input) }, token);
export const archiveWorkspaceFarm = (token: string, workspaceId: string, farmId: string) =>
  apiRequest<void>(`/v1/workspace/${workspaceId}/farms/${farmId}/archive`, { method: "POST" }, token);
export const selectActiveFarm = (token: string, workspaceId: string, farmId: string) =>
  apiRequest<void>(`/v1/workspace/${workspaceId}/farms/${farmId}/select`, { method: "POST" }, token);
export const fetchFarmSeasons = (token: string, workspaceId: string, farmId: string) =>
  apiRequest<{ seasons: Season[]; activeSeasonId: string | null }>(`/v1/workspace/${workspaceId}/farms/${farmId}/seasons`, {}, token);
export const createFarmSeason = (token: string, workspaceId: string, farmId: string, input: SeasonInput) =>
  apiRequest<{ season: Season }>(`/v1/workspace/${workspaceId}/farms/${farmId}/seasons`, { method: "POST", body: JSON.stringify(input) }, token);
export const updateFarmSeason = (token: string, workspaceId: string, farmId: string, seasonId: string, input: SeasonInput) =>
  apiRequest<{ season: Season }>(`/v1/workspace/${workspaceId}/farms/${farmId}/seasons/${seasonId}`, { method: "PATCH", body: JSON.stringify(input) }, token);
export const selectActiveSeason = (token: string, workspaceId: string, farmId: string, seasonId: string) =>
  apiRequest<void>(`/v1/workspace/${workspaceId}/farms/${farmId}/seasons/${seasonId}/select`, { method: "POST" }, token);
export const archiveFarmSeason = (token: string, workspaceId: string, farmId: string, seasonId: string) =>
  apiRequest<void>(`/v1/workspace/${workspaceId}/farms/${farmId}/seasons/${seasonId}/archive`, { method: "POST" }, token);
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
export const fetchAttendanceReport = (token: string, workspaceId: string, filters: AttendanceReportFilters) => {
  const query = new URLSearchParams({
    farmId: filters.farmId, seasonId: filters.seasonId, from: filters.from, to: filters.to,
  });
  if (filters.labourId) query.set("labourId", filters.labourId);
  if (filters.status) query.set("status", filters.status);
  return apiRequest<AttendanceReportData>(
    `/v1/workspace/${workspaceId}/attendance/report?${query.toString()}`, {}, token,
  );
};
export const fetchExpenseCategories = (token: string, workspaceId: string) =>
  apiRequest<{ categories: ExpenseCategory[] }>(`/v1/workspace/${workspaceId}/expense-categories`, {}, token);
export const createExpenseSubcategory = (token: string, workspaceId: string, input: { categoryId: string; name: string }) =>
  apiRequest<{ subcategory: ExpenseSubcategory }>(`/v1/workspace/${workspaceId}/expense-subcategories`, { method: "POST", body: JSON.stringify(input) }, token);
export const updateExpenseSubcategory = (token: string, workspaceId: string, subcategoryId: string, input: { name?: string; active?: boolean }) =>
  apiRequest<{ subcategory: ExpenseSubcategory }>(`/v1/workspace/${workspaceId}/expense-subcategories/${subcategoryId}`, { method: "PATCH", body: JSON.stringify(input) }, token);
export const previewAttendanceImport = (token: string, workspaceId: string, input: {
  farmId: string; seasonId: string; originalFilename: string; csvText: string; from?: string; to?: string;
}) => apiRequest<{ sessionId: string; preview: AttendanceImportPreview }>(
  `/api/workspaces/${workspaceId}/attendance-imports/preview`, { method: "POST", body: JSON.stringify(input) }, token,
);
export const confirmAttendanceImport = (token: string, workspaceId: string, input: {
  importSessionId: string; farmId: string; seasonId: string; duplicateHandlingMode: "missing_only" | "skip_existing" | "update_existing";
  warningsAccepted: boolean; labourMappings: AttendanceImportMapping[];
}) => apiRequest<{ sessionId: string; result: AttendanceImportResult }>(
  `/api/workspaces/${workspaceId}/attendance-imports/confirm`, { method: "POST", body: JSON.stringify({
    importSessionId: input.importSessionId, farmId: input.farmId, seasonId: input.seasonId,
    confirmation: {
      warningsAccepted: input.warningsAccepted,
      duplicateHandlingMode: input.duplicateHandlingMode,
      labourMappings: input.labourMappings,
    },
  }) }, token, { timeoutMs: 60_000, debugLabel: "attendance-import-confirm" },
);
