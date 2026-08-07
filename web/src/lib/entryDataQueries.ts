import { queryOptions } from "@tanstack/react-query";
import {
  ensureLocalAccounts,
  getActiveFarmId,
  getActiveSeasonId,
  getActiveWorkspaceId,
  offlineDb,
  workspaceConfigRecords,
  workspaceRecords,
} from "./offline-db";
import { queryClient } from "./query-client";

const ENTRY_STALE_TIME = 2 * 60_000;
const ENTRY_GC_TIME = 15 * 60_000;

export type EntryScope = {
  workspaceId: string;
  farmId: string;
  seasonId: string;
};

export function currentEntryScope(): EntryScope {
  return {
    workspaceId: getActiveWorkspaceId() ?? "none",
    farmId: getActiveFarmId() ?? "none",
    seasonId: getActiveSeasonId() ?? "none",
  };
}

const scopeKey = (scope: EntryScope) => [scope.workspaceId, scope.farmId, scope.seasonId] as const;

export const entryQueryKeys = {
  all: ["entry-data"] as const,
  expenses: (scope = currentEntryScope()) => ["entry-data", "expenses", ...scopeKey(scope)] as const,
  sales: (scope = currentEntryScope()) => ["entry-data", "sales", ...scopeKey(scope)] as const,
  dispatch: (scope = currentEntryScope()) => ["entry-data", "dispatch", ...scopeKey(scope)] as const,
};

export function expenseEntryQueryOptions(scope = currentEntryScope()) {
  return queryOptions({
    queryKey: entryQueryKeys.expenses(scope),
    queryFn: async () => {
      await ensureLocalAccounts();
      return {
        accounts: await workspaceRecords(offlineDb.accounts, { includeImportedAcrossSeasons: true }),
      };
    },
    staleTime: ENTRY_STALE_TIME,
    gcTime: ENTRY_GC_TIME,
    retry: false,
  });
}

export function salesEntryQueryOptions(scope = currentEntryScope()) {
  return queryOptions({
    queryKey: entryQueryKeys.sales(scope),
    queryFn: async () => {
      const [dispatches, sales, vehicles, dateTypes] = await Promise.all([
        workspaceRecords(offlineDb.dispatches),
        workspaceRecords(offlineDb.sales),
        workspaceRecords(offlineDb.vehicles),
        workspaceConfigRecords(offlineDb.dateTypes),
      ]);
      return { dispatches, sales, vehicles, dateTypes };
    },
    staleTime: ENTRY_STALE_TIME,
    gcTime: ENTRY_GC_TIME,
    retry: false,
  });
}

export function dispatchEntryQueryOptions(scope = currentEntryScope()) {
  return queryOptions({
    queryKey: entryQueryKeys.dispatch(scope),
    queryFn: async () => {
      const [vehicles, dateTypes] = await Promise.all([
        workspaceRecords(offlineDb.vehicles),
        workspaceConfigRecords(offlineDb.dateTypes),
      ]);
      return { vehicles, dateTypes };
    },
    staleTime: ENTRY_STALE_TIME,
    gcTime: ENTRY_GC_TIME,
    retry: false,
  });
}

export const ensureExpenseEntryData = () => queryClient.ensureQueryData({
  ...expenseEntryQueryOptions(),
  revalidateIfStale: true,
});

export const ensureSalesEntryData = () => queryClient.ensureQueryData({
  ...salesEntryQueryOptions(),
  revalidateIfStale: true,
});

export const ensureDispatchEntryData = () => queryClient.ensureQueryData({
  ...dispatchEntryQueryOptions(),
  revalidateIfStale: true,
});

export function invalidateEntryData(kind?: "expenses" | "sales" | "dispatch") {
  return queryClient.invalidateQueries({
    queryKey: kind ? ["entry-data", kind] : entryQueryKeys.all,
    refetchType: "active",
  });
}
