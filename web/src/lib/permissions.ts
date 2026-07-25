import type { AccountStatus, AppUser, Permission, WorkspaceModule, WorkspaceModuleAction, WorkspaceRole } from "./api";
import type { PendingMutation } from "./offline-db";

const platformPermissions = new Set<Permission>([
  "CREATE_WORKSPACE", "DELETE_WORKSPACE", "VIEW_WORKSPACES", "VIEW_USERS", "MANAGE_SUBSCRIPTIONS",
  "MANAGE_BILLING", "MANAGE_PLATFORM_SETTINGS", "VIEW_AUDIT_LOGS", "VIEW_SYSTEM_HEALTH", "MANAGE_REGISTRATIONS",
]);

const permissionsByRole: Record<AppUser["role"], readonly Permission[]> = {
  platform_admin: [...platformPermissions],
  platform_support: ["VIEW_WORKSPACES", "VIEW_USERS", "VIEW_AUDIT_LOGS", "VIEW_SYSTEM_HEALTH"],
  workspace_owner: ["APPROVE_EXPENSE", "APPROVE_ATTENDANCE", "APPROVE_SALE", "APPROVE_DISPATCH", "MANAGE_TEAM", "MANAGE_FARMS", "MANAGE_SEASONS", "MANAGE_EXPENSE_CATEGORIES", "IMPORT_ATTENDANCE", "MANAGE_RECORDS", "SUBMIT_RECORDS", "VIEW_REPORTS"],
  workspace_manager: ["APPROVE_EXPENSE", "APPROVE_ATTENDANCE", "APPROVE_SALE", "APPROVE_DISPATCH", "MANAGE_TEAM", "MANAGE_FARMS", "MANAGE_SEASONS", "MANAGE_RECORDS", "SUBMIT_RECORDS", "VIEW_REPORTS"],
  supervisor: ["APPROVE_EXPENSE", "APPROVE_ATTENDANCE", "APPROVE_SALE", "APPROVE_DISPATCH", "MANAGE_RECORDS", "SUBMIT_RECORDS", "VIEW_REPORTS"],
  accountant: ["MANAGE_RECORDS", "SUBMIT_RECORDS", "VIEW_REPORTS"],
  operator: ["SUBMIT_RECORDS"],
  viewer: ["VIEW_REPORTS"],
};

const workspaceRolePriority: Record<WorkspaceRole, number> = {
  workspace_owner: 5,
  workspace_manager: 4,
  supervisor: 3,
  accountant: 2,
  operator: 1,
  viewer: 0,
};

function normalizeWorkspaceRole(role: string | null | undefined): WorkspaceRole {
  if (role === "owner") return "workspace_owner";
  if (role === "admin") return "workspace_owner";
  if (role === "manager") return "workspace_manager";
  if (role === "worker") return "operator";
  return (role && role in roleModulePermissions ? role : "viewer") as WorkspaceRole;
}

function selectWorkspaceMembership(user: AppUser, workspaceId: string) {
  return user.memberships
    .filter((item) => item.active && item.workspaceId === workspaceId)
    .map((item) => ({ ...item, role: normalizeWorkspaceRole(item.role) }))
    .sort((left, right) => {
      const roleDiff = workspaceRolePriority[right.role] - workspaceRolePriority[left.role];
      if (roleDiff !== 0) return roleDiff;
      if (Boolean(left.permissions) !== Boolean(right.permissions)) return left.permissions ? -1 : 1;
      return 0;
    })[0] ?? null;
}

let permissionContextUser: AppUser | null = null;

export function setPermissionContextUser(user: AppUser | null) {
  permissionContextUser = user;
}

export function getPermissionContextUser() {
  return permissionContextUser;
}

