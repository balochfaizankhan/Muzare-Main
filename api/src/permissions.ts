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
  | "MANAGE_RECORDS"
  | "SUBMIT_RECORDS"
  | "VIEW_REPORTS";

export type Permission = PlatformPermission | WorkspacePermission;

export type PermissionUser = {
  platformRole: PlatformRole | null;
  memberships: Array<{ workspaceId: string; role: WorkspaceRole; active: boolean }>;
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
    "MANAGE_RECORDS", "MANAGE_FARMS", "MANAGE_SEASONS", "MANAGE_EXPENSE_CATEGORIES", "SUBMIT_RECORDS", "VIEW_REPORTS",
  ],
  workspace_manager: [
    "APPROVE_EXPENSE", "APPROVE_ATTENDANCE", "APPROVE_SALE", "APPROVE_DISPATCH", "MANAGE_TEAM",
    "MANAGE_RECORDS", "MANAGE_FARMS", "MANAGE_SEASONS", "SUBMIT_RECORDS", "VIEW_REPORTS",
  ],
  supervisor: ["APPROVE_EXPENSE", "APPROVE_ATTENDANCE", "APPROVE_SALE", "APPROVE_DISPATCH", "MANAGE_RECORDS", "SUBMIT_RECORDS", "VIEW_REPORTS"],
  operator: ["SUBMIT_RECORDS"],
  viewer: ["VIEW_REPORTS"],
};

export function hasPermission(user: PermissionUser, permission: Permission, workspaceId?: string): boolean {
  if (permission in platformPermissionSet) {
    return user.platformRole ? platformPermissions[user.platformRole].includes(permission as PlatformPermission) : false;
  }
  if (!workspaceId) return false;
  const membership = user.memberships.find((item) => item.active && item.workspaceId === workspaceId);
  return membership ? workspacePermissions[membership.role].includes(permission as WorkspacePermission) : false;
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
