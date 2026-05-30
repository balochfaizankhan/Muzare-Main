import type { AppUser, Permission } from "./api";

const platformPermissions = new Set<Permission>([
  "CREATE_WORKSPACE", "DELETE_WORKSPACE", "VIEW_WORKSPACES", "VIEW_USERS", "MANAGE_SUBSCRIPTIONS",
  "MANAGE_BILLING", "MANAGE_PLATFORM_SETTINGS", "VIEW_AUDIT_LOGS", "VIEW_SYSTEM_HEALTH",
]);

const permissionsByRole: Record<AppUser["role"], readonly Permission[]> = {
  platform_admin: [...platformPermissions],
  platform_support: ["VIEW_WORKSPACES", "VIEW_USERS", "VIEW_AUDIT_LOGS", "VIEW_SYSTEM_HEALTH"],
  workspace_owner: ["APPROVE_EXPENSE", "APPROVE_ATTENDANCE", "APPROVE_SALE", "APPROVE_DISPATCH", "MANAGE_TEAM", "MANAGE_FARMS", "MANAGE_SEASONS", "MANAGE_RECORDS", "SUBMIT_RECORDS", "VIEW_REPORTS"],
  workspace_manager: ["APPROVE_EXPENSE", "APPROVE_ATTENDANCE", "APPROVE_SALE", "APPROVE_DISPATCH", "MANAGE_TEAM", "MANAGE_FARMS", "MANAGE_SEASONS", "MANAGE_RECORDS", "SUBMIT_RECORDS", "VIEW_REPORTS"],
  supervisor: ["APPROVE_EXPENSE", "APPROVE_ATTENDANCE", "APPROVE_SALE", "APPROVE_DISPATCH", "MANAGE_RECORDS", "SUBMIT_RECORDS", "VIEW_REPORTS"],
  operator: ["SUBMIT_RECORDS"],
  viewer: ["VIEW_REPORTS"],
};

export function hasPermission(user: AppUser, permission: Permission, workspaceId?: string): boolean {
  if (platformPermissions.has(permission)) return Boolean(user.platformRole && permissionsByRole[user.platformRole].includes(permission));
  if (!workspaceId) return false;
  const membership = user.memberships.find((item) => item.active && item.workspaceId === workspaceId);
  return Boolean(membership && permissionsByRole[membership.role].includes(permission));
}

export const isPlatformUser = (user: AppUser) => Boolean(user.platformRole);
export const getHomePath = (user: AppUser) => isPlatformUser(user) ? "/admin/dashboard" : "/workspace/dashboard";
