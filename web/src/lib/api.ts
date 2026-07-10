import { config } from "../config";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly details?: unknown, readonly responseBody?: unknown) {
    super(message);
  }
}

export type HealthResponse = {
  status: "ok" | "degraded";
  database: string;
  mode?: string;
  gitCommit: string;
  buildTime: string;
  appVersion: string;
};

export type AccountingReconciliationTrace = Record<string, unknown>;
export type AccountingReconciliationAccountOption = {
  id: string;
  farmId: string;
  farmName: string;
  name: string;
  accountType: string;
  active: boolean;
  oldAndroidId: string | null;
  sourceType: string | null;
};

export type PlatformRole = "platform_admin" | "platform_support";
export type WorkspaceRole = "workspace_owner" | "workspace_manager" | "supervisor" | "accountant" | "operator" | "viewer";
export type WorkspaceModule = "dashboard" | "workforce" | "attendance" | "advances" | "wages" | "expenses" | "sales" | "dispatch" | "inventory" | "accounts" | "reports" | "settings" | "team";
export type WorkspaceModuleAction = "view" | "create" | "edit" | "delete" | "approve" | "export";
export type WorkspaceModulePermissions = Partial<Record<WorkspaceModule, Partial<Record<WorkspaceModuleAction, boolean>>>>;
export type FarmAccessMode = "all" | "assigned";
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
  workspaceSelectionReason?: "explicit_workspace" | "user_preference" | "first_accessible_workspace";
  email: string;
  displayName: string | null;
  role: AppRole;
  platformRole: PlatformRole | null;
  memberships: Array<{
    membershipId?: string;
    workspaceId: string;
    workspaceName: string;
    role: WorkspaceRole;
    active: boolean;
    permissions?: WorkspaceModulePermissions | null;
    farmAccessMode?: FarmAccessMode;
    farmIds?: string[];
  }>;
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
  workspaceName?: string;
  ownerName: string;
  email: string;
  phone?: string;
  password: string;
};

export type UserProfileInput = {
  displayName: string;
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
  activeWorkspaceId?: string | null;
  availableWorkspaces?: AppUser["memberships"];
  activeFarmId: string | null;
  activeSeasonId: string | null;
  farms: Farm[];
  seasons: Season[];
  workspaceFarmCount?: number;
  accessibleFarmCount?: number;
  accessibleFarmIds?: string[];
  farmAccessReason?: "all" | "assigned" | "no_accessible_farms" | "no_workspace_farms";
  needsRepair?: boolean;
  contextWarning?: string | null;
};

