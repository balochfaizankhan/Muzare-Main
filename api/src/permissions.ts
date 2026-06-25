export const platformRoles = ["platform_admin", "platform_support"] as const;
export const workspaceRoles = ["workspace_owner", "workspace_manager", "supervisor", "operator", "viewer"] as const;

export type PlatformRole = (typeof platformRoles)[number];
export type WorkspaceRole = (typeof workspaceRoles)[number];
export type AppRole = PlatformRole | WorkspaceRole;

export type PlatformPermission =
  | "CREATE_WORKSPACE"
  | "DELETE_WORKSPACE"
  | "VIEW_WORKSPACES"
  | "VIEW_USERS"
  | "MANAGE_SUBSCRIPTIONS"
  | "MANAGE_BILLING"
  | "MANAGE_PLATFORM_SETTINGS"
  | "VIEW_AUDIT_LOGS"
  | "VIEW_SYSTEM_HEALTH";

export type WorkspacePermission =
  | "APPROVE_EXPENSE"
  | "APPROVE_ATTENDANCE"
  | "APPROVE_SALE"
  | "APPROVE_DISPATCH"
  | "MANAGE_TEAM"
  | "MANAGE_FARMS"
  | "MANAGE_SEASONS"
  | "MANAGE_EXPENSE_CATEGORIES"
  | "IMPORT_ATTENDANCE"
  | "MANAGE_RECORDS"
  | "SUBMIT_RECORDS"
  | "VIEW_REPORTS";

export type Permission = PlatformPermission | WorkspacePermission;
export const workspaceModules = ["dashboard", "workforce", "attendance", "advances", "expenses", "sales", "dispatch", "inventory", "accounts", "reports", "settings", "team"] as const;
export const workspaceModuleActions = ["view", "create", "edit", "delete", "approve", "export"] as const;
export type WorkspaceModule = (typeof workspaceModules)[number];
export type WorkspaceModuleAction = (typeof workspaceModuleActions)[number];
export type WorkspaceModulePermissions = Partial<Record<WorkspaceModule, Partial<Record<WorkspaceModuleAction, boolean>>>>;

export type PermissionUser = {
  platformRole: PlatformRole | null;
  memberships: Array<{ workspaceId: string; role: WorkspaceRole; active: boolean; permissions?: WorkspaceModulePermissions | null }>;
};

const platformPermissions: Record<PlatformRole, readonly PlatformPermission[]> = {
  platform_admin: [
    "CREATE_WORKSPACE", "DELETE_WORKSPACE", "VIEW_WORKSPACES", "VIEW_USERS", "MANAGE_SUBSCRIPTIONS",
    "MANAGE_BILLING", "MANAGE_PLATFORM_SETTINGS", "VIEW_AUDIT_LOGS", "VIEW_SYSTEM_HEALTH",
  ],
  platform_support: ["VIEW_WORKSPACES", "VIEW_USERS", "VIEW_AUDIT_LOGS", "VIEW_SYSTEM_HEALTH"],
};

const workspacePermissions: Record<WorkspaceRole, readonly WorkspacePermission[]> = {
  workspace_owner: [
    "APPROVE_EXPENSE", "APPROVE_ATTENDANCE", "APPROVE_SALE", "APPROVE_DISPATCH", "MANAGE_TEAM",
    "MANAGE_RECORDS", "MANAGE_FARMS", "MANAGE_SEASONS", "MANAGE_EXPENSE_CATEGORIES", "IMPORT_ATTENDANCE", "SUBMIT_RECORDS", "VIEW_REPORTS",
  ],
  workspace_manager: [
    "APPROVE_EXPENSE", "APPROVE_ATTENDANCE", "APPROVE_SALE", "APPROVE_DISPATCH", "MANAGE_TEAM",
    "MANAGE_RECORDS", "MANAGE_FARMS", "MANAGE_SEASONS", "SUBMIT_RECORDS", "VIEW_REPORTS",
  ],
  supervisor: ["APPROVE_EXPENSE", "APPROVE_ATTENDANCE", "APPROVE_SALE", "APPROVE_DISPATCH", "MANAGE_RECORDS", "SUBMIT_RECORDS", "VIEW_REPORTS"],
  operator: ["SUBMIT_RECORDS"],
  viewer: ["VIEW_REPORTS"],
};

