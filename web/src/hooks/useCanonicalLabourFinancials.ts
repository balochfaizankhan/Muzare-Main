import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthProvider";
import { useSyncState } from "./useSyncState";
import { fetchLabourFinancialReadModel } from "../lib/api";
import { registerExternalAccountIdentities } from "../lib/accountIdentity";
import { createRefreshDebouncer } from "../lib/eventCoalescing";
import { reconcilePartnerAdvanceAttribution } from "../lib/labourPartnerAdvanceAttribution";

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
      const financials = reconcilePartnerAdvanceAttribution(response.financials);
      const scope = financials.scope;
      if (scope.workspaceId !== workspaceId || scope.farmId !== farmId || scope.seasonId !== seasonId) {
        throw new Error("The financial snapshot belongs to a different workspace, farm, or season.");
      }
      registerExternalAccountIdentities([
        ...financials.partnerPositions.map((position) => ({
          accountId: position.accountId,
          accountName: position.accountName,
        })),
        ...financials.expenseAccountAttributions.map((attribution) => ({
          accountId: attribution.accountId,
          accountName: attribution.accountName,
        })),
      ]);
      return { ...response, financials };
    },
    enabled: Boolean(token && workspaceId && farmId && seasonId && navigator.onLine),
    placeholderData: undefined,
    retry: (failureCount) => navigator.onLine && failureCount < 2,
    retryDelay: (attemptIndex) => Math.min(1_000 * 2 ** attemptIndex, 4_000),
    refetchOnMount: "always",
    refetchOnReconnect: true,
  });
  const debouncerRef = useRef<ReturnType<typeof createRefreshDebouncer> | null>(null);
  useEffect(() => {
    const debouncer = createRefreshDebouncer(() => {
      void queryClient.invalidateQueries({ queryKey: ["canonical-labour-financials", token, workspaceId, farmId, seasonId], exact: true });
    });
    debouncerRef.current = debouncer;
    window.addEventListener("muzare-data-refresh", debouncer.trigger);
    window.addEventListener("muzare-local-data-change", debouncer.trigger);
    return () => {
      window.removeEventListener("muzare-data-refresh", debouncer.trigger);
      window.removeEventListener("muzare-local-data-change", debouncer.trigger);
      debouncer.cancel();
    };
  }, [farmId, queryClient, seasonId, token, workspaceId]);
  return { ...query, data: query.data?.financials, workspaceId, farmId, seasonId };
}