export type Farm = {
  id: string; workspaceId: string; name: string; location: string | null; owner: string | null; remarks: string | null;
  contactName: string | null; contactEmail: string | null; contactPhone: string | null; active: boolean; deletedAt?: string | null; deletionRequestStatus?: string | null;
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
  active: boolean; userActive: boolean; userStatus: "pending" | "approved" | "rejected" | "suspended";
  hasWorkspaceAccess: boolean; displayName: string; permissions: WorkspaceModulePermissions | null; lastActiveAt: string | null;
  farmAccessMode: FarmAccessMode; farmIds: string[];
};
export type WorkspaceTeamInvitation = {
  id: string; email: string; phone: string | null; role: WorkspaceRole; status: string; expiresAt: string; createdAt: string;
  farmAccessMode: FarmAccessMode; farmIds: string[];
};
export type WorkspaceInvitationLookup = {
  workspaceId: string;
  workspaceName: string | null;
  email: string;
  phone: string | null;
  role: WorkspaceRole;
  permissions?: WorkspaceModulePermissions | null;
  status: "pending" | "accepted" | "cancelled" | "expired" | "invalid";
  expiresAt: string;
  acceptedAt: string | null;
  inviterName: string | null;
  inviterEmail: string | null;
  accountExists?: boolean;
};
export type WorkspaceTeamData = {
  members: WorkspaceTeamMember[];
  invitations: WorkspaceTeamInvitation[];
  availableFarms: Array<{ id: string; name: string }>;
  roleDefaults: Record<WorkspaceRole, Record<WorkspaceModule, Record<WorkspaceModuleAction, boolean>>>;
  diagnostics?: {
    email: string;
    workspaceId: string;
    member: {
      membershipId: string;
      userId: string;
      role: WorkspaceRole;
      membershipActive: boolean;
      userActive: boolean;
      userStatus: "pending" | "approved" | "rejected" | "suspended";
      hasWorkspaceAccess: boolean;
    } | null;
    invitation: {
      invitationId: string;
      status: string;
      role: WorkspaceRole;
      expiresAt: string;
    } | null;
  };
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
  totalFarms?: number; pendingFarmDeletionRequests?: number;
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
  id: string; userId: string; role: WorkspaceRole; active: boolean; userActive: boolean;
  userStatus: "pending" | "approved" | "rejected" | "suspended"; hasWorkspaceAccess: boolean;
  email: string; displayName: string | null;
};
export type AdminWorkspaceHistory = {
  id: string; action: string; entityType: string; entityId: string | null; createdAt: string; actorName: string | null; actorEmail: string | null; details: unknown;
};
export type AdminWorkspaceDetail = {
  id: string; name: string; slug: string; contactEmail: string; contactPhone: string | null;
  status: "pending" | "approved" | "rejected" | "suspended"; createdAt: string; approvedAt: string | null; updatedAt: string;
  members: AdminWorkspaceMember[]; history: AdminWorkspaceHistory[]; farms?: AdminFarmSummary[]; deletionRequests?: AdminFarmDeletionRequest[];
};
export type AdminFarmSummary = {
  id: string; workspaceId: string; workspaceName: string; name: string; location: string | null; owner: string | null; ownerEmail: string | null;
  active: boolean; status: "active" | "archived" | "delete_pending" | "deleted"; createdAt: string; totalRecords: number;
  counts: { labour: number; attendance: number; advances: number; expenses: number; sales: number; dispatch: number };
  deletionRequestStatus: string | null;
};
export type AdminFarmDeletionRequest = {
  id: string; workspaceId: string; farmId: string; workspaceName: string; farmName: string; requestedByEmail: string;
  reason: string | null; recordCounts: Record<string, number>; status: "pending" | "approved" | "rejected" | "cancelled";
  reviewedByEmail: string | null; reviewedAt: string | null; reviewNotes: string | null; createdAt: string;
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
export type MigrationImportIssue = { level: "error" | "warning"; path: string; message: string };
export type MigrationImportSummary = {
  exportVersion: string | null; exportedAt: string | null; source: string | null;
  counts: Record<string, number>;
  androidCounts: Record<string, number>;
  exportSummaryCounts?: Record<string, number>;
  mappedCounts: Array<{ androidKey: string; pwaKey: string; count: number }>;
  importCounts: Array<{ label: string; key: string; count: number }>;
  voucherCount: number; voucherItemCount: number; totalExpenses: number; totalAdvances: number; totalSales: number;
  partnerBalances: Array<{ name: string; balance: number }>;
  cashBankBalances: Array<{ name: string; balance: number }>;
};
export type MigrationImportValidation = {
  issues: MigrationImportIssue[];
  summary: MigrationImportSummary;
  canImport?: boolean;
  dryRunRecommended?: boolean;
  imported?: boolean;
  dryRun?: boolean;
  message?: string;
  result?: {
    insertedOperationalRecords: number;
    farmImportStats?: { created: number; updated: number; skippedDuplicates: number };
    importCounts: Array<{ label: string; key: string; count: number }>;
    activeFarmId?: string;
    activeSeasonId?: string;
    attendanceJobId?: string;
    attendanceJob?: MigrationImportJobStatus;
    importBatchId?: string;
    startedAt?: string;
    completedAt?: string;
    currentStep?: string;
    failedRows?: number;
    logs?: MigrationImportLogEntry[];
    totalExpenses: number;
    totalAdvances: number;
    postImportAudit?: {
      expectedCounts: Record<string, number>;
      tableCounts: {
        farms: number;
        seasons: number;
        importFailures: number;
        failedOrPartialBatches: number;
      };
      duplicateAccountAudit: {
        totalGroups: number;
        groups: Array<{
          logicalKey: string;
          normalizedName: string;
          normalizedType: string;
          count: number;
          canonicalAccountId: string | null;
          childReferenceCount: number;
          accountIds: string[];
        }>;
      };
      operationalRecordsByEntity: Array<{ entityType: string; count: number }>;
      voucherNumberAudit: {
        sourceTotal: number;
        importedTotal: number;
        missingSourceVoucherNumbers: number;
        missingStoredVoucherNumbers: number;
        mismatches: Array<{
          oldExpenseId: string;
          androidVoucherNumber: string;
          storedVoucherNumber: string;
          clientRecordId: string;
        }>;
        duplicateImportedVoucherNumbers: Array<{
          voucherNumber: string;
          count: number;
          clientRecordIds: string[];
        }>;
      };
      labourOrderAudit: {
        sourceTotal: number;
        storedTotal: number;
        missingSortOrderCount: number;
        duplicateSortOrderCount: number;
        firstSourceLabourNames: string[];
        firstStoredLabourNames: string[];
      };
      relationshipAudit: {
        attendanceTotal: number;
        attendanceLinkedToLabour: number;
        attendanceMissingLabour: number;
        advancesTotal: number;
        advancesLinkedToLabour: number;
        advancesMissingLabour: number;
        advancesLinkedToAccount: number;
        advancesMissingAccount: number;
        vouchersTotal: number;
        vouchersLinkedToPaymentAccount: number;
        vouchersMissingPaymentAccount: number;
        vouchersWithMultipleItems: number;
        voucherItemsStored: number;
        vouchersWithItemMismatch: number;
      };
    };
  };
};
export type MigrationImportJobStatus = {
  jobId: string;
  importBatchId: string;
  workspaceId: string;
  status: "queued" | "running" | "completed" | "failed" | "partial_failed" | "rolled_back" | "cancelled";
  currentStep: string;
  sourceRows: number;
  totalBatches: number;
  currentBatch: number;
  processedRows: number;
  importedRows: number;
  updatedRows: number;
  skippedRows: number;
  failedRows: number;
  currentRow?: string;
  message?: string;
  startedAt: string;
  lastProgressAt: string;
  completedAt?: string;
  steps: Array<{
    name: string;
    status: "pending" | "running" | "completed" | "failed";
    source: number;
    imported: number;
    updated: number;
    skipped: number;
    failed: number;
    processed: number;
    total: number;
    batch?: number;
    batchTotal?: number;
    startedAt?: string;
    completedAt?: string;
    message?: string;
  }>;
  logs: MigrationImportLogEntry[];
};
export type MigrationImportLogEntry = {
  step: string;
  status: "started" | "completed" | "failed";
  message?: string;
  sourceRows?: number;
  importedRows?: number;
  updatedRows?: number;
  skippedRows?: number;
  failedRows?: number;
  createdAt: string;
};
export type MigrationImportHistoryRecord = {
  id: string;
  action: string;
  details: unknown;
  createdAt: string;
};
export type MigrationImportBatchRecord = {
  id: string;
  source: string;
  exportVersion: string | null;
  fileName: string | null;
  fileHash: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
  summaryJson: unknown;
  errorJson: unknown;
};
export type MigrationImportFailureRecord = {
  id: string;
  step: string;
  sourceRow: string | null;
  errorMessage: string;
  createdAt: string;
};
export type MigrationImportJobDetail = {
  jobId: string;
  status: string;
  currentStep: string;
  message: string;
  error: string;
  stack: string;
  failedRows: number;
  importedRows: number;
  updatedRows: number;
  skippedRows: number;
  firstFailureMessage: string;
  startedAt: string;
  completedAt: string | null;
  steps: MigrationImportJobStatus["steps"];
  failures: MigrationImportFailureRecord[];
};
export type MigrationVisibilityRepairResult = {
  repairedRecords: number;
  activeFarmId: string;
  activeSeasonId: string;
  activeFarmName: string;
  activeSeasonName: string;
  message: string;
};
export type DeletedFarmSeasonRepairResult = {
  farmsDeactivated: number;
  seasonsDeactivated: number;
  sessionsCleared: number;
  activeFarmId: string | null;
  activeSeasonId: string | null;
  contextWarning?: string | null;
  message: string;
};
export type DuplicateImportedAccountsRepairResult = {
  duplicateGroupsBefore: number;
  duplicateGroupsAfter: number;
  canonicalAccountsKept: number;
  childRecordsRemapped: number;
  duplicateAccountsRemoved: number;
  groupsBefore: Array<{ name: string; type: string; count: number; accountIds: string[]; canonicalAccountId: string | null }>;
  groupsAfter: Array<{ name: string; type: string; count: number; accountIds: string[]; canonicalAccountId: string | null }>;
  message: string;
};
export type ImportedVoucherNumberRepairResult = {
  vouchersUpdated: number;
  mismatchesBefore: number;
  mismatchesAfter: number;
  updatedVouchers: Array<{
    clientRecordId: string;
    oldExpenseId: string | null;
    previousVoucherNumber: string;
    repairedVoucherNumber: string;
  }>;
  message: string;
};
export type WorkspaceImportContextDuplicateVoucher = {
  voucherNumber: string;
  recordIds: string[];
  dates: string[];
  amounts: number[];
  accounts: string[];
  statuses: string[];
  imported: boolean[];
  oldExpenseIds: string[];
};
export type WorkspaceImportContextPreview = {
  workspaceId: string;
  canonicalFarm: { id: string; name: string; activeRecordCount: number; selectionReason: string } | null;
  canonicalSeason: { id: string; name: string; activeRecordCount: number; selectionReason: string } | null;
  oldFarms: Array<{ id: string; name: string; active: boolean; deletedAt: string | null; reasons: string[]; oldAndroidId: string | null; sourceFileHash: string | null; importBatchId: string | null }>;
  oldSeasons: Array<{ id: string; farmId: string; name: string; status: string; active: boolean; reasons: string[]; oldAndroidId: string | null; sourceFileHash: string | null; importBatchId: string | null }>;
  recordsRemapPreview: Array<{ entityType: string; count: number }>;
  voucherNumberMismatchesBefore: number;
  duplicateActiveVoucherNumbersBefore: WorkspaceImportContextDuplicateVoucher[];
  duplicateActiveVoucherNumbersProjected: WorkspaceImportContextDuplicateVoucher[];
  deletedRecordsExcludedCount: number;
};
export type WorkspaceImportContextRepairResult = WorkspaceImportContextPreview & {
  createdFallbackSeason: boolean;
  repairedOperationalRecords: number;
  repairedByEntity: Array<{ entityType: string; count: number }>;
  voucherNumberMismatchesAfter: number;
  duplicateActiveVoucherNumbersAfter: WorkspaceImportContextDuplicateVoucher[];
  farmsArchived: number;
  seasonsArchived: number;
  sessionsUpdated: number;
  message: string;
};
export type AccountingDiagnosticsRecord = {
  id: string;
  farmId: string | null;
  seasonId: string | null;
  sourceType: string | null;
  imported: boolean;
  deleted: boolean;
  visibleInSelectedScope: boolean;
  voucherNumber: string;
  date: string;
  amount: number;
  description: string;
  deletedAt: string | null;
  originalVoucherNumber: string | null;
  legacyVoucherNumber: string | null;
  oldExpenseId: string | null;
  createdAt: string;
  updatedAt: string;
};
export type AccountingDiagnostics = {
  workspaceId: string;
  scope: { farmId: string | null; seasonId: string | null };
  voucherStats: {
    active: number;
    importedActive: number;
    deleted: number;
    visibleInSelectedScope: number;
    hiddenFromSelectedScope: number;
    hiddenImportedFromSelectedScope: number;
  };
  duplicateVoucherGroups: Array<{
    voucherNumber: string;
    count: number;
    recordIds: string[];
    farms: string[];
    seasons: string[];
    sources: string[];
  }>;
  hiddenActiveVouchers: AccountingDiagnosticsRecord[];
  hiddenImportedVouchers: AccountingDiagnosticsRecord[];
  deletedVouchers: AccountingDiagnosticsRecord[];
};
export type MigrationImportCleanupPreview = {
  batchId: string;
  fileHash: string;
  source: string;
  status: string;
  operationalRecordsByEntity: Array<{ entityType: string; count: number }>;
  importBatches: number;
  openImportBatches: number;
  importFailures: number;
  importedFarms: number;
  importedSeasons: number;
  editedImportedRecords: number;
  editedOperationalRecords: number;
  editedFarms: number;
  editedSeasons: number;
};
export type MigrationImportCleanupResult = {
  batchStatus: "cancelled";
  operationalRecordsRemoved: number;
  importFailuresRemoved: number;
  seasonsHardDeleted: number;
  seasonsSoftDeleted: number;
  farmsHardDeleted: number;
  farmsSoftDeleted: number;
  auditLogsDetached: number;
  skippedEditedOperationalRecords: number;
  skippedEditedFarms: number;
  skippedEditedSeasons: number;
  skippedProtectedRecords: number;
  protectedFarmRefs: number;
  farmDeletionRequestsRemaining: number;
  farmCleanupMessage?: string | null;
  activeFarmId?: string | null;
  activeSeasonId?: string | null;
  contextMessage?: string | null;
};
export type MigrationImportProgress = {
  batchId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  stage: string;
  step: string;
  percentage: number;
  message: string;
  startedAt: string;
  updatedAt: string;
  elapsedSeconds: number;
  estimatedRemainingSeconds: number | null;
  completedSteps: number;
  totalSteps: number;
  processedCount: number;
  totalCount: number;
  importedCount: number;
  updatedCount: number;
  skippedCount: number;
  failedCount: number;
};
export type ImportVisibilityAudit = {
  workspaceId: string;
  latestImport: {
    batchId: string | null;
    fileHash: string | null;
    source: string | null;
    status: string | null;
    startedAt: string | null;
    completedAt: string | null;
  };
  server: {
    farmsImported: number;
    seasonsImported: number;
    operationalRecordsByEntity: Array<{ entityType: string; count: number }>;
  };
  context: {
    activeFarmId: string | null;
    activeSeasonId: string | null;
    activeFarmName: string | null;
    activeSeasonName: string | null;
    contextWarning: string | null;
  };
};
export type OperationalEntity =
  | "labourer"
  | "labourGroup"
  | "attendance"
  | "account"
  | "advance"
  | "labourEarning"
  | "labourWageSettlement"
  | "wageRate"
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
  needsRepair?: boolean;
  contextWarning?: string | null;
  malformedRecordsSkipped?: number;
};
export type WorkspaceContextRepairResult = {
  repairedRecords: number;
  activeFarmId: string | null;
  activeSeasonId: string | null;
  activeFarmName: string | null;
  activeSeasonName: string | null;
  contextWarning: string | null;
  message: string;
};
export type AttendanceReportStatus = "present" | "half_day" | "absent";
export type AttendanceReportRecord = {
  id: string; labourerId: string; labourName: string; dailyWage: number; date: string; status: AttendanceReportStatus;
  appliedDailyRate?: number;
  appliedHalfDayRate?: number;
  rateRecordId?: string | null;
};
export type AttendanceReportSummary = {
  id: string; name: string; dailyWage: number; presentDays: number; halfDays: number; absentDays: number;
  payableDays: number; totalWage: number; records: AttendanceReportRecord[];
  wageRateDisplay?: string;
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
  settledAdvances?: number;
  outstandingAdvances?: number;
  settlementReferences?: Array<{
    id: string;
    settlementNumber: string;
    settlementDate: string;
    fromDate: string;
    toDate: string;
    settledAdvanceAmount: number;
    expenseAmount: number;
    linkedVoucherId: string;
    linkedVoucherNumber: string;
  }>;
  reconciliationTrace?: Array<Record<string, unknown>>;
  filters?: Record<string, unknown>;
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
  includeDeleted?: boolean;
  includeImported?: boolean;
  includeSettlementVouchers?: boolean;
};
export type WageRateType = "daily" | "half_day" | "monthly" | "custom";
export type WageRateRecord = {
  id: string;
  workspaceId: string;
  farmId: string;
  seasonId: string;
  labourerId: string;
  labourId?: string;
  rateType: WageRateType;
  dailyRate: number;
  halfDayRate: number;
  effectiveFrom: string;
  effectiveTo?: string | null;
  notes?: string;
  active: boolean;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
};
export type WageRateBulkRowInput = {
  id?: string;
  labourerId: string;
  rateType?: WageRateType;
  dailyRate: number;
  halfDayRate?: number;
  notes?: string;
  active?: boolean;
};
export type WageRateBulkUpsertInput = {
  farmId: string;
  seasonId: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  rateType?: WageRateType;
  notes?: string;
  closePrevious?: boolean;
  replaceExisting?: boolean;
  changeReason?: string;
  rows: WageRateBulkRowInput[];
};
export type WageRateOverlapPreview = {
  labourerId: string;
  labourName?: string;
  affectedFrom: string;
  affectedTo?: string | null;
  affectedAttendanceCount: number;
  overlaps: Array<{
    id: string;
    effectiveFrom: string;
    effectiveTo?: string | null;
    dailyRate: number;
    halfDayRate: number;
    notes?: string;
  }>;
};
export type WageRateCalculateResult = {
  rows: Array<{
    labourerId: string;
    labourName: string;
    presentDays: number;
    halfDays: number;
    absentDays: number;
    payableDays: number;
    totalWage: number;
    missingRateDates: string[];
  }>;
  unresolved: Array<{ labourerId: string; labourName: string; date: string; status: AttendanceReportStatus }>;
};
export type LabourWageSettlementRecord = {
  id: string;
  settlementNumber: string;
  linkedVoucherId: string;
  linkedVoucherNumber: string;
  linkedAccountId: string;
  linkedAccountName?: string | null;
  paymentAccountCanonicalId?: string | null;
  paymentAccountLegacyId?: string | null;
  paymentAccountName?: string | null;
  paymentAccountType?: string | null;
  settlementMode?: "individual" | "group";
  foremanId?: string | null;
  groupId?: string | null;
  groupName?: string | null;
  includedLabourIds?: string[];
  includedInactiveLabourIds?: string[];
  includedActiveLabourIds?: string[];
  excludedLabourers?: Array<{
    labourerId: string;
    labourName: string;
    reason: string;
  }>;
  includedLabourRows?: Array<{
    labourerId: string;
    labourName: string;
    currentStatus: "active" | "inactive";
    groupName: string | null;
    presentDays: number;
    halfDayDays: number;
    absentDays: number;
    payableDays: number;
    wageRateLabel: string | null;
    attendanceWage: number;
    labourWorkWage: number;
    grossWage: number;
    advanceAvailable: number;
    advanceAdjustedNow: number;
    advanceCarriedForward: number;
    netPayableBeforePayment: number;
    paidNow: number;
    balanceAfterSettlement: number;
    missingRateDates: string[];
  }>;
  attendanceTotals?: {
    labourers: number;
    present: number;
    halfDay: number;
    absent: number;
    payableDays: number;
  };
  fromDate: string;
  toDate: string;
  settlementDate: string;
  attendanceWages: number;
  labourWorkWages?: number;
  pendingLabourEarnings: number;
  grossWages?: number;
  totalEarned: number;
  availableAdvanceBalanceBeforeSettlement?: number;
  advancesPaid: number;
  advanceAdjustedNow?: number;
  settledAdvanceAmount: number;
  remainingAdvanceCarryForward?: number;
  expenseAmount: number;
  carryForwardAdvance: number;
  manualAdjustment?: number;
  manualAdjustmentNote?: string | null;
  netPayableBeforePayment?: number;
  paidAmount?: number;
  balanceAfterPayment?: number;
  payableBalance: number;
  paymentAccountId?: string | null;
  settlementVoucherId?: string | null;
  sourceAttendanceIds?: string[];
  sourceLabourWorkIds?: string[];
  advanceAdjustmentAllocations?: Array<{
    settlementId: string;
    advanceId: string;
    adjustedAmount: number;
    workspaceId: string;
    farmId: string;
    seasonId: string;
  }>;
  notes?: string;
  status: "posted" | "voided" | "deleted";
  accountingStatus?: "draft" | "posted" | "accounting_missing" | "voided" | "deleted";
  accountingMessage?: string | null;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  deletedBy?: string | null;
  voidedAt?: string | null;
  voidedBy?: string | null;
  voidReason?: string | null;
  settlementScopeSnapshot?: {
    settlementMode?: "individual" | "group";
    groupId?: string | null;
    groupName?: string | null;
    individualLabourWorkWages?: number;
    groupLabourWorkWages?: number;
    fromDate: string;
    toDate: string;
    includedLabourIds: string[];
    includedInactiveLabourIds: string[];
    attendanceWageTotal: number;
    attendanceCountTotals: {
      labourers: number;
      present: number;
      halfDay: number;
      absent: number;
      payableDays: number;
    };
    advanceAdjustedNow: number;
    netPayable: number;
    paymentAccountId?: string | null;
    paidNow: number;
  };
};
export type LabourWageSettlementDetail = LabourWageSettlementRecord & {
  accountingEntries?: number;
};
export type LabourWageSettlementPaymentAccount = {
  id: string;
  farmId: string;
  name: string;
  accountType: "cash" | "bank" | "partner" | string;
  oldAndroidId?: string | null;
  sourceType?: string | null;
};
export type LabourWageSettlementLinkedVoucher = {
  id: string;
  voucherNumber: string;
  originalVoucherNumber?: string;
  legacyVoucherNumber?: string;
  voucherNumberEdited?: boolean;
  allowVoucherNumberEdit?: boolean;
  settlementId?: string;
  settlementNumber?: string;
  voucherPurpose?: string;
  nonCashSettlement?: boolean;
  date: string;
  category: string;
  categoryId: string;
  subcategory: string;
  subcategoryId: string;
  description: string;
  amount: number;
  accountId: string;
  notes?: string;
  settlementScopeSnapshot?: {
    settlementMode?: "individual" | "group";
    groupId?: string | null;
    groupName?: string | null;
    individualLabourWorkWages?: number;
    groupLabourWorkWages?: number;
    fromDate: string;
    toDate: string;
    includedLabourIds: string[];
    includedInactiveLabourIds: string[];
    attendanceWageTotal: number;
    attendanceCountTotals: {
      labourers: number;
      present: number;
      halfDay: number;
      absent: number;
      payableDays: number;
    };
    advanceAdjustedNow: number;
    netPayable: number;
  };
  createdBy?: string;
  updatedBy?: string;
  items?: Array<{
    id: string;
    category: string;
    categoryId: string;
    subcategory?: string;
    subcategoryId?: string;
    amount: number;
    description: string;
  }>;
  createdAt: string;
  updatedAt: string;
};
export type LabourWageSettlementPreview = {
  attendanceWages: number;
  individualLabourWorkWages?: number;
  groupLabourWorkWages?: number;
  labourWorkWages?: number;
  pendingLabourEarnings: number;
  grossWages?: number;
  totalEarned: number;
  advancesPaid: number;
  availableAdvanceBalanceBeforeSettlement?: number;
  advancesAvailableUpToSettlementDate: number;
  rawAdvancesUpToSettlementDate: number;
  previouslySettledAdvances: number;
  settlementDate: string;
  settlementMode?: "individual" | "group";
  foremanId?: string | null;
  groupId?: string | null;
  groupName?: string | null;
  includedLabourIds?: string[];
  includedLabourCount?: number;
  includedInactiveLabourIds?: string[];
  includedActiveLabourIds?: string[];
  includedLabourRows?: Array<{
    labourerId: string;
    labourName: string;
    currentStatus: "active" | "inactive";
    groupName: string | null;
    presentDays: number;
    halfDayDays: number;
    absentDays: number;
    payableDays: number;
    wageRateLabel: string | null;
    attendanceWage: number;
    labourWorkWage: number;
    grossWage: number;
    advanceAvailable: number;
    advanceAdjustedNow: number;
    advanceCarriedForward: number;
    netPayableBeforePayment: number;
    paidNow: number;
    balanceAfterSettlement: number;
    missingRateDates: string[];
  }>;
  excludedLabourers?: Array<{
    labourerId: string;
    labourName: string;
    reason: string;
  }>;
  attendanceTotals?: {
    labourers: number;
    present: number;
    halfDay: number;
    absent: number;
    payableDays: number;
  };
  settledAdvanceAmount: number;
  advanceAdjustedNow?: number;
  expenseAmount: number;
  carryForwardAdvance: number;
  remainingAdvanceCarryForward?: number;
  manualAdjustment?: number;
  manualAdjustmentNote?: string | null;
  netPayableBeforePayment?: number;
  paidAmount?: number;
  balanceAfterPayment?: number;
  payableBalance: number;
  sourceAttendanceIds?: string[];
  sourceLabourWorkIds?: string[];
  advanceAdjustmentAllocations?: Array<{
    settlementId: string;
    advanceId: string;
    adjustedAmount: number;
    workspaceId: string;
    farmId: string;
    seasonId: string;
  }>;
  advanceDebugTrace?: Array<{
    labourerId: string;
    labourName: string;
    totalAdvancesToDate: number;
    priorValidSettledAdvances: number;
    excludedVoidedSettledAdvances: number;
    availableAdvance: number;
    grossWages: number;
    currentAdjustment: number;
    carryForward: number;
  }>;
  advanceReconciliation?: Array<{
    advanceId: string;
    advanceRecordId: string;
    sourceAdvanceId: string;
    date: string;
    amount: number;
    labourerId: string | null;
    labourerName: string | null;
    labourGroupId: string | null;
    labourGroupName: string | null;
    farmId: string | null;
    seasonId: string | null;
    workspaceId: string;
    accountId: string | null;
    accountName: string | null;
    recordedById: string | null;
    recordedByName: string | null;
    originalAmount: number;
    previouslyAbsorbedAmount: number;
    remainingAvailableAmount: number;
    includedInPreview: boolean;
    exclusionReason: string | null;
    sourceRecordType: string;
    voidedOrDeleted: boolean;
  }>;
  includedEarnings: Array<{
    id: string;
    labourerId: string | null;
    labourName: string;
    labourGroupId?: string | null;
    labourGroupName?: string | null;
    foremanId?: string | null;
    earningScope: "individual" | "group";
    earningDate: string;
    earningType: string;
    description: string;
    amount: number;
  }>;
  unresolvedRows: Array<{ labourerId: string; labourName: string; date: string; status: string }>;
  settlementScopeSnapshot?: {
    settlementMode?: "individual" | "group";
    groupId?: string | null;
    groupName?: string | null;
    fromDate: string;
    toDate: string;
    includedLabourIds: string[];
    includedInactiveLabourIds: string[];
    attendanceWageTotal: number;
    attendanceCountTotals: {
      labourers: number;
      present: number;
      halfDay: number;
      absent: number;
      payableDays: number;
    };
    advanceAdjustedNow: number;
    netPayable: number;
  };
  overlappingSettlements: Array<{
    id: string;
    settlementNumber: string;
    fromDate: string;
    toDate: string;
    settlementDate: string;
    expenseAmount: number;
    settledAdvanceAmount: number;
    status: "posted" | "voided";
  }>;
};
export type LabourWageSettlementCreateInput = {
  farmId: string;
  seasonId: string;
  fromDate: string;
  toDate: string;
  settlementDate: string;
  clientRequestId?: string;
  settlementMode?: "individual" | "group";
  labourerId?: string | null;
  foremanId?: string | null;
  groupId?: string | null;
  labourIds?: string[];
  paymentAccountId?: string;
  accountId?: string;
  paidAmount?: number;
  manualAdjustment?: number;
  manualAdjustmentNote?: string | null;
  notes?: string;
};
export type LabourWageSettlementCreateStatus = {
  clientRequestId: string;
  state: "SUCCESS" | "FAILED" | "ALREADY_CREATED" | "IN_PROGRESS";
  safeToRetry: boolean;
  settlementId: string | null;
  settlementNumber: string | null;
  accountingStatus: "COMPLETE" | "MISSING" | "REPAIR_REQUIRED" | "FAILED" | null;
  accountingMessage: string | null;
  errorCode: string | null;
  message: string | null;
  lifecycleErrorCode?: string | null;
  lifecycleMessage?: string | null;
  stage: string | null;
  updatedAt: string;
  settlement: LabourWageSettlementRecord | null;
};
export type LabourWageSettlementDiagnostics = {
  lookup: {
    workspaceId: string;
    settlementNumber?: string;
    settlementId?: string;
    clientRequestId?: string;
    farmId?: string | null;
  };
  settlement: {
    exists: boolean;
    operationalRecordId: string | null;
    clientRecordId: string | null;
    settlementNumber: string | null;
    status: string | null;
    createdAt: string | null;
    updatedAt: string | null;
    fromDate: string | null;
    toDate: string | null;
    settlementDate: string | null;
    groupId: string | null;
    foremanId: string | null;
    paidAmount: number | null;
    advanceAdjustedNow: number | null;
    grossWages: number | null;
  };
  lifecycle: {
    exists: boolean;
    state: string | null;
    stage: string | null;
    errorCode: string | null;
    safeMessage: string | null;
    safeToRetry: boolean | null;
    createdAt: string | null;
    updatedAt: string | null;
    completedAt: string | null;
  };
  paymentAccountSnapshot: {
    paymentAccountId: string | null;
    paymentAccountCanonicalId: string | null;
    paymentAccountLegacyId: string | null;
    linkedAccountId: string | null;
    paymentAccountName: string | null;
    paymentAccountType: string | null;
  };
  paymentAccountResolution: {
    canonicalAccountFound: boolean;
    legacyAccountFound: boolean;
    partnerAccountFound: boolean;
    operationalAccountFound: boolean;
    resolvedCanonicalId: string | null;
    resolvedLegacyId: string | null;
    resolvedName: string | null;
    resolvedType: string | null;
    active: boolean | null;
    archived: boolean | null;
    workspaceMatches: boolean;
    resolutionFailureReason: string | null;
    nameOnlyCandidates: Array<{ id: string; name: string; accountType: string | null; active: boolean | null; source: "canonical" | "operational" }>;
  };
  accounting: {
    status: "COMPLETE" | "MISSING" | "REPAIR_REQUIRED" | "FAILED";
    transactionCount: number;
    activeTransactionCount: number;
    reversalCount: number;
    matchingReferenceIds: string[];
    expectedPaymentAccountId: string | null;
    storedPaymentAccountId: string | null;
    identifierMismatch: boolean;
    mismatchDescription: string | null;
  };
  allocations: {
    count: number;
    absorbedTotal: number;
    missingAdvanceReferences: number;
  };
  attendance: {
    linkedCount: number;
  };
  labourEarnings: {
    linkedCount: number;
    settledCount: number;
  };
  classification: {
    settlementState: "FULLY_COMMITTED" | "COMMITTED_ACCOUNTING_MISSING" | "ROLLED_BACK" | "PARTIAL_OR_INCONSISTENT" | "NOT_FOUND";
    recommendedAction: string;
    safeToRetryCreate: boolean;
  };
};
export type ExpenseSearchRecord = {
  id: string; workspaceId: string; farmId: string; seasonId: string; voucherNumber: string; date: string;
  originalVoucherNumber?: string;
  legacyVoucherNumber?: string;
  settlementId?: string | null;
  settlementNumber?: string | null;
  voucherPurpose?: string | null;
  nonCashSettlement?: boolean;
  category: string; categoryId: string; subcategory: string; subcategoryId: string; description: string; amount: number;
  accountId: string; accountName: string; notes?: string; createdAt: string; updatedAt: string;
  deletedAt?: string | null;
  sourceType?: string | null;
  isImported?: boolean;
  oldExpenseId?: string | null;
  items?: Array<Record<string, unknown>>;
};
export type VoucherNumberValidation = {
  voucherNumber: string;
  available: boolean;
  existingRecordId?: string | null;
  blockingVoucher?: {
    id: string;
    clientRecordId: string;
    workspaceId: string;
    farmId: string | null;
    seasonId: string | null;
    voucherNumber: string;
    originalVoucherNumber?: string | null;
    legacyVoucherNumber?: string | null;
    voucherNumberEdited?: boolean;
    date: string;
    amount: number;
    description: string;
    deletedAt?: string | null;
    source: "imported" | "pwa";
    oldExpenseId?: string | null;
  } | null;
  suggestedNextVoucherNumber: string;
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
export type ExpenseAttachment = {
  id: string; workspaceId: string; farmId: string | null; seasonId: string | null; expenseId: string;
  fileName: string; fileType: string; fileSize: number; storageKey: string; fileUrl: string | null;
  originalFileKey?: string | null; croppedFileKey?: string | null; cropMetadata?: Record<string, unknown> | null;
  ocrStatus?: string; ocrProvider?: string | null; ocrRawText?: string | null; ocrParsedJson?: Record<string, unknown> | null;
  ocrConfidence?: string | null; userCorrectedJson?: Record<string, unknown> | null; processedAt?: string | null;
  uploadedBy: string; uploadedAt: string; deletedAt: string | null;
};
export type ExpenseAttachmentUpload = {
  farmId?: string | null; seasonId?: string | null; fileName: string; fileType: string; fileSize: number; contentBase64: string;
  originalContentBase64?: string; originalFileSize?: number; cropMetadata?: Record<string, unknown>;
};
export type ExpenseOcrSuggestion = {
  status: "success" | "not_configured" | "failed";
  rawText: string;
  fields: {
    date?: string; supplier?: string; receiptNumber?: string; totalAmount?: number; vatAmount?: number;
    paymentMethod?: string; description?: string; suggestedCategory?: string; suggestedSubcategory?: string;
  };
  lineItems: Array<{ name: string; quantity?: number; unitPrice?: number; amount?: number; suggestedCategory?: string; suggestedSubcategory?: string }>;
  confidence: "high" | "medium" | "low";
  provider?: string;
  message?: string;
};
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
    if (controller.signal.aborted) {
      const isMigrationImport = requestOptions.debugLabel === "migration-import-import";
      const isSettlementCreate = requestOptions.debugLabel === "labour-wage-settlement-create";
      throw new Error(isMigrationImport
        ? "Import is still running. Attendance is processing in the background."
        : isSettlementCreate
          ? "The request is taking longer than expected. Checking settlement status..."
          : "Request is taking longer than expected. Please try again.");
    }
    throw error;
  } finally {
    if (timeout) window.clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string; fields?: string[]; details?: unknown } | null;
    if (import.meta.env.DEV && requestOptions.debugLabel) console.error(`[${requestOptions.debugLabel}] response`, response.status, body);
    const fields = body?.fields?.length ? ` Missing or invalid fields: ${body.fields.join(", ")}.` : "";
    throw new ApiError(`${body?.message ?? `Request failed with status ${response.status}.`}${fields}`, response.status, body?.details, body);
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
  apiRequest<{ status: "approved"; message: string; token: string; user: AppUser }>("/v1/auth/signup", {
    method: "POST",
    body: JSON.stringify(input),
  });