const allActions = Object.fromEntries(workspaceModuleActions.map((action) => [action, true])) as Record<WorkspaceModuleAction, boolean>;
const viewCreateEdit = { view: true, create: true, edit: true, delete: false, approve: false, export: false };
const viewCreate = { view: true, create: true, edit: false, delete: false, approve: false, export: false };
const viewOnly = { view: true, create: false, edit: false, delete: false, approve: false, export: false };
export const roleModulePermissions: Record<WorkspaceRole, Record<WorkspaceModule, Record<WorkspaceModuleAction, boolean>>> = {
  workspace_owner: Object.fromEntries(workspaceModules.map((module) => [module, { ...allActions }])) as Record<WorkspaceModule, Record<WorkspaceModuleAction, boolean>>,
  workspace_manager: {
    dashboard: { ...viewOnly }, workforce: { ...viewCreateEdit }, attendance: { ...viewCreateEdit, approve: true },
    advances: { ...viewCreateEdit }, expenses: { ...viewCreateEdit }, sales: { ...viewCreateEdit }, dispatch: { ...viewCreateEdit },
    inventory: { ...viewCreateEdit }, accounts: { ...viewOnly }, reports: { ...viewOnly, export: true },
    settings: { ...viewOnly }, team: { ...viewOnly },
  },
  supervisor: {
    dashboard: { ...viewOnly }, workforce: { ...viewOnly }, attendance: { ...viewCreateEdit }, advances: { ...viewCreateEdit },
    expenses: { ...viewCreateEdit }, sales: { ...viewCreateEdit }, dispatch: { ...viewCreateEdit }, inventory: { ...viewCreateEdit },
    accounts: { ...viewOnly }, reports: { ...viewOnly }, settings: { ...viewOnly }, team: { ...viewOnly },
  },
  operator: {
    dashboard: { ...viewOnly }, workforce: { ...viewOnly }, attendance: { ...viewCreate }, advances: { ...viewCreate },
    expenses: { ...viewCreate }, sales: { ...viewCreate }, dispatch: { ...viewCreate }, inventory: { ...viewCreate },
    accounts: { ...viewOnly, view: false }, reports: { ...viewOnly, view: false }, settings: { ...viewOnly, view: false }, team: { ...viewOnly, view: false },
  },
  viewer: Object.fromEntries(workspaceModules.map((module) => [module, { ...viewOnly }])) as Record<WorkspaceModule, Record<WorkspaceModuleAction, boolean>>,
};

export function hasModulePermission(user: PermissionUser, workspaceId: string, module: WorkspaceModule, action: WorkspaceModuleAction): boolean {
  const membership = user.memberships.find((item) => item.active && item.workspaceId === workspaceId);
  if (!membership) return false;
  return membership.permissions?.[module]?.[action] ?? roleModulePermissions[membership.role][module][action];
}

export function hasPermission(user: PermissionUser, permission: Permission, workspaceId?: string): boolean {
  if (permission in platformPermissionSet) {
    return user.platformRole ? platformPermissions[user.platformRole].includes(permission as PlatformPermission) : false;
  }
  if (!workspaceId) return false;
  const membership = user.memberships.find((item) => item.active && item.workspaceId === workspaceId);
  if (!membership || !workspacePermissions[membership.role].includes(permission as WorkspacePermission)) return false;
  const moduleGate: Partial<Record<WorkspacePermission, [WorkspaceModule, WorkspaceModuleAction]>> = {
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
  const gate = moduleGate[permission as WorkspacePermission];
  return gate ? hasModulePermission(user, workspaceId, ...gate) : true;
}

const platformPermissionSet: Record<PlatformPermission, true> = {
  CREATE_WORKSPACE: true,
  DELETE_WORKSPACE: true,
  VIEW_WORKSPACES: true,
  VIEW_USERS: true,
  MANAGE_SUBSCRIPTIONS: true,
  MANAGE_BILLING: true,
  MANAGE_PLATFORM_SETTINGS: true,
  VIEW_AUDIT_LOGS: true,
  VIEW_SYSTEM_HEALTH: true,
};
