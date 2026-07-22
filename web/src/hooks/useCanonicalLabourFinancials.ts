import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthProvider";
import { useSyncState } from "./useSyncState";
import { fetchLabourFinancialReadModel } from "../lib/api";

/** One scoped canonical source for labour account, partner, ledger, expense and activity consumers. */
export function useCanonicalLabourFinancials() {
  const { token, user } = useAuth();
  const sync = useSyncState();
  const queryClient = useQueryClient();
  const workspaceId = user?.workspaceId ?? "";
  const farmId = sync.farmId ?? "";
  const seasonId = sync.seasonId ?? "";
  const query = useQuery({
    queryKey: ["canonical-labour-financials", token, workspaceId, farmId, seasonId],
    queryFn: async ({ signal }) => {
      const response = await fetchLabourFinancialReadModel(token!, workspaceId, farmId, seasonId, signal);
      const scope = response.financials.scope;
      if (scope.workspaceId !== workspaceId || scope.farmId !== farmId || scope.seasonId !== seasonId) {
        throw new Error("The financial snapshot belongs to a different workspace, farm, or season.");
      }
      return response;
    },
    enabled: Boolean(token && workspaceId && farmId && seasonId && navigator.onLine),
    placeholderData: undefined,
  });
  useEffect(() => {
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ["canonical-labour-financials", token, workspaceId, farmId, seasonId], exact: true });
    };
    window.addEventListener("muzare-data-refresh", refresh);
    window.addEventListener("muzare-local-data-change", refresh);
    return () => {
      window.removeEventListener("muzare-data-refresh", refresh);
      window.removeEventListener("muzare-local-data-change", refresh);
    };
  }, [farmId, queryClient, seasonId, token, workspaceId]);
  return { ...query, data: query.data?.financials, workspaceId, farmId, seasonId };
}