export const logout = (token: string) => apiRequest<void>("/v1/auth/logout", { method: "POST" }, token);
export const fetchSession = (token: string) => apiRequest<Session>("/v1/session", {}, token);
export const fetchHealth = () => apiRequest<HealthResponse>("/health");
export const fetchMe = (token: string) => apiRequest<{ user: AppUser }>("/v1/me", {}, token);
export const updateMe = (token: string, input: UserProfileInput) =>
  apiRequest<{ user: AppUser }>("/v1/me", { method: "PATCH", body: JSON.stringify(input) }, token);
export const selectWorkspace = (token: string, workspaceId: string) =>
  apiRequest<{ user: AppUser }>("/v1/session/workspace", { method: "POST", body: JSON.stringify({ workspaceId }) }, token);
export const fetchBootstrap = (token: string) => apiRequest<BootstrapData>("/v1/bootstrap", {}, token);
export const fetchWorkspaceProfile = (token: string, workspaceId: string) =>
  apiRequest<{ workspace: WorkspaceProfile }>(`/v1/workspace/${workspaceId}/profile`, {}, token);
export const updateWorkspaceProfile = (token: string, workspaceId: string, input: WorkspaceProfileInput) =>
  apiRequest<{ workspace: WorkspaceProfile; user: AppUser }>(`/v1/workspace/${workspaceId}/profile`, { method: "PATCH", body: JSON.stringify(input) }, token);
