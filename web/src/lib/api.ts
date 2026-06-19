import { config } from "../config";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export type PlatformRole = "platform_admin" | "platform_support";
export type WorkspaceRole = "workspace_owner" | "workspace_manager" | "supervisor" | "operator" | "viewer";
export type WorkspaceModule = "dashboard" | "workforce" | "attendance" | "advances" | "expenses" | "sales" | "dispatch" | "inventory" | "accounts" | "reports" | "settings" | "team";
export type WorkspaceModuleAction = "view" | "create" | "edit" | "delete" | "approve" | "export";
export type WorkspaceModulePermissions = Partial<Record<WorkspaceModule, Partial<Record<WorkspaceModuleAction, boolean>>>>;
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
  memberships: Array<{ workspaceId: string; workspaceName: string; role: WorkspaceRole; active: boolean; permissions?: WorkspaceModulePermissions | null }>;
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
export type WorkspaceProfile = {
  id: string; name: string; contactEmail: string; contactPhone: string | null;
};
export type WorkspaceProfileInput = {
  name: string; contactEmail: string; contactPhone?: string;
};
export type WorkspaceTeamMember = {
  id: string; userId: string; name: string | null; email: string; phone: string | null; role: WorkspaceRole;
  active: boolean; permissions: WorkspaceModulePermissions | null; lastActiveAt: string | null;
};
export type WorkspaceTeamInvitation = {
  id: string; email: string; phone: string | null; role: WorkspaceRole; status: string; expiresAt: string; createdAt: string;
};
export type WorkspaceTeamData = {
  members: WorkspaceTeamMember[];
  invitations: WorkspaceTeamInvitation[];
  roleDefaults: Record<WorkspaceRole, Record<WorkspaceModule, Record<WorkspaceModuleAction, boolean>>>;
};
export type WorkspaceMemberActivity = {
  id: string; action: string; entityType: string; entityId: string | null; createdAt: string;
};
export type WorkspaceApproval = {
  id: string; workspaceId: string; entityType: "expense" | "attendance" | "sale" | "dispatch"; entityId: string;
  submittedBy: string; currentStep: number; status: "pending" | "approved" | "rejected"; createdAt: string;
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
  approvedWorkspaces: number; rejectedWorkspaces: number;
  totalUsers: number; totalActiveUsers: number; subscriptionRevenue: number; expiringSubscriptions: number; systemHealth: string;
  recentWorkspaces: AdminOverviewWorkspace[]; pendingWorkspaces: AdminOverviewWorkspace[]; suspendedWorkspacesList: AdminOverviewWorkspace[];
  recentActivity: AdminRecentActivity[];
};
export type AdminWorkspace = {
  id: string; name: string; slug: string; contactEmail: string; contactPhone: string | null;
  ownerEmail: string | null; ownerName: string | null;
  status: "pending" | "approved" | "rejected" | "suspended"; createdAt: string; approvedAt: string | null; suspendedAt: string | null;
  usersCount: number; farmsCount: number;
};
export type AdminOverviewWorkspace = {
  id: string; name: string; contactEmail: string; status: "pending" | "approved" | "rejected" | "suspended";
  createdAt: string; approvedAt: string | null; updatedAt: string | null;
};
export type AdminRecentActivity = {
  id: string; action: string; entityType: string; entityId: string | null; workspaceName: string | null; actorName: string | null; createdAt: string;
};
export type AdminWorkspaceMember = {
  id: string; userId: string; role: WorkspaceRole; active: boolean; email: string; displayName: string | null;
};
export type AdminWorkspaceHistory = {
  id: string; action: string; entityType: string; entityId: string | null; createdAt: string; actorName: string | null; actorEmail: string | null; details: unknown;
};
export type AdminWorkspaceDetail = {
  id: string; name: string; slug: string; contactEmail: string; contactPhone: string | null;
  status: "pending" | "approved" | "rejected" | "suspended"; createdAt: string; approvedAt: string | null; updatedAt: string;
  members: AdminWorkspaceMember[]; history: AdminWorkspaceHistory[];
};
export type AdminUserSummary = {
  id: string; email: string; displayName: string | null; phone: string | null; platformRole: PlatformRole | null;
  status: "pending" | "approved" | "rejected" | "suspended"; active: boolean; createdAt: string; workspaceCount: number; lastLoginAt: string | null;
};
export type AdminUserWorkspaceMembership = {
  id: string; workspaceId: string; workspaceName: string; role: WorkspaceRole; active: boolean; permissions: WorkspaceModulePermissions | null; createdAt: string;
};
export type AdminUserDetail = {
  id: string; email: string; displayName: string | null; phone: string | null; platformRole: PlatformRole | null;
  status: "pending" | "approved" | "rejected" | "suspended"; active: boolean; approvedAt: string | null; createdAt: string; updatedAt: string;
  lastLoginAt: string | null; workspaces: AdminUserWorkspaceMembership[];
};
export type AdminAuditLog = {
  id: string; action: string; entityType: string; entityId: string | null; createdAt: string; workspaceName: string | null; actorName: string | null; details: unknown;
};
export type OperationalEntity =
  | "labourer"
  | "labourGroup"
  | "attendance"
  | "account"
  | "advance"
  | "labourPayment"
  | "productionEntry"
  | "vehicle"
  | "dateType"
  | "dispatch"
  | "sale"
  | "voucher"
  | "partnerEntry"
  | "inventoryEntry";
