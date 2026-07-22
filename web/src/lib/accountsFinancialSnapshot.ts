export type AccountsFinancialScope = {
  workspaceId: string;
  farmId: string;
  seasonId: string;
};

export type AccountsFinancialSnapshot = AccountsFinancialScope & {
  snapshotVersion: string;
  generatedAt: string;
};

export function isAccountsFinancialScope(
  snapshot: AccountsFinancialSnapshot | null | undefined,
  scope: AccountsFinancialScope,
) {
  return Boolean(
    snapshot
    && snapshot.workspaceId === scope.workspaceId
    && snapshot.farmId === scope.farmId
    && snapshot.seasonId === scope.seasonId,
  );
}

export function settleAccountsFinancialSnapshot<T extends AccountsFinancialSnapshot>(input: {
  scope: AccountsFinancialScope;
  previousSnapshot: T | null;
  canonicalReady: boolean;
  nextSnapshot: T;
}) {
  if (!input.canonicalReady) {
    return isAccountsFinancialScope(input.previousSnapshot, input.scope)
      ? input.previousSnapshot
      : null;
  }
  return input.nextSnapshot;
}
