import type { AppUser, Permission, WorkspaceModule, WorkspaceModuleAction, WorkspaceRole } from "./api";

const platformPermissions = new Set<Permission>([
  "CREATE_WORKSPACE", "DELETE_WORKSPACE", "VIEW_WORKSPACES", "VIEW_USERS", "MANAGE_SUBSCRIPTIONS",
  "MANAGE_BILLING", "MANAGE_PLATFORM_SETTINGS", "VIEW_AUDIT_LOGS", "VIEW_SYSTEM_HEALTH",
]);

const permissionsByRole: Record<AppUser["role"], readonly Permission[]> = {
  platform_admin: [...platformPermissions],
  platform_support: ["VIEW_WORKSPACES", "VIEW_USERS", "VIEW_AUDIT_LOGS", "VIEW_SYSTEM_HEALTH"],
  workspace_owner: ["APPROVE_EXPENSE", "APPROVE_ATTENDANCE", "APPROVE_SALE", "APPROVE_DISPATCH", "MANAGE_TEAM", "MANAGE_FARMS", "MANAGE_SEASONS", "MANAGE_EXPENSE_CATEGORIES", "IMPORT_ATTENDANCE", "MANAGE_RECORDS", "SUBMIT_RECORDS", "VIEW_REPORTS"],
  workspace_manager: ["APPROVE_EXPENSE", "APPROVE_ATTENDANCE", "APPROVE_SALE", "APPROVE_DISPATCH", "MANAGE_TEAM", "MANAGE_FARMS", "MANAGE_SEASONS", "MANAGE_RECORDS", "SUBMIT_RECORDS", "VIEW_REPORTS"],
  supervisor: ["APPROVE_EXPENSE", "APPROVE_ATTENDANCE", "APPROVE_SALE", "APPROVE_DISPATCH", "MANAGE_RECORDS", "SUBMIT_RECORDS", "VIEW_REPORTS"],
  operator: ["SUBMIT_RECORDS"],
  viewer: ["VIEW_REPORTS"],
};

export function hasPermission(user: AppUser, permission: Permission, workspaceId?: string): boolean {
  if (platformPermissions.has(permission)) return Boolean(user.platformRole && permissionsByRole[user.platformRole].includes(permission));
  if (!workspaceId) return false;
  const membership = user.memberships.find((item) => item.active && item.workspaceId === workspaceId);
  if (!membership || !permissionsByRole[membership.role].includes(permission)) return false;
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
  workspace_owner: Object.fromEntries(["dashboard", "workforce", "attendance", "advances", "expenses", "sales", "dispatch", "inventory", "accounts", "reports", "settings", "team"].map((module) => [module, { ...allActions }])) as Record<WorkspaceModule, Record<WorkspaceModuleAction, boolean>>,
  workspace_manager: { dashboard: { ...viewOnly }, workforce: { ...viewCreateEdit }, attendance: { ...viewCreateEdit, approve: true }, advances: { ...viewCreateEdit }, expenses: { ...viewCreateEdit }, sales: { ...viewCreateEdit }, dispatch: { ...viewCreateEdit }, inventory: { ...viewCreateEdit }, accounts: { ...viewOnly }, reports: { ...viewOnly, export: true }, settings: { ...viewOnly }, team: { ...viewOnly } },
  supervisor: { dashboard: { ...viewOnly }, workforce: { ...viewOnly }, attendance: { ...viewCreateEdit }, advances: { ...viewCreateEdit }, expenses: { ...viewCreateEdit }, sales: { ...viewCreateEdit }, dispatch: { ...viewCreateEdit }, inventory: { ...viewCreateEdit }, accounts: { ...viewOnly }, reports: { ...viewOnly }, settings: { ...viewOnly }, team: { ...viewOnly } },
  operator: { dashboard: { ...viewOnly }, workforce: { ...viewOnly }, attendance: { ...viewCreate }, advances: { ...viewCreate }, expenses: { ...viewCreate }, sales: { ...viewCreate }, dispatch: { ...viewCreate }, inventory: { ...viewCreate }, accounts: { ...viewOnly, view: false }, reports: { ...viewOnly, view: false }, settings: { ...viewOnly, view: false }, team: { ...viewOnly, view: false } },
  viewer: Object.fromEntries(["dashboard", "workforce", "attendance", "advances", "expenses", "sales", "dispatch", "inventory", "accounts", "reports", "settings", "team"].map((module) => [module, { ...viewOnly }])) as Record<WorkspaceModule, Record<WorkspaceModuleAction, boolean>>,
};

export function hasModulePermission(user: AppUser, module: WorkspaceModule, action: WorkspaceModuleAction, workspaceId = user.workspaceId ?? "") {
  const membership = user.memberships.find((item) => item.active && item.workspaceId === workspaceId);
  return Boolean(membership && (membership.permissions?.[module]?.[action] ?? roleModulePermissions[membership.role][module][action]));
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
export const getHomePath = (user: AppUser) => isPlatformUser(user) ? "/admin/dashboard" : "/workspace/dashboard";
