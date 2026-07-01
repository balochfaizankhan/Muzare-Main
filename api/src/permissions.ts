export const platformRoles = ["platform_admin", "platform_support"] as const;
export const workspaceRoles = ["workspace_owner", "workspace_manager", "supervisor", "accountant", "operator", "viewer"] as const;

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
export const workspaceModules = ["dashboard", "workforce", "attendance", "advances", "wages", "expenses", "sales", "dispatch", "inventory", "accounts", "reports", "settings", "team"] as const;
export const workspaceModuleActions = ["view", "create", "edit", "delete", "approve", "export"] as const;
export type WorkspaceModule = (typeof workspaceModules)[number];
export type WorkspaceModuleAction = (typeof workspaceModuleActions)[number];
export type WorkspaceModulePermissions = Partial<Record<WorkspaceModule, Partial<Record<WorkspaceModuleAction, boolean>>>>;

export type PermissionUser = {
  platformRole: PlatformRole | null;
  memberships: Array<{ workspaceId: string; role: WorkspaceRole; active: boolean; permissions?: WorkspaceModulePermissions | null }>;
};

export type EffectiveWorkspacePermissions = {
  workspaceId: string;
  role: WorkspaceRole;
  permissions: Record<WorkspaceModule, Record<WorkspaceModuleAction, boolean>>;
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
  return workspaceRoles.includes((role ?? "") as WorkspaceRole) ? role as WorkspaceRole : "viewer";
}

function selectWorkspaceMembership(user: PermissionUser, workspaceId: string) {
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
  accountant: ["MANAGE_RECORDS", "SUBMIT_RECORDS", "VIEW_REPORTS"],
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
    advances: { ...viewCreateEdit }, wages: { ...viewCreateEdit, export: true }, expenses: { ...viewCreateEdit }, sales: { ...viewCreateEdit }, dispatch: { ...viewCreateEdit },
    inventory: { ...viewCreateEdit }, accounts: { ...viewOnly }, reports: { ...viewOnly, export: true },
    settings: { ...viewOnly }, team: { ...viewOnly },
  },
  supervisor: {
    dashboard: { ...viewOnly }, workforce: { ...viewOnly }, attendance: { ...viewCreateEdit }, advances: { ...viewCreateEdit }, wages: { ...viewOnly, export: true },
    expenses: { ...viewCreateEdit }, sales: { ...viewCreateEdit }, dispatch: { ...viewCreateEdit }, inventory: { ...viewCreateEdit },
    accounts: { ...viewOnly }, reports: { ...viewOnly }, settings: { ...viewOnly }, team: { ...viewOnly },
  },
  accountant: {
    dashboard: { ...viewOnly },
    workforce: { ...viewOnly },
    attendance: { ...viewOnly },
    wages: { ...viewCreateEdit, export: true },
    advances: { ...viewCreateEdit, export: true },
    expenses: { ...viewCreateEdit, export: true },
    sales: { ...viewOnly },
    dispatch: { ...viewOnly },
    inventory: { ...viewOnly },
    accounts: { ...viewCreateEdit, export: true },
    reports: { ...viewOnly, export: true },
    settings: { ...viewOnly, view: false },
    team: { ...viewOnly, view: false },
  },
  operator: {
    dashboard: { ...viewOnly }, workforce: { ...viewOnly }, attendance: { ...viewCreate }, advances: { ...viewCreate }, wages: { ...viewOnly },
    expenses: { ...viewCreate }, sales: { ...viewCreate }, dispatch: { ...viewCreate }, inventory: { ...viewCreate },
    accounts: { ...viewOnly, view: false }, reports: { ...viewOnly, view: false }, settings: { ...viewOnly, view: false }, team: { ...viewOnly, view: false },
  },
  viewer: Object.fromEntries(workspaceModules.map((module) => [module, { ...viewOnly }])) as Record<WorkspaceModule, Record<WorkspaceModuleAction, boolean>>,
};

export function hasModulePermission(user: PermissionUser, workspaceId: string, module: WorkspaceModule, action: WorkspaceModuleAction): boolean {
  const membership = selectWorkspaceMembership(user, workspaceId);
  if (!membership) return false;
  if (membership.role === "workspace_owner") return true;
  return membership.permissions?.[module]?.[action] ?? roleModulePermissions[membership.role][module][action];
}

export function getEffectivePermissions(user: PermissionUser, workspaceId: string): EffectiveWorkspacePermissions | null {
  const membership = selectWorkspaceMembership(user, workspaceId);
  if (!membership) return null;
  const permissions = Object.fromEntries(
    workspaceModules.map((module) => [
      module,
      Object.fromEntries(
        workspaceModuleActions.map((action) => [
          action,
          membership.role === "workspace_owner"
            ? true
            : membership.permissions?.[module]?.[action] ?? roleModulePermissions[membership.role][module][action],
        ]),
      ) as Record<WorkspaceModuleAction, boolean>,
    ]),
  ) as Record<WorkspaceModule, Record<WorkspaceModuleAction, boolean>>;
  return {
    workspaceId,
    role: membership.role,
    permissions,
  };
}

export function requireWorkspacePermission(user: PermissionUser, workspaceId: string, permission: Permission): boolean {
  return hasPermission(user, permission, workspaceId);
}

export function requireOwnerOrPermission(
  user: PermissionUser,
  workspaceId: string,
  permission: Permission,
): boolean {
  const membership = selectWorkspaceMembership(user, workspaceId);
  if (!membership) return false;
  return membership.role === "workspace_owner" || hasPermission(user, permission, workspaceId);
}

export function hasPermission(user: PermissionUser, permission: Permission, workspaceId?: string): boolean {
  if (permission in platformPermissionSet) {
    return user.platformRole ? platformPermissions[user.platformRole].includes(permission as PlatformPermission) : false;
  }
  if (!workspaceId) return false;
  const membership = selectWorkspaceMembership(user, workspaceId);
  if (!membership) return false;
  if (membership.role === "workspace_owner") return true;
  if (!workspacePermissions[membership.role].includes(permission as WorkspacePermission)) return false;
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
