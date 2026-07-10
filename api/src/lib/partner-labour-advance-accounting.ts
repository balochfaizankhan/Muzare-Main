import { buildAccountIdentityLookup, resolveCanonicalAccountId, type AccountIdentityLike, type AccountIdentityLookup } from "./account-identity.js";

export type LabourAdvanceAccountingSnapshot = {
  totalLabourAdvancesPaid: number;
  settledAdvances: number;
  outstandingAdvances: number;
  reconciliationDifference: number;
  isConsistent: boolean;
  labourSettlementCashPaid: number;
  labourSettlementNonCashApplied: number;
  settlementCount: number;
};

type AdvanceLike = {
  amount: number;
  accountId?: string | null;
  resolvedAccountId?: string | null;
  farmId?: string | null;
  seasonId?: string | null;
  deleted?: boolean;
  deletedAt?: string | null;
  voidedAt?: string | null;
  reversedAt?: string | null;
  status?: string | null;
  accountingStatus?: string | null;
};

type SettlementLike = {
  linkedAccountId?: string | null;
  paymentAccountId?: string | null;
  accountId?: string | null;
  partnerAccountId?: string | null;
  resolvedAccountId?: string | null;
  advancesApplied?: number;
  appliedAdvances?: number;
  settledAdvanceAmount?: number;
  cashPaid?: number;
  paidAmount?: number;
  farmId?: string | null;
  seasonId?: string | null;
  status?: string | null;
  accountingStatus?: string | null;
  deletedAt?: string | null;
  voidedAt?: string | null;
  reversedAt?: string | null;
  deleted?: boolean;
};

function normalizeNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeAccountId(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isActiveRow(row: { status?: string | null; accountingStatus?: string | null; deleted?: boolean; deletedAt?: string | null; voidedAt?: string | null; reversedAt?: string | null }) {
  const status = typeof row.status === "string" ? row.status.trim().toLowerCase() : "";
  const accountingStatus = typeof row.accountingStatus === "string" ? row.accountingStatus.trim().toLowerCase() : "";
  return row.deleted !== true
    && !row.deletedAt
    && !row.voidedAt
    && !row.reversedAt
    && status !== "voided"
    && status !== "deleted"
    && status !== "reversed"
    && status !== "cancelled"
    && accountingStatus !== "voided"
    && accountingStatus !== "deleted";
}

function resolveSettlementAccountId(settlement: SettlementLike) {
  return normalizeAccountId(settlement.linkedAccountId)
    ?? normalizeAccountId(settlement.paymentAccountId)
    ?? normalizeAccountId(settlement.accountId)
    ?? normalizeAccountId(settlement.partnerAccountId)
    ?? normalizeAccountId(settlement.resolvedAccountId);
}

function settlementAdvanceOffset(settlement: SettlementLike) {
  return normalizeNumber(settlement.advancesApplied ?? settlement.appliedAdvances ?? settlement.settledAdvanceAmount);
}

function settlementCashPaid(settlement: SettlementLike) {
  return normalizeNumber(settlement.cashPaid ?? settlement.paidAmount);
}

export function calculateLabourAdvanceAccountingSnapshot(args: {
  selectedAccountId: string;
  advances: AdvanceLike[];
  settlements: SettlementLike[];
  accounts?: AccountIdentityLike[] | AccountIdentityLookup;
  farmId?: string | null;
  seasonId?: string | null;
}): LabourAdvanceAccountingSnapshot {
  const accountLookup = Array.isArray(args.accounts) ? buildAccountIdentityLookup(args.accounts) : (args.accounts ?? buildAccountIdentityLookup([]));
  const farmMatches = (rowFarmId: string | null) => !args.farmId || rowFarmId === args.farmId || rowFarmId === null;
  const seasonMatches = (rowSeasonId: string | null) => !args.seasonId || rowSeasonId === args.seasonId || rowSeasonId === null;
  const matchesSelectedAccount = (value: string | null | undefined) => {
    const normalizedValue = normalizeAccountId(value);
    if (!normalizedValue) return false;
    return resolveCanonicalAccountId(normalizedValue, accountLookup) === args.selectedAccountId
      || normalizedValue === args.selectedAccountId;
  };

  const totalLabourAdvancesPaid = args.advances
    .filter((advance) => isActiveRow(advance))
    .filter((advance) => matchesSelectedAccount(advance.resolvedAccountId ?? advance.accountId))
    .filter((advance) => farmMatches(advance.farmId ?? null) && seasonMatches(advance.seasonId ?? null))
    .reduce((sum, advance) => sum + normalizeNumber(advance.amount), 0);

  const activeSettlements = args.settlements
    .filter((settlement) => isActiveRow(settlement))
    .filter((settlement) => matchesSelectedAccount(resolveSettlementAccountId(settlement)))
    .filter((settlement) => farmMatches(settlement.farmId ?? null) && seasonMatches(settlement.seasonId ?? null));

  const settledAdvances = activeSettlements.reduce((sum, settlement) => sum + settlementAdvanceOffset(settlement), 0);
  const labourSettlementCashPaid = activeSettlements.reduce((sum, settlement) => sum + settlementCashPaid(settlement), 0);
  const labourSettlementNonCashApplied = settledAdvances;
  const outstandingAdvances = Math.max(totalLabourAdvancesPaid - settledAdvances, 0);
  const reconciliationDifference = totalLabourAdvancesPaid - (settledAdvances + outstandingAdvances);

  return {
    totalLabourAdvancesPaid,
    settledAdvances,
    outstandingAdvances,
    reconciliationDifference,
    isConsistent: Math.abs(reconciliationDifference) <= 0.009,
    labourSettlementCashPaid,
    labourSettlementNonCashApplied,
    settlementCount: activeSettlements.length,
  };
}