export type OperationalRecordEnvelope = {
  workspaceId: string; farmId?: string | null; seasonId?: string | null; entity: OperationalEntity;
  record: { id: string; createdAt: string; updatedAt: string; [key: string]: unknown };
};
export type OperationalSnapshot = {
  records: OperationalRecordEnvelope[];
  snapshotConfirmed: boolean;
  farmId: string | null;
  seasonId: string | null;
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
export type AdvanceReportFilters = { farmId: string; seasonId: string; from: string; to: string; labourIds?: string[] };
export type AdvanceReportRecord = {
  id: string; labourerId: string; labourName: string; date: string; amount: number; notes: string; accountId: string; accountName: string;
};
export type AdvanceReportSummary = { labourerId: string; labourName: string; total: number; count: number };
export type AdvanceReportData = {
  records: AdvanceReportRecord[];
  summaries: AdvanceReportSummary[];
  grandTotal: number;
  metadata: {
    farmName: string;
    seasonName: string;
    from: string;
    to: string;
    generatedAt: string;
    generatedBy: string;
  } | null;
};
export type ExpenseSearchFilters = {
  farmId: string; seasonId: string; search?: string; from?: string; to?: string;
  category?: string; subcategory?: string; accountId?: string;
};
export type ExpenseSearchRecord = {
  id: string; workspaceId: string; farmId: string; seasonId: string; voucherNumber: string; date: string;
  category: string; categoryId: string; subcategory: string; subcategoryId: string; description: string; amount: number;
  accountId: string; accountName: string; notes?: string; createdAt: string; updatedAt: string;
};
export type AttendanceReportFilters = {
  farmId: string; seasonId: string; from: string; to: string; labourId?: string; labourIds?: string[]; status?: AttendanceReportStatus;
};
export type AttendanceImportCell = { column: string; date: string; status: AttendanceReportStatus | null; advanceAmount: number | null; raw: string };
export type AttendanceImportRow = {
  rowIndex: number; labourName: string; cells: AttendanceImportCell[]; matchedLabourerId: string | null; suggestedLabourerId: string | null;
  csvAdvance: number | null; calculatedAdvance: number;
};
export type AttendanceImportPreview = {
  rows: AttendanceImportRow[]; dateColumns: Array<{ column: string; date: string }>; errors: string[]; warnings: string[];
  labourers: Array<{ id: string; name: string; dailyWage: number }>;
  accounts: Array<{ id: string; name: string }>;
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
export type ExpenseImportResolution = { sourceName: string; action: "map" | "create"; targetId?: string };
export type ExpenseImportPreview = {
  rows: Array<{
    rowIndex: number; voucherNumber: string; date: string; accountName: string; categoryName: string;
    description: string; amount: number; accountId: string | null; subcategoryId: string | null; error: string | null; mappingIssue: string | null;
  }>;
  errors: string[];
  categories: Array<{ id: string; categoryId: string; category: string; subcategory: string; label: string }>;
  accounts: Array<{ id: string; name: string }>;
  summary: {
    totalRows: number; readyRows: number; duplicateRows: number; missingAccounts: string[]; missingCategories: string[];
    errors: string[]; mappingIssues: string[]; totalsByAccount: Array<{ name: string; total: number }>; totalsByCategory: Array<{ name: string; total: number }>; grandTotal: number;
  };
};
export type ExpenseImportResult = { recordsCreated: number; duplicatesSkipped: number; grandTotal: number };
export type FarmFeatureType = "farm_boundary" | "plot" | "irrigation_line" | "valve" | "landmark" | "other";
export type OperationActivityType = "irrigation" | "fertilizer" | "pesticide" | "pruning" | "thinning" | "pollination" | "harvesting" | "maintenance" | "other";
export type FarmMap = {
  id: string; workspaceId: string; farmId: string; seasonId: string | null; mapName: string;
  centerLat: string; centerLng: string; defaultZoom: string; baseMapProvider: string; notes: string | null;
};
export type FarmMapFeature = {
  id: string; workspaceId: string; farmId: string; seasonId: string | null; featureType: FarmFeatureType;
  featureCode: string | null; featureName: string; geojson: Record<string, unknown>; linkedPlotId: string | null;
  linkedIrrigationLineId: string | null; linkedValveId: string | null; styleJson: Record<string, unknown> | null;
  displayOrder: number; active: boolean;
};
export type FarmPlot = {
  id: string; workspaceId: string; farmId: string; seasonId: string | null; plotCode: string; plotName: string | null;
  variety: string | null; treeCount: number | null; area: string | null; notes: string | null; geoFeatureId: string | null; active: boolean;
};
export type IrrigationLine = {
  id: string; workspaceId: string; farmId: string; seasonId: string | null; lineCode: string; lineName: string | null;
  description: string | null; geoFeatureId: string | null; active: boolean;
};
export type FarmValve = {
  id: string; workspaceId: string; farmId: string; seasonId: string | null; valveCode: string; valveName: string | null;
  irrigationLineId: string | null; plotId: string | null; estimatedTreeCount: number | null; notes: string | null; geoFeatureId: string | null; active: boolean;
};
export type WaterAsset = {
  id: string; workspaceId: string; farmId: string; seasonId: string | null; assetType: "pump" | "reservoir";
  assetCode: string; assetName: string; linkedFeatureId: string | null; status: string | null; notes: string | null; active: boolean;
};
export type FarmProduct = {
  id: string; workspaceId: string; productType: "fertilizer" | "pesticide" | "other"; category: string | null; productName: string; unit: string | null; notes: string | null; active: boolean;
};
export type OperationLog = {
  id: string; workspaceId: string; farmId: string; seasonId: string; plotId: string | null; irrigationLineId: string | null; valveId: string | null;
  activityType: OperationActivityType; activityCategory: string | null; productId: string | null; productNameText: string | null; operationDate: string;
  startTime: string | null; endTime: string | null; durationMinutes: number | null; qtyPerTree: string | null; totalQty: string | null; unit: string | null;
  treeCountCovered: number | null; performedBy: string | null; remarks: string | null; createdAt: string;
};
export type OperationDueRule = {
  id: string; workspaceId: string; farmId: string; seasonId: string | null; plotId: string | null; activityType: OperationActivityType;
  activityCategory: string | null; productId: string | null; intervalDays: number; dueSoonDays: number; active: boolean; notes: string | null;
};
export type FarmOperationsDashboard = {
  farmMap: FarmMap | null; features: FarmMapFeature[]; plots: FarmPlot[]; irrigationLines: IrrigationLine[]; valves: FarmValve[];
  waterAssets: WaterAsset[];
  plotStatusSummary: Array<{ plotId: string; statuses: Record<"irrigation" | "fertilizer" | "pesticide", string> }>;
  valveStatusSummary: Array<{ valveId: string; statuses: Record<"irrigation" | "fertilizer" | "pesticide", string> }>;
  overdueCounts: { plots: number; valves: number }; dueSoonCounts: { plots: number; valves: number };
  completedTodayCount: number; recentOperations: OperationLog[]; dueWorkList: Array<{ plotId: string; activityType: string; status: string }>;
};
export type FarmMapInput = Omit<FarmMap, "id" | "workspaceId" | "farmId">;
export type FarmMapFeatureInput = Omit<FarmMapFeature, "id" | "workspaceId" | "farmId">;
export type FarmPlotInput = Omit<FarmPlot, "id" | "workspaceId" | "farmId">;
export type IrrigationLineInput = Omit<IrrigationLine, "id" | "workspaceId" | "farmId">;
export type FarmValveInput = Omit<FarmValve, "id" | "workspaceId" | "farmId">;
export type OperationLogInput = Omit<OperationLog, "id" | "workspaceId" | "farmId" | "createdAt">;

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
    throw new ApiError(`${body?.message ?? `Request failed with status ${response.status}.`}${fields}`, response.status);
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
export const fetchWorkspaceProfile = (token: string, workspaceId: string) =>
  apiRequest<{ workspace: WorkspaceProfile }>(`/v1/workspace/${workspaceId}/profile`, {}, token);
export const updateWorkspaceProfile = (token: string, workspaceId: string, input: WorkspaceProfileInput) =>
  apiRequest<{ workspace: WorkspaceProfile; user: AppUser }>(`/v1/workspace/${workspaceId}/profile`, { method: "PATCH", body: JSON.stringify(input) }, token);
export const fetchWorkspaceTeam = (token: string, workspaceId: string) =>
  apiRequest<WorkspaceTeamData>(`/v1/workspace/${workspaceId}/team`, {}, token);
export const inviteWorkspaceMember = (token: string, workspaceId: string, input: { email: string; phone?: string; role: WorkspaceRole; permissions?: WorkspaceModulePermissions | null }) =>
  apiRequest<{ memberAdded: boolean; invitationToken?: string }>(`/v1/workspace/${workspaceId}/team/invitations`, { method: "POST", body: JSON.stringify(input) }, token);
export const updateWorkspaceMember = (token: string, workspaceId: string, membershipId: string, input: { role: WorkspaceRole; active: boolean; permissions?: WorkspaceModulePermissions | null }) =>
  apiRequest<void>(`/v1/workspace/${workspaceId}/team/${membershipId}`, { method: "PATCH", body: JSON.stringify(input) }, token);
export const removeWorkspaceMember = (token: string, workspaceId: string, membershipId: string) =>
  apiRequest<void>(`/v1/workspace/${workspaceId}/team/${membershipId}`, { method: "DELETE" }, token);
export const cancelWorkspaceInvitation = (token: string, workspaceId: string, invitationId: string) =>
  apiRequest<void>(`/v1/workspace/${workspaceId}/team/invitations/${invitationId}`, { method: "DELETE" }, token);
export const fetchWorkspaceMemberActivity = (token: string, workspaceId: string, membershipId: string) =>
  apiRequest<{ activity: WorkspaceMemberActivity[] }>(`/v1/workspace/${workspaceId}/team/${membershipId}/activity`, {}, token);
export const acceptWorkspaceInvitation = (input: { token: string; displayName: string; password: string; phone?: string }) =>
  apiRequest<{ workspaceId: string }>("/v1/workspace/team/invitations/accept", { method: "POST", body: JSON.stringify(input) });
export const fetchWorkspaceApprovals = (token: string, workspaceId: string) =>
  apiRequest<{ approvals: WorkspaceApproval[] }>(`/v1/workspace/${workspaceId}/approvals`, {}, token);
export const decideWorkspaceApproval = (token: string, workspaceId: string, approvalId: string, decision: "approved" | "rejected", note?: string) =>
  apiRequest<void>("/v1/workspace/approvals/decision", { method: "POST", body: JSON.stringify({ workspaceId, approvalId, decision, note }) }, token);
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
export const fetchAdminOverview = (token: string) => apiRequest<AdminDashboardData>("/v1/admin/overview", {}, token);
export const fetchAdminWorkspaces = (token: string) => apiRequest<{ workspaces: AdminWorkspace[] }>("/v1/admin/workspaces", {}, token);
export const fetchAdminWorkspace = (token: string, workspaceId: string) =>
  apiRequest<{ workspace: AdminWorkspaceDetail | null }>(`/v1/admin/workspaces/${workspaceId}`, {}, token);
export const createAdminWorkspace = (token: string, input: { name: string; contactEmail: string }) =>
  apiRequest<void>("/v1/admin/workspaces", { method: "POST", body: JSON.stringify(input) }, token);
export const suspendAdminWorkspace = (token: string, workspaceId: string) =>
  apiRequest<void>(`/v1/admin/workspaces/${workspaceId}/suspend`, { method: "POST" }, token);
export const updateAdminWorkspaceStatus = (token: string, workspaceId: string, input: { status: "pending" | "approved" | "rejected" | "suspended"; note?: string }) =>
  apiRequest<void>(`/v1/admin/workspaces/${workspaceId}/status`, { method: "PATCH", body: JSON.stringify(input) }, token);
export const deleteAdminWorkspace = (token: string, workspaceId: string) =>
  apiRequest<void>(`/v1/admin/workspaces/${workspaceId}`, { method: "DELETE" }, token);
export const fetchAdminUsers = (token: string) => apiRequest<{ users: AdminUserSummary[] }>("/v1/admin/users", {}, token);
export const fetchAdminUser = (token: string, userId: string) =>
  apiRequest<{ user: AdminUserDetail | null }>(`/v1/admin/users/${userId}`, {}, token);
export const updateAdminUserStatus = (token: string, userId: string, input: { active: boolean }) =>
  apiRequest<void>(`/v1/admin/users/${userId}/status`, { method: "PATCH", body: JSON.stringify(input) }, token);
export const fetchAdminAuditLogs = (token: string) => apiRequest<{ records: AdminAuditLog[] }>("/v1/admin/audit-logs", {}, token);
export const fetchApprovals = (token: string) =>
  apiRequest<{ requests: PendingApproval[] }>("/v1/admin/approvals", {}, token);
export const approveSignup = (token: string, userId: string) =>
  apiRequest<void>("/v1/admin/approvals/approve", { method: "POST", body: JSON.stringify({ userId }) }, token);
export const rejectSignup = (token: string, userId: string) =>
  apiRequest<void>("/v1/admin/approvals/reject", { method: "POST", body: JSON.stringify({ userId }) }, token);
export const saveOperationalRecord = (token: string, input: OperationalRecordEnvelope) =>
  apiRequest<{ record: OperationalRecordEnvelope["record"]; conflict: boolean }>("/v1/workspace/operational-records", { method: "POST", body: JSON.stringify(input) }, token);
export const deleteOperationalRecord = (token: string, input: Omit<OperationalRecordEnvelope, "record"> & { recordId: string; reason?: string }) =>
  apiRequest<void>("/v1/workspace/operational-records", { method: "DELETE", body: JSON.stringify(input) }, token);
export const fetchOperationalRecords = (token: string, workspaceId: string) =>
  apiRequest<OperationalSnapshot>(`/v1/workspace/${workspaceId}/operational-records`, {}, token);
export type LabourDeletionPreview = { labourId: string; labourName: string; linkedRecordCount: number; action: "deactivate" | "delete" };
export const fetchLabourDeletionPreview = (token: string, workspaceId: string, labourId: string) =>
  apiRequest<LabourDeletionPreview>(`/api/workspaces/${workspaceId}/labour/${labourId}/deletion-preview`, {}, token);
export const deleteOrDeactivateLabour = (token: string, workspaceId: string, labourId: string, input: { confirmation: "DELETE"; endDate?: string }) =>
  apiRequest<{ action: "deleted" | "deactivated"; linkedRecordCount: number }>(`/api/workspaces/${workspaceId}/labour/${labourId}`, { method: "DELETE", body: JSON.stringify(input) }, token);
export const fetchAttendanceReport = (token: string, workspaceId: string, filters: AttendanceReportFilters) => {
  const query = new URLSearchParams({
    farmId: filters.farmId, seasonId: filters.seasonId, from: filters.from, to: filters.to,
  });
  if (filters.labourId) query.set("labourId", filters.labourId);
  if (filters.labourIds?.length) query.set("labourIds", filters.labourIds.join(","));
  if (filters.status) query.set("status", filters.status);
  return apiRequest<AttendanceReportData>(
    `/v1/workspace/${workspaceId}/attendance/report?${query.toString()}`, {}, token,
  );
};
export const fetchAdvanceReport = (token: string, workspaceId: string, filters: AdvanceReportFilters) => {
  const query = new URLSearchParams({
    farmId: filters.farmId, seasonId: filters.seasonId, from: filters.from, to: filters.to,
  });
  if (filters.labourIds?.length) query.set("labourIds", filters.labourIds.join(","));
  return apiRequest<AdvanceReportData>(`/v1/workspace/${workspaceId}/advance/report?${query.toString()}`, {}, token);
};
export const fetchExpenseCategories = (token: string, workspaceId: string) =>
  apiRequest<{ categories: ExpenseCategory[] }>(`/v1/workspace/${workspaceId}/expense-categories`, {}, token);
export const searchExpenses = (token: string, workspaceId: string, filters: ExpenseSearchFilters) => {
  const query = new URLSearchParams({ farmId: filters.farmId, seasonId: filters.seasonId });
  if (filters.search) query.set("search", filters.search);
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  if (filters.category) query.set("category", filters.category);
  if (filters.subcategory) query.set("subcategory", filters.subcategory);
  if (filters.accountId) query.set("accountId", filters.accountId);
  return apiRequest<{ records: ExpenseSearchRecord[] }>(`/v1/workspace/${workspaceId}/expenses/search?${query.toString()}`, {}, token);
};
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
  warningsAccepted: boolean; labourMappings: AttendanceImportMapping[]; accountId?: string;
}) => apiRequest<{ sessionId: string; result: AttendanceImportResult }>(
  `/api/workspaces/${workspaceId}/attendance-imports/confirm`, { method: "POST", body: JSON.stringify({
    importSessionId: input.importSessionId, farmId: input.farmId, seasonId: input.seasonId, accountId: input.accountId,
    confirmation: {
      warningsAccepted: input.warningsAccepted,
      duplicateHandlingMode: input.duplicateHandlingMode,
      labourMappings: input.labourMappings,
    },
  }) }, token, { timeoutMs: 60_000, debugLabel: "attendance-import-confirm" },
);
export const previewExpenseImport = (token: string, workspaceId: string, input: {
  farmId: string; seasonId: string; originalFilename: string; csvText: string;
}) => apiRequest<{ sessionId: string; preview: ExpenseImportPreview }>(
  `/api/workspaces/${workspaceId}/expense-imports/preview`, { method: "POST", body: JSON.stringify(input) }, token,
);
export const confirmExpenseImport = (token: string, workspaceId: string, input: {
  importSessionId: string; farmId: string; seasonId: string; skipDuplicates: boolean;
  categoryMappings: ExpenseImportResolution[]; accountMappings: ExpenseImportResolution[];
}) => apiRequest<{ sessionId: string; result: ExpenseImportResult }>(
  `/api/workspaces/${workspaceId}/expense-imports/confirm`, { method: "POST", body: JSON.stringify(input) }, token,
  { timeoutMs: 60_000, debugLabel: "expense-import-confirm" },
);
export const fetchFarmOperationsDashboard = (token: string, workspaceId: string, farmId: string, seasonId?: string | null) => {
  const query = new URLSearchParams();
  if (seasonId) query.set("seasonId", seasonId);
  return apiRequest<FarmOperationsDashboard>(`/v1/workspace/${workspaceId}/farms/${farmId}/farm-operations/dashboard?${query.toString()}`, {}, token);
};
export const fetchFarmOperationsProducts = (token: string, workspaceId: string, farmId: string) =>
  apiRequest<{ records: FarmProduct[] }>(`/v1/workspace/${workspaceId}/farms/${farmId}/farm-operations/products`, {}, token);