export const fetchWorkspaceTeam = (token: string, workspaceId: string) =>
  apiRequest<WorkspaceTeamData>(`/v1/workspace/${workspaceId}/team`, {}, token);
export const inviteWorkspaceMember = (token: string, workspaceId: string, input: {
  email: string;
  phone?: string;
  role: WorkspaceRole;
  permissions?: WorkspaceModulePermissions | null;
  farmAccessMode?: FarmAccessMode;
  farmIds?: string[];
}) =>
  apiRequest<{ memberAdded: boolean; alreadyHasAccess?: boolean; membershipUpdated?: boolean; membershipId?: string; invitationToken?: string; invitationUrl?: string; emailSent?: boolean; emailConfigured?: boolean; warning?: string | null }>(`/v1/workspace/${workspaceId}/team/invitations`, { method: "POST", body: JSON.stringify(input) }, token);
export const updateWorkspaceMember = (token: string, workspaceId: string, membershipId: string, input: {
  role: WorkspaceRole;
  active: boolean;
  permissions?: WorkspaceModulePermissions | null;
  farmAccessMode?: FarmAccessMode;
  farmIds?: string[];
}) => apiRequest<{ membership: WorkspaceTeamMember }>(`/v1/workspace/${workspaceId}/team/${membershipId}`, { method: "PATCH", body: JSON.stringify(input) }, token);
export const removeWorkspaceMember = (token: string, workspaceId: string, membershipId: string) =>
  apiRequest<void>(`/v1/workspace/${workspaceId}/team/${membershipId}`, { method: "DELETE" }, token);
