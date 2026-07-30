export const workspaceBootstrapQueryKey = (workspaceId?: string | null) =>
  ["workspace-bootstrap", workspaceId ?? "none"] as const;