export function hasPermission(user: AppUser, permission: Permission, workspaceId?: string): boolean {
  if (platformPermissions.has(permission)) return Boolean(user.platformRole && permissionsByRole[user.platformRole].includes(permission));
  if (!workspaceId) return false;
  const membership = selectWorkspaceMembership(user, workspaceId);
  if (!membership) return false;
  if (membership.role === "workspace_owner") return true;
  if (!permissionsByRole[membership.role].includes(permission)) return false;
  const moduleGate: Partial<Record<Permission, [WorkspaceModule, WorkspaceModuleAction]>> = {
    APPROVE_ATTENDANCE: ["attendance", "approve"],
    APPROVE_EXPENSE: ["expenses", "approve"],
    APPROVE_SALE: ["sales", "approve"],
    APPROVE_DISPATCH: ["dispatch", "approve"],
    MANAGE_TEAM: ["team", "edit"],
    MANAGE_FARMS: ["settings", "edit"],
    MANAGE_SEASONS: ["settings", "edit"],
    MANAGE_EXPENSE_CATEGORIES: ["expenses", "edit"],
    IMPORT_ATTENDANCE: ["attendance", "create"],
    VIEW_REPORTS: ["reports", "view"],
  };
  const gate = moduleGate[permission];
  return gate ? hasModulePermission(user, gate[0], gate[1], workspaceId) : true;
}

const allActions = { view: true, create: true, edit: true, delete: true, approve: true, export: true };
const viewCreateEdit = { view: true, create: true, edit: true, delete: false, approve: false, export: false };
const viewCreate = { view: true, create: true, edit: false, delete: false, approve: false, export: false };
const viewOnly = { view: true, create: false, edit: false, delete: false, approve: false, export: false };
export const roleModulePermissions: Record<WorkspaceRole, Record<WorkspaceModule, Record<WorkspaceModuleAction, boolean>>> = {
  workspace_owner: Object.fromEntries(["dashboard", "workforce", "attendance", "advances", "wages", "expenses", "sales", "dispatch", "inventory", "harvest", "accounts", "reports", "settings", "team"].map((module) => [module, { ...allActions }])) as Record<WorkspaceModule, Record<WorkspaceModuleAction, boolean>>,
  workspace_manager: { dashboard: { ...viewOnly }, workforce: { ...viewCreateEdit }, attendance: { ...viewCreateEdit, approve: true }, advances: { ...viewCreateEdit }, wages: { ...viewCreateEdit, export: true }, expenses: { ...viewCreateEdit }, sales: { ...viewCreateEdit }, dispatch: { ...viewCreateEdit }, inventory: { ...viewCreateEdit }, harvest: { ...viewCreateEdit, delete: true, export: true }, accounts: { ...viewOnly }, reports: { ...viewOnly, export: true }, settings: { ...viewOnly }, team: { ...viewOnly } },
  supervisor: { dashboard: { ...viewOnly }, workforce: { ...viewOnly }, attendance: { ...viewCreateEdit }, advances: { ...viewCreateEdit }, wages: { ...viewOnly, export: true }, expenses: { ...viewCreateEdit }, sales: { ...viewCreateEdit }, dispatch: { ...viewCreateEdit }, inventory: { ...viewCreateEdit }, harvest: { ...viewCreateEdit, delete: true, export: true }, accounts: { ...viewOnly }, reports: { ...viewOnly }, settings: { ...viewOnly }, team: { ...viewOnly } },
  accountant: { dashboard: { ...viewOnly }, workforce: { ...viewOnly }, attendance: { ...viewOnly }, advances: { ...viewCreateEdit, export: true }, wages: { ...viewCreateEdit, export: true }, expenses: { ...viewCreateEdit, export: true }, sales: { ...viewOnly }, dispatch: { ...viewOnly }, inventory: { ...viewOnly }, harvest: { ...viewOnly, export: true }, accounts: { ...viewCreateEdit, export: true }, reports: { ...viewOnly, export: true }, settings: { ...viewOnly, view: false }, team: { ...viewOnly, view: false } },
  operator: { dashboard: { ...viewOnly }, workforce: { ...viewOnly }, attendance: { ...viewCreate }, advances: { ...viewCreate }, wages: { ...viewOnly }, expenses: { ...viewCreate }, sales: { ...viewCreate }, dispatch: { ...viewCreate }, inventory: { ...viewCreate }, harvest: { ...viewCreateEdit }, accounts: { ...viewOnly, view: false }, reports: { ...viewOnly, view: false }, settings: { ...viewOnly, view: false }, team: { ...viewOnly, view: false } },
  viewer: Object.fromEntries(["dashboard", "workforce", "attendance", "advances", "wages", "expenses", "sales", "dispatch", "inventory", "harvest", "accounts", "reports", "settings", "team"].map((module) => [module, { ...viewOnly }])) as Record<WorkspaceModule, Record<WorkspaceModuleAction, boolean>>,
};