export const cancelWorkspaceInvitation = (token: string, workspaceId: string, invitationId: string) =>
  apiRequest<void>(`/v1/workspace/${workspaceId}/team/invitations/${invitationId}`, { method: "DELETE" }, token);
export const fetchWorkspaceMemberActivity = (token: string, workspaceId: string, membershipId: string) =>
  apiRequest<{ activity: WorkspaceMemberActivity[] }>(`/v1/workspace/${workspaceId}/team/${membershipId}/activity`, {}, token);
export const lookupWorkspaceInvitation = (token: string) =>
  apiRequest<{ invitation: WorkspaceInvitationLookup }>(`/v1/workspace-invitations/lookup?token=${encodeURIComponent(token)}`);
export const acceptWorkspaceInvitation = (
  input: { token: string; mode?: "session" | "login" | "signup"; email?: string; displayName?: string; password?: string; phone?: string },
  token?: string,
) =>
  apiRequest<{ workspaceId: string; accepted: boolean; token?: string; user?: AppUser }>("/v1/workspace-invitations/accept", { method: "POST", body: JSON.stringify(input) }, token);
export const registerAndAcceptWorkspaceInvitation = (
  input: { token: string; displayName: string; password: string; phone?: string },
) =>
  apiRequest<{ workspaceId: string; accepted: boolean; token?: string; user?: AppUser }>(
    "/v1/workspace-invitations/register-and-accept",
    { method: "POST", body: JSON.stringify({ ...input, mode: "signup" }) },
  );
export const fetchWorkspaceApprovals = (token: string, workspaceId: string) =>
  apiRequest<{ approvals: WorkspaceApproval[] }>(`/v1/workspace/${workspaceId}/approvals`, {}, token);
export const decideWorkspaceApproval = (token: string, workspaceId: string, approvalId: string, decision: "approved" | "rejected", note?: string) =>
  apiRequest<void>("/v1/workspace/approvals/decision", { method: "POST", body: JSON.stringify({ workspaceId, approvalId, decision, note }) }, token);