export const fetchFarmOperationResources = <TRecord>(token: string, workspaceId: string, farmId: string, resource: string) =>
  apiRequest<{ records: TRecord[] }>(`/v1/workspace/${workspaceId}/farms/${farmId}/farm-operations/${resource}`, {}, token);
export const createFarmOperationResource = <TInput, TResult>(token: string, workspaceId: string, farmId: string, resource: string, input: TInput) =>
  apiRequest<{ record: TResult }>(`/v1/workspace/${workspaceId}/farms/${farmId}/farm-operations/${resource}`, { method: "POST", body: JSON.stringify(input) }, token);
export const updateFarmOperationResource = <TInput, TResult>(token: string, workspaceId: string, farmId: string, resource: string, id: string, input: TInput) =>
  apiRequest<{ record: TResult }>(`/v1/workspace/${workspaceId}/farms/${farmId}/farm-operations/${resource}/${id}`, { method: "PATCH", body: JSON.stringify(input) }, token);
export const deleteFarmOperationResource = (token: string, workspaceId: string, farmId: string, resource: string, id: string) =>
  apiRequest<void>(`/v1/workspace/${workspaceId}/farms/${farmId}/farm-operations/${resource}/${id}`, { method: "DELETE" }, token);
export const fetchFarmOperationLogs = (token: string, workspaceId: string, filters: {
  farmId: string; seasonId?: string | null; plotId?: string; valveId?: string; irrigationLineId?: string; activityType?: OperationActivityType | ""; dateFrom?: string; dateTo?: string;
}) => {
  const query = new URLSearchParams({ farmId: filters.farmId });
  if (filters.seasonId) query.set("seasonId", filters.seasonId);
  if (filters.plotId) query.set("plotId", filters.plotId);
  if (filters.valveId) query.set("valveId", filters.valveId);
  if (filters.irrigationLineId) query.set("irrigationLineId", filters.irrigationLineId);
  if (filters.activityType) query.set("activityType", filters.activityType);
  if (filters.dateFrom) query.set("dateFrom", filters.dateFrom);
  if (filters.dateTo) query.set("dateTo", filters.dateTo);
  return apiRequest<{ records: OperationLog[] }>(`/v1/workspace/${workspaceId}/farm-operations/logs?${query.toString()}`, {}, token);
};
