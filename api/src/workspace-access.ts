import type { AuthenticatedUser, WorkspaceMembership } from "./auth.js";

export type FarmAccessMode = "all" | "assigned";

export type AuthorizedWorkspaceMembership = WorkspaceMembership & {
  farmAccessMode: FarmAccessMode;
  farmIds: string[];
};

export function workspaceMembershipFor(
  user: Pick<AuthenticatedUser, "memberships"> | null | undefined,
  workspaceId: string,
): AuthorizedWorkspaceMembership | null {
  if (!user) return null;
  const membership = user.memberships.find((item) => item.active && item.workspaceId === workspaceId) ?? null;
  if (!membership) return null;
  return {
    ...membership,
    farmAccessMode: membership.farmAccessMode === "assigned" ? "assigned" : "all",
    farmIds: membership.farmIds ?? [],
  };
}

export function allowedFarmIdsForWorkspace(
  user: Pick<AuthenticatedUser, "memberships"> | null | undefined,
  workspaceId: string,
): string[] | null {
  const membership = workspaceMembershipFor(user, workspaceId);
  if (!membership) return [];
  return membership.farmAccessMode === "assigned" ? membership.farmIds : null;
}

export function hasFarmAccess(
  user: Pick<AuthenticatedUser, "memberships"> | null | undefined,
  workspaceId: string,
  farmId: string | null | undefined,
): boolean {
  const membership = workspaceMembershipFor(user, workspaceId);
  if (!membership) return false;
  if (!farmId) return true;
  return membership.farmAccessMode === "all" || membership.farmIds.includes(farmId);
}