export const fetchWorkspaceFarms = (token: string, workspaceId: string) =>
  apiRequest<{ farms: Farm[]; historyFarms?: Farm[]; activeFarmId: string | null; needsRepair?: boolean; contextWarning?: string | null }>(`/v1/workspace/${workspaceId}/farms`, {}, token);
export const createWorkspaceFarm = (token: string, workspaceId: string, input: FarmInput) =>
  apiRequest<{ farm: Farm }>(`/v1/workspace/${workspaceId}/farms`, { method: "POST", body: JSON.stringify(input) }, token);
export const updateWorkspaceFarm = (token: string, workspaceId: string, farmId: string, input: FarmInput) =>
  apiRequest<{ farm: Farm }>(`/v1/workspace/${workspaceId}/farms/${farmId}`, { method: "PATCH", body: JSON.stringify(input) }, token);
export const archiveWorkspaceFarm = (token: string, workspaceId: string, farmId: string) =>
  apiRequest<void>(`/v1/workspace/${workspaceId}/farms/${farmId}/archive`, { method: "POST" }, token);
export const restoreWorkspaceFarm = (token: string, workspaceId: string, farmId: string) =>
  apiRequest<{ farm: Farm }>(`/v1/workspace/${workspaceId}/farms/${farmId}/restore`, { method: "POST" }, token);
export const deleteWorkspaceFarm = (token: string, workspaceId: string, farmId: string) =>
  apiRequest<void>(`/v1/workspace/${workspaceId}/farms/${farmId}`, { method: "DELETE" }, token);
export const requestWorkspaceFarmDeletion = (token: string, workspaceId: string, farmId: string, input: { reason?: string }) =>
  apiRequest<{ request: unknown }>(`/v1/workspace/${workspaceId}/farms/${farmId}/delete-request`, { method: "POST", body: JSON.stringify(input) }, token);
export const selectActiveFarm = (token: string, workspaceId: string, farmId: string) =>
  apiRequest<void>(`/v1/workspace/${workspaceId}/farms/${farmId}/select`, { method: "POST" }, token);
export const repairWorkspaceContextRequest = (token: string, workspaceId: string) =>
  apiRequest<WorkspaceContextRepairResult>(`/v1/workspace/${workspaceId}/repair-context`, { method: "POST" }, token, { timeoutMs: 60_000, debugLabel: "workspace-repair-context" });
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
export const fetchAdminWorkspaceSeasons = (token: string, workspaceId: string, farmId: string) =>
  apiRequest<{ seasons: Season[]; activeSeasonId: string | null }>(`/v1/admin/workspaces/${workspaceId}/farms/${farmId}/seasons`, {}, token);
export const fetchAdminFarms = (token: string) =>
  apiRequest<{ farms: AdminFarmSummary[]; deletionRequests: AdminFarmDeletionRequest[] }>("/v1/admin/farms", {}, token);
export const fetchAdminFarmDeletionRequests = (token: string) =>
  apiRequest<{ requests: AdminFarmDeletionRequest[] }>("/v1/admin/farm-deletion-requests", {}, token);
export const approveAdminFarmDeletionRequest = (token: string, requestId: string, input: { notes?: string }) =>
  apiRequest<void>(`/v1/admin/farm-deletion-requests/${requestId}/approve`, { method: "POST", body: JSON.stringify(input) }, token);
export const rejectAdminFarmDeletionRequest = (token: string, requestId: string, input: { notes?: string }) =>
  apiRequest<void>(`/v1/admin/farm-deletion-requests/${requestId}/reject`, { method: "POST", body: JSON.stringify(input) }, token);
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
export const repairInvitedDefaultWorkspaces = (token: string) =>
  apiRequest<{ repairedCount: number; repairedUsers: Array<{ userId: string; email: string; removedWorkspaceId: string; nextWorkspaceId: string }>; user: AppUser | null }>(
    "/v1/admin/users/repair-invited-default-workspaces",
    { method: "POST" },
    token,
  );
export const fetchAdminAuditLogs = (token: string) => apiRequest<{ records: AdminAuditLog[] }>("/v1/admin/audit-logs", {}, token);
export const validateMigrationImport = (token: string, input: { workspaceId: string; payload: unknown; allowSummaryMismatch?: boolean }) =>
  apiRequest<MigrationImportValidation>("/v1/admin/migration-import/validate", { method: "POST", body: JSON.stringify(input) }, token, { timeoutMs: 60_000, debugLabel: "migration-import-validate" });
export const importMigrationData = (token: string, input: { workspaceId: string; payload: unknown; dryRun: boolean; allowDatabaseWrite: boolean; allowSummaryMismatch?: boolean; fileName?: string }) =>
  apiRequest<MigrationImportValidation>("/v1/admin/migration-import/imports/start", { method: "POST", body: JSON.stringify(input) }, token, { timeoutMs: 120_000, debugLabel: "migration-import-import" });
export const fetchMigrationImportJobStatus = (token: string, jobId: string) =>
  apiRequest<{ job: MigrationImportJobStatus }>(`/v1/admin/migration-import/imports/status/${encodeURIComponent(jobId)}`, {}, token, { timeoutMs: 30_000, debugLabel: "migration-import-job-status" });
export const fetchMigrationImportJobDetail = (token: string, jobId: string) =>
  apiRequest<MigrationImportJobDetail>(`/v1/admin/migration-imports/${encodeURIComponent(jobId)}`, {}, token, { timeoutMs: 30_000, debugLabel: "migration-import-job-detail" });
export const fetchActiveMigrationImportJob = (token: string, workspaceId: string) =>
  apiRequest<{ job: MigrationImportJobStatus | null }>(`/v1/admin/migration-import/imports/active?workspaceId=${encodeURIComponent(workspaceId)}`, {}, token, { timeoutMs: 30_000, debugLabel: "migration-import-active-job" });
export const fetchMigrationImportBatches = (token: string, workspaceId: string) =>
  apiRequest<{ records: MigrationImportBatchRecord[] }>(`/v1/admin/migration-import/batches?workspaceId=${encodeURIComponent(workspaceId)}`, {}, token, { timeoutMs: 30_000, debugLabel: "migration-import-batches" });
export const fetchMigrationImportProgress = (token: string, batchId: string) =>
  apiRequest<MigrationImportProgress>(`/v1/admin/migration-import/progress?batchId=${encodeURIComponent(batchId)}`, {}, token, { timeoutMs: 15_000, debugLabel: "migration-import-progress" });
export const retryMigrationAttendance = (token: string, input: { workspaceId: string; batchId: string }) =>
  apiRequest<{ job: MigrationImportJobStatus }>("/v1/admin/migration-import/retry-attendance", { method: "POST", body: JSON.stringify(input) }, token, { timeoutMs: 30_000, debugLabel: "migration-import-retry-attendance" });
export const rollbackMigrationImportBatch = (token: string, input: { workspaceId: string; batchId: string }) =>
  apiRequest<{ message: string; result: { operationalRecords: number; seasons: number; farms: number } }>("/v1/admin/migration-import/rollback", { method: "POST", body: JSON.stringify(input) }, token, { timeoutMs: 60_000, debugLabel: "migration-import-rollback" });
export const markMigrationImportBatchClosed = (token: string, input: { workspaceId: string; batchId: string }) =>
  apiRequest<{ message: string }>("/v1/admin/migration-import/mark-closed", { method: "POST", body: JSON.stringify(input) }, token, { timeoutMs: 30_000, debugLabel: "migration-import-mark-closed" });
export const fetchMigrationImportHistory = (token: string, workspaceId: string) =>
  apiRequest<{ records: MigrationImportHistoryRecord[] }>(`/v1/admin/migration-import/history?workspaceId=${encodeURIComponent(workspaceId)}`, {}, token, { timeoutMs: 30_000, debugLabel: "migration-import-history" });
export const repairMigrationImportVisibility = (token: string, input: { workspaceId: string }) =>
  apiRequest<MigrationVisibilityRepairResult>("/v1/admin/migration-import/repair-visibility", { method: "POST", body: JSON.stringify(input) }, token, { timeoutMs: 60_000, debugLabel: "migration-import-repair-visibility" });
export const repairDeletedFarmSeasonState = (token: string, input: { workspaceId: string }) =>
  apiRequest<DeletedFarmSeasonRepairResult>("/v1/admin/migration-import/repair-deleted-state", { method: "POST", body: JSON.stringify(input) }, token, { timeoutMs: 60_000, debugLabel: "migration-import-repair-deleted-state" });
export const repairDuplicateImportedAccounts = (token: string, input: { workspaceId: string }) =>
  apiRequest<DuplicateImportedAccountsRepairResult>("/v1/admin/migration-import/repair-duplicate-accounts", { method: "POST", body: JSON.stringify(input) }, token, { timeoutMs: 60_000, debugLabel: "migration-import-repair-duplicate-accounts" });
