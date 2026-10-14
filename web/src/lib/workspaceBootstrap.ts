import { queryOptions } from "@tanstack/react-query";
import { fetchBootstrap, type BootstrapData } from "./api";

const bootstrapCachePrefix = "muzare-workspace-bootstrap-v1:";

type CachedBootstrap = {
  workspaceId: string;
  cachedAt: string;
  data: BootstrapData;
};

const bootstrapCacheKey = (workspaceId: string) => `${bootstrapCachePrefix}${workspaceId}`;

export const workspaceBootstrapQueryKey = (workspaceId?: string | null) =>
  ["workspace-bootstrap", workspaceId ?? "none"] as const;

export function readCachedWorkspaceBootstrap(workspaceId?: string | null): BootstrapData | undefined {
  if (!workspaceId || typeof window === "undefined") return undefined;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(bootstrapCacheKey(workspaceId)) ?? "null") as CachedBootstrap | null;
    if (!parsed || parsed.workspaceId !== workspaceId || !parsed.data) return undefined;
    const dataWorkspaceId = parsed.data.activeWorkspaceId ?? parsed.data.user?.workspaceId ?? null;
    if (dataWorkspaceId && dataWorkspaceId !== workspaceId) return undefined;
    return parsed.data;
  } catch {
    window.localStorage.removeItem(bootstrapCacheKey(workspaceId));
    return undefined;
  }
}

export function writeCachedWorkspaceBootstrap(workspaceId: string, data: BootstrapData): void {
  if (!workspaceId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(bootstrapCacheKey(workspaceId), JSON.stringify({
      workspaceId,
      cachedAt: new Date().toISOString(),
      data,
    } satisfies CachedBootstrap));
  } catch {
    // Bootstrap cache is a performance optimization only. Network data remains authoritative.
  }
}

export function workspaceBootstrapQueryOptions(token?: string | null, workspaceId?: string | null) {
  const resolvedWorkspaceId = workspaceId ?? "";
  return queryOptions({
    queryKey: workspaceBootstrapQueryKey(resolvedWorkspaceId),
    queryFn: async ({ signal }) => {
      const data = await fetchBootstrap(token!, signal);
      writeCachedWorkspaceBootstrap(resolvedWorkspaceId, data);
      return data;
    },
    enabled: Boolean(token && resolvedWorkspaceId),
    initialData: () => readCachedWorkspaceBootstrap(resolvedWorkspaceId),
    staleTime: 30_000,
    retry: false,
  });
}
