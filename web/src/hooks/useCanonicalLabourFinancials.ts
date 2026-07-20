import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthProvider";
import { useSyncState } from "./useSyncState";
import { fetchLabourFinancialReadModel } from "../lib/api";

/** One scoped canonical source for labour account, partner, ledger, expense and activity consumers. */
export function useCanonicalLabourFinancials() {
  const { token, user } = useAuth();
  const sync = useSyncState();
  const workspaceId = user?.workspaceId ?? "";
  const farmId = sync.farmId ?? "";
  const seasonId = sync.seasonId ?? "";
  const query = useQuery({
    queryKey: ["canonical-labour-financials", token, workspaceId, farmId, seasonId],
    queryFn: ({ signal }) => fetchLabourFinancialReadModel(token!, workspaceId, farmId, seasonId, signal),
    enabled: Boolean(token && workspaceId && farmId && seasonId && navigator.onLine),
    placeholderData: undefined,
  });
  return { ...query, data: query.data?.financials, workspaceId, farmId, seasonId };
}