export const repairImportedVoucherNumbers = (token: string, input: { workspaceId: string }) =>
  apiRequest<ImportedVoucherNumberRepairResult>("/v1/admin/migration-import/repair-voucher-numbers", { method: "POST", body: JSON.stringify(input) }, token, { timeoutMs: 60_000, debugLabel: "migration-import-repair-voucher-numbers" });
export const fetchWorkspaceImportContextRepairPreview = (token: string, workspaceId: string) =>
  apiRequest<{ preview: WorkspaceImportContextPreview }>(`/v1/admin/migration-import/repair-workspace-context/preview?workspaceId=${encodeURIComponent(workspaceId)}`, {}, token, { timeoutMs: 60_000, debugLabel: "migration-import-repair-workspace-context-preview" });
export const repairWorkspaceImportContext = (token: string, input: { workspaceId: string; backupConfirmed: true }) =>
  apiRequest<WorkspaceImportContextRepairResult>("/v1/admin/migration-import/repair-workspace-context", { method: "POST", body: JSON.stringify(input) }, token, { timeoutMs: 120_000, debugLabel: "migration-import-repair-workspace-context" });
export const fetchMigrationImportCleanupPreview = (token: string, workspaceId: string, batchId: string) =>
  apiRequest<{ preview: MigrationImportCleanupPreview }>(`/v1/admin/migration-import/cleanup-preview?workspaceId=${encodeURIComponent(workspaceId)}&batchId=${encodeURIComponent(batchId)}`, {}, token, { timeoutMs: 30_000, debugLabel: "migration-import-cleanup-preview" });
export const fetchAccountingDiagnostics = (token: string, input: { workspaceId: string; farmId?: string; seasonId?: string }) => {
  const query = new URLSearchParams({ workspaceId: input.workspaceId });
  if (input.farmId) query.set("farmId", input.farmId);
  if (input.seasonId) query.set("seasonId", input.seasonId);
  return apiRequest<AccountingDiagnostics>(`/v1/admin/accounting-diagnostics?${query.toString()}`, {}, token, { timeoutMs: 30_000, debugLabel: "accounting-diagnostics" });
};
export const fetchAccountingReconciliationTrace = (
  token: string,
  input: { accountName?: string; accountId?: string; workspaceId?: string; farmId?: string; seasonId?: string },
) => {
  const query = new URLSearchParams();
  if (input.accountName) query.set("accountName", input.accountName);
  if (input.accountId) query.set("accountId", input.accountId);
  if (input.workspaceId) query.set("workspaceId", input.workspaceId);
  if (input.farmId) query.set("farmId", input.farmId);
  if (input.seasonId) query.set("seasonId", input.seasonId);
  return apiRequest<AccountingReconciliationTrace>(
    `/v1/debug/accounting-reconciliation?${query.toString()}`,
    {},
    token,
    { timeoutMs: 30_000, debugLabel: "accounting-reconciliation-trace" },
  );
};
export const fetchWorkspaceAccounts = (
  token: string,
  workspaceId: string,
  input: { search?: string; farmId?: string; accountId?: string },
) => {
  const query = new URLSearchParams();
  if (input.search) query.set("search", input.search);
  if (input.farmId) query.set("farmId", input.farmId);
  if (input.accountId) query.set("accountId", input.accountId);
  return apiRequest<{ accounts: AccountingReconciliationAccountOption[] }>(`/v1/workspace/${workspaceId}/accounts?${query.toString()}`, {}, token);
};
export const cleanFailedMigrationImport = (token: string, input: {
  workspaceId: string;
  batchId: string;
  confirmation: "CLEAN FAILED IMPORT";
  backupConfirmed: true;
  includeEditedImportedRecords?: boolean;
}) => apiRequest<{ message: string; result: MigrationImportCleanupResult }>(
  "/v1/admin/migration-import/cleanup-failed",
  { method: "POST", body: JSON.stringify(input) },
  token,
  { timeoutMs: 60_000, debugLabel: "migration-import-cleanup-failed" },
);
export const cancelAndCleanMigrationImport = (token: string, input: {
  workspaceId: string;
  batchId: string;
  confirmationText: "CANCEL AND CLEAN IMPORT";
  backupConfirmed: true;
  includeEditedImportedRecords?: boolean;
}) => apiRequest<{ message: string; result: MigrationImportCleanupResult }>(
  "/v1/admin/migration-import/cancel-and-clean",
  { method: "POST", body: JSON.stringify(input) },
  token,
  { timeoutMs: 60_000, debugLabel: "migration-import-cancel-and-clean" },
);
export const fetchImportVisibilityAudit = (token: string, workspaceId: string) =>
  apiRequest<ImportVisibilityAudit>(`/v1/workspace/${workspaceId}/import-visibility-audit`, {}, token, { timeoutMs: 30_000, debugLabel: "import-visibility-audit" });
export const fetchApprovals = (token: string) =>
  apiRequest<{ requests: PendingApproval[] }>("/v1/admin/approvals", {}, token);
export const approveSignup = (token: string, userId: string) =>
  apiRequest<void>("/v1/admin/approvals/approve", { method: "POST", body: JSON.stringify({ userId }) }, token);
export const rejectSignup = (token: string, userId: string) =>
  apiRequest<void>("/v1/admin/approvals/reject", { method: "POST", body: JSON.stringify({ userId }) }, token);
export const saveOperationalRecord = (token: string, input: OperationalRecordEnvelope) =>
  apiRequest<{ record: OperationalRecordEnvelope["record"]; conflict: boolean }>("/v1/workspace/operational-records", { method: "POST", body: JSON.stringify(input) }, token, { debugLabel: `operational-record-save:${input.entity}` });
export const validateVoucherNumber = (token: string, workspaceId: string, input: { voucherNumber: string; recordId?: string; farmId?: string }) => {
  const query = new URLSearchParams({ voucherNumber: input.voucherNumber });
  if (input.recordId) query.set("recordId", input.recordId);
  if (input.farmId) query.set("farmId", input.farmId);
  return apiRequest<VoucherNumberValidation>(`/v1/workspace/${workspaceId}/voucher-number-availability?${query.toString()}`, {}, token, { debugLabel: "voucher-number-validate" });
};
export const deleteOperationalRecord = (token: string, input: Omit<OperationalRecordEnvelope, "record"> & { recordId: string; reason?: string }) =>
  apiRequest<void>("/v1/workspace/operational-records", { method: "DELETE", body: JSON.stringify(input) }, token, { debugLabel: `operational-record-delete:${input.entity}` });
export const fetchOperationalRecords = (token: string, workspaceId: string) =>
  apiRequest<OperationalSnapshot>(`/v1/workspace/${workspaceId}/operational-records`, {}, token);
export const fetchOperationalRecord = (token: string, workspaceId: string, recordId: string) =>
  apiRequest<OperationalRecordEnvelope>(`/v1/workspace/${workspaceId}/operational-records/${encodeURIComponent(recordId)}`, {}, token, { debugLabel: "operational-record-fetch" });
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
export const fetchWageRates = (
  token: string,
  workspaceId: string,
  filters: { farmId: string; seasonId: string; labourerId?: string; includeInactive?: boolean },
) => {
  const query = new URLSearchParams({ farmId: filters.farmId, seasonId: filters.seasonId });
  if (filters.labourerId) query.set("labourerId", filters.labourerId);
  if (typeof filters.includeInactive === "boolean") query.set("includeInactive", String(filters.includeInactive));
  return apiRequest<{ rates: WageRateRecord[] }>(`/v1/workspace/${workspaceId}/wage-rates?${query.toString()}`, {}, token);
};
export const validateWageRateOverlap = (
  token: string,
  workspaceId: string,
  input: { farmId: string; seasonId: string; effectiveFrom: string; effectiveTo?: string | null; rows: WageRateBulkRowInput[] },
) => apiRequest<{ valid: boolean; overlaps: WageRateOverlapPreview[] }>(
  `/v1/workspace/${workspaceId}/wage-rates/validate-overlap`,
  { method: "POST", body: JSON.stringify(input) },
  token,
);
export const bulkUpsertWageRates = (token: string, workspaceId: string, input: WageRateBulkUpsertInput) =>
  apiRequest<{ rates: WageRateRecord[] }>(
    `/v1/workspace/${workspaceId}/wage-rates/bulk`,
    { method: "POST", body: JSON.stringify(input) },
    token,
    { timeoutMs: 60_000, debugLabel: "wage-rates-bulk-upsert" },
  );
