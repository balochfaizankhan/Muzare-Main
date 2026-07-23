export type DashboardFinancialScope = {
  workspaceId: string;
  farmId: string;
  seasonId: string;
};

export type DashboardFinancialSnapshot = DashboardFinancialScope & {
  snapshotVersion: string;
  generatedAt: string;
  cashBalance: number;
  totalExpenses: number;
  outstandingLabourAdvances: number;
  outstandingLabourPayments: number;
  outstandingLabourPaymentsCount: number;
  overdueLabourPaymentsCount: number;
};

export type DashboardFinancialInputs = {
  cashBalance: number;
  totalExpenses: number;
  outstandingLabourAdvances: number;
  outstandingLabourPayments: number;
  outstandingLabourPaymentsCount: number;
  overdueLabourPaymentsCount: number;
  inputVersion: string;
};

export function dashboardFinancialSnapshotStorageKey(scope: DashboardFinancialScope) {
  // v4: added outstandingLabourPayments/outstandingLabourPaymentsCount/overdueLabourPaymentsCount.
  // Bumping the key means an older v3 snapshot is simply treated as a cache miss rather than
  // being loaded with those fields undefined.
  return `muzare:dashboard-financial-snapshot:v4:${scope.workspaceId}:${scope.farmId}:${scope.seasonId}`;
}

export function isDashboardFinancialScope(
  snapshot: DashboardFinancialSnapshot | null | undefined,
  scope: DashboardFinancialScope,
) {
  return Boolean(
    snapshot
    && snapshot.workspaceId === scope.workspaceId
    && snapshot.farmId === scope.farmId
    && snapshot.seasonId === scope.seasonId,
  );
}

export function settleDashboardFinancialSnapshot(input: {
  scope: DashboardFinancialScope;
  previousSnapshot: DashboardFinancialSnapshot | null;
  canonicalReady: boolean;
  generatedAt: string;
  canonicalVersion: string;
  financials: DashboardFinancialInputs;
}) {
  if (!input.canonicalReady) {
    return isDashboardFinancialScope(input.previousSnapshot, input.scope)
      ? input.previousSnapshot
      : null;
  }
  return {
    ...input.scope,
    snapshotVersion: `${input.scope.workspaceId}:${input.scope.farmId}:${input.scope.seasonId}:${input.canonicalVersion}:${input.financials.inputVersion}`,
    generatedAt: input.generatedAt,
    cashBalance: input.financials.cashBalance,
    totalExpenses: input.financials.totalExpenses,
    outstandingLabourAdvances: input.financials.outstandingLabourAdvances,
    outstandingLabourPayments: input.financials.outstandingLabourPayments,
    outstandingLabourPaymentsCount: input.financials.outstandingLabourPaymentsCount,
    overdueLabourPaymentsCount: input.financials.overdueLabourPaymentsCount,
  } satisfies DashboardFinancialSnapshot;
}