export function hasModulePermission(user: AppUser, module: WorkspaceModule, action: WorkspaceModuleAction, workspaceId = user.workspaceId ?? "") {
  const membership = selectWorkspaceMembership(user, workspaceId);
  return Boolean(membership && (membership.role === "workspace_owner" || (membership.permissions?.[module]?.[action] ?? roleModulePermissions[membership.role][module][action])));
}

type OperationalEntity =
  | PendingMutation["entity"];

export function moduleForOperationalEntity(entity: OperationalEntity): WorkspaceModule {
  if (["labourer", "labourGroup", "labourPayment", "productionEntry"].includes(entity)) return "workforce";
  if (entity === "attendance") return "attendance";
  if (entity === "advance") return "advances";
  if (entity === "labourEarning") return "wages";
  if (entity === "labourWageSettlement") return "wages";
  if (entity === "wageRate") return "wages";
  if (entity === "voucher") return "expenses";
  if (entity === "sale") return "sales";
  if (["dispatch", "vehicle", "dateType"].includes(entity)) return "dispatch";
  if (entity === "inventoryEntry") return "inventory";
  if (entity === "harvestGroup" || entity === "harvestEntry") return "harvest";
  return "accounts";
}

export function canQueueOperationalMutation(
  entity: OperationalEntity,
  operation: "create" | "edit" | "delete",
  user = permissionContextUser,
) {
  if (!user?.workspaceId) return false;
  const action: WorkspaceModuleAction = operation === "delete" ? "delete" : operation === "edit" ? "edit" : "create";
  return hasModulePermission(user, moduleForOperationalEntity(entity), action, user.workspaceId);
}

export const canView = (user: AppUser, module: WorkspaceModule, workspaceId = user.workspaceId ?? "") =>
  hasModulePermission(user, module, "view", workspaceId);

export const canCreate = (user: AppUser, module: WorkspaceModule, workspaceId = user.workspaceId ?? "") =>
  hasModulePermission(user, module, "create", workspaceId);

export const canEdit = (user: AppUser, module: WorkspaceModule, workspaceId = user.workspaceId ?? "") =>
  hasModulePermission(user, module, "edit", workspaceId);

export const canDelete = (user: AppUser, module: WorkspaceModule, workspaceId = user.workspaceId ?? "") =>
  hasModulePermission(user, module, "delete", workspaceId);

export const canExport = (user: AppUser, module: WorkspaceModule, workspaceId = user.workspaceId ?? "") =>
  hasModulePermission(user, module, "export", workspaceId);

export const canManageTeam = (user: AppUser, workspaceId = user.workspaceId ?? "") =>
  hasModulePermission(user, "team", "edit", workspaceId);

export const canManagePermissions = (user: AppUser, workspaceId = user.workspaceId ?? "") =>
  hasModulePermission(user, "team", "approve", workspaceId) || hasModulePermission(user, "team", "edit", workspaceId);

export const isPlatformUser = (user: AppUser) => Boolean(user.platformRole);

export const getHomePath = (user: AppUser) => {
  if (!isPlatformUser(user) && !user.workspaceId) return "/onboarding";
  return isPlatformUser(user) ? "/admin/dashboard" : "/workspace/dashboard";
};

const accountStatusPaths: Partial<Record<AccountStatus, string>> = {
  pending: "/pending-approval",
  rejected: "/account-rejected",
  suspended: "/account-suspended",
};

export const getAccountStatusPath = (user: AppUser): string | null => accountStatusPaths[user.status] ?? null;