export const calculateWageRates = (
  token: string,
  workspaceId: string,
  filters: { farmId: string; seasonId: string; from: string; to: string; labourIds?: string[] },
) => {
  const query = new URLSearchParams({
    farmId: filters.farmId,
    seasonId: filters.seasonId,
    from: filters.from,
    to: filters.to,
  });
  if (filters.labourIds?.length) query.set("labourIds", filters.labourIds.join(","));
  return apiRequest<WageRateCalculateResult>(`/v1/workspace/${workspaceId}/wage-rates/calculate?${query.toString()}`, {}, token);
};
export const fetchLabourWageSettlements = (
  token: string,
  workspaceId: string,
  filters: { farmId: string; seasonId: string },
) => {
  const query = new URLSearchParams({ farmId: filters.farmId, seasonId: filters.seasonId });
  return apiRequest<{ settlements: LabourWageSettlementRecord[]; diagnostics: Record<string, number> }>(
    `/v1/workspace/${workspaceId}/labour-wage-settlements?${query.toString()}`,
    {},
    token,
  );
};
export const fetchLabourWageSettlementPaymentAccounts = (
  token: string,
  workspaceId: string,
  farmId: string,
) => apiRequest<{ accounts: LabourWageSettlementPaymentAccount[] }>(
  `/v1/workspace/${workspaceId}/labour-wage-settlements/payment-accounts?farmId=${encodeURIComponent(farmId)}`,
  {},
  token,
  { timeoutMs: 30_000, debugLabel: "labour-wage-settlement-payment-accounts" },
);
export const previewLabourWageSettlement = (
  token: string,
  workspaceId: string,
  input: {
    farmId: string;
    seasonId: string;
    fromDate: string;
    toDate: string;
    settlementDate: string;
    settlementMode?: "individual" | "group";
    labourerId?: string | null;
    foremanId?: string | null;
    groupId?: string | null;
    labourIds?: string[];
    paymentAccountId?: string | null;
    accountId?: string | null;
    paidAmount?: number;
    manualAdjustment?: number;
  },
) => apiRequest<{ valid: boolean; preview: LabourWageSettlementPreview }>(
  `/v1/workspace/${workspaceId}/labour-wage-settlements/preview`,
  { method: "POST", body: JSON.stringify(input) },
  token,
  { timeoutMs: 60_000, debugLabel: "labour-wage-settlement-preview" },
);
export const fetchLabourWageSettlement = (
  token: string,
  workspaceId: string,
  settlementId: string,
) => apiRequest<{ settlement: LabourWageSettlementDetail }>(
  `/v1/workspace/${workspaceId}/labour-wage-settlements/${settlementId}`,
  {},
  token,
  { timeoutMs: 30_000, debugLabel: "labour-wage-settlement-detail" },
);
export const createLabourWageSettlement = (
  token: string,
  workspaceId: string,
  input: LabourWageSettlementCreateInput,
) => apiRequest<LabourWageSettlementCreateStatus>(
  `/v1/workspace/${workspaceId}/labour-wage-settlements`,
  { method: "POST", body: JSON.stringify(input) },
  token,
  { timeoutMs: 120_000, debugLabel: "labour-wage-settlement-create" },
);
export const fetchLabourWageSettlementCreateStatus = (
  token: string,
  workspaceId: string,
  input: { farmId: string; seasonId: string; clientRequestId: string },
) => {
  const query = new URLSearchParams({
    farmId: input.farmId,
    seasonId: input.seasonId,
    clientRequestId: input.clientRequestId,
  });
  return apiRequest<LabourWageSettlementCreateStatus>(
    `/v1/workspace/${workspaceId}/labour-wage-settlements/status?${query.toString()}`,
    {},
    token,
    { timeoutMs: 30_000, debugLabel: "labour-wage-settlement-status" },
  );
};
export const fetchLabourWageSettlementDiagnostics = (
  token: string,
  workspaceId: string,
  input: { settlementNumber?: string; settlementId?: string; clientRequestId?: string },
) => {
  const query = new URLSearchParams();
  if (input.settlementNumber) query.set("settlementNumber", input.settlementNumber);
  if (input.settlementId) query.set("settlementId", input.settlementId);
  if (input.clientRequestId) query.set("clientRequestId", input.clientRequestId);
  return apiRequest<LabourWageSettlementDiagnostics>(
    `/v1/workspace/${workspaceId}/admin/labour-wage-settlements/diagnostics?${query.toString()}`,
    {},
    token,
    { timeoutMs: 30_000, debugLabel: "labour-wage-settlement-diagnostics" },
  );
};
export const updateLabourWageSettlement = (
  token: string,
  workspaceId: string,
  settlementId: string,
  input: {
    fromDate?: string;
    toDate?: string;
    settlementDate?: string;
    accountId?: string;
    paymentAccountId?: string;
    notes?: string | null;
  },
) => apiRequest<{ settlement: LabourWageSettlementDetail; accountingEntries: number }>(
  `/v1/workspace/${workspaceId}/labour-wage-settlements/${settlementId}`,
  { method: "PATCH", body: JSON.stringify(input) },
  token,
  { timeoutMs: 60_000, debugLabel: "labour-wage-settlement-update" },
);
export const voidLabourWageSettlement = (
  token: string,
  workspaceId: string,
  settlementId: string,
  input: { voidReason?: string },
) => apiRequest<{
  settlementId: string;
  settlementNumber: string;
  status: "voided";
  voidedAt: string;
  voidedBy: string;
  voidReason: string;
  accountingEntries: number;
}>(
  `/v1/workspace/${workspaceId}/labour-wage-settlements/${settlementId}/void`,
  { method: "POST", body: JSON.stringify(input) },
  token,
  { timeoutMs: 60_000, debugLabel: "labour-wage-settlement-void" },
);
export const repairLabourWageSettlementAccounting = (
  token: string,
  workspaceId: string,
  settlementId: string,
) => apiRequest<{
  settlementId: string;
  settlementNumber: string;
  accountingStatus: "posted" | "accounting_missing" | "voided" | "deleted";
  createdTransactions: number;
  existingTransactions: number;
  accountId: string;
  amount: number;
}>(
  `/v1/workspace/${workspaceId}/labour-wage-settlements/${settlementId}/repair-accounting`,
  { method: "POST" },
  token,
  { timeoutMs: 60_000, debugLabel: "labour-wage-settlement-repair-accounting" },
);
export const deleteLabourWageSettlement = (
  token: string,
  workspaceId: string,
  settlementId: string,
) => apiRequest<{
  settlementId: string;
  settlementNumber: string;
  status: "deleted";
  linkedVoucherId: string;
  linkedVoucherNumber: string;
  accountingEntries: number;
}>(
  `/v1/workspace/${workspaceId}/labour-wage-settlements/${settlementId}`,
  { method: "DELETE" },
  token,
  { timeoutMs: 60_000, debugLabel: "labour-wage-settlement-delete" },
);
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
  if (typeof filters.includeDeleted === "boolean") query.set("includeDeleted", String(filters.includeDeleted));
  if (typeof filters.includeImported === "boolean") query.set("includeImported", String(filters.includeImported));
  if (typeof filters.includeSettlementVouchers === "boolean") query.set("includeSettlementVouchers", String(filters.includeSettlementVouchers));
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
export const fetchExpenseAttachments = (token: string, workspaceId: string, expenseId: string) =>
  apiRequest<{ attachments: ExpenseAttachment[] }>(`/v1/workspace/${workspaceId}/expenses/${expenseId}/attachments`, {}, token);
export const uploadExpenseAttachment = (token: string, workspaceId: string, expenseId: string, input: ExpenseAttachmentUpload) =>
  apiRequest<{ attachment: ExpenseAttachment }>(`/v1/workspace/${workspaceId}/expenses/${expenseId}/attachments`, { method: "POST", body: JSON.stringify(input) }, token, { timeoutMs: 60_000 });
export const deleteExpenseAttachment = (token: string, workspaceId: string, expenseId: string, attachmentId: string) =>
  apiRequest<void>(`/v1/workspace/${workspaceId}/expenses/${expenseId}/attachments/${attachmentId}`, { method: "DELETE" }, token);
export const extractExpenseReceipt = (token: string, workspaceId: string, attachmentId: string) =>
  apiRequest<ExpenseOcrSuggestion>(`/v1/workspace/${workspaceId}/expenses/receipts/${attachmentId}/extract`, { method: "POST", body: JSON.stringify({}) }, token, { timeoutMs: 60_000 });
export async function openExpenseAttachment(token: string, workspaceId: string, expenseId: string, attachment: Pick<ExpenseAttachment, "id" | "fileName">, variant: "cropped" | "original" = "cropped"): Promise<void> {
  const suffix = variant === "original" ? "/original" : "/download";
  const response = await fetch(`${config.apiUrl}/v1/workspace/${workspaceId}/expenses/${expenseId}/attachments/${attachment.id}${suffix}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new ApiError("Unable to open receipt attachment.", response.status);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener,noreferrer");
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function downloadMigrationImportFailures(token: string, jobId: string): Promise<void> {
  const response = await fetch(`${config.apiUrl}/v1/admin/migration-imports/${encodeURIComponent(jobId)}/failures.csv`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new ApiError(body?.message ?? "Unable to download migration import failures.", response.status);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `migration-import-failures-${jobId}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
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
