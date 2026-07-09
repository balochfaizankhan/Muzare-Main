import type { Advance, LabourWageSettlement, Voucher } from "./offline-db";
import { isActiveOperationalRecord } from "./operationalRecords";
import { buildAccountIdentityLookup, resolveAccountIdentity, resolveCanonicalAccountId, type AccountIdentityLike, type AccountIdentityLookup, type AccountIdentityResolution } from "./accountIdentity";

export type SettlementVoucherLike = {
  deletedAt?: string | null;
  settlementId?: unknown;
  voucherPurpose?: unknown;
  nonCashSettlement?: unknown;
  deleted?: unknown;
  status?: unknown;
};

export type SettlementAccountLike = {
  linkedAccountId?: unknown;
  paymentAccountId?: unknown;
  accountId?: unknown;
  partnerAccountId?: unknown;
  resolvedAccountId?: unknown;
  status?: unknown;
  accountingStatus?: unknown;
  deletedAt?: unknown;
};

export type SettlementAccountResolution = AccountIdentityResolution & {
  sourceField: string | null;
  rawValue: string | null;
};

export type LabourSettlementAccountingDiagnostics = {
  accountId: string;
  totalAdvanceRows: number;
  advanceRowsMatchedByCanonicalId: number;
  advanceRowsMatchedByAlias: number;
  advanceRowsMatchedByNameFallback: number;
  advanceRowsUnmatchedNonDeleted: number;
  settlementRowsIncluded: number;
  settlementRowsExcluded: number;
  settlementRowsMatchedByCanonicalId: number;
  settlementRowsMatchedByAlias: number;
  settlementRowsMatchedByNameFallback: number;
  settlementRowsUnmatchedNonDeleted: number;
  needsAccountMappingRepair: boolean;
};

type AccountingScopeOptions = {
  farmId?: string | null;
  seasonId?: string | null;
};

function accountIdFromSettlementField(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function resolveLabourWageSettlementAccountId(settlement: SettlementAccountLike | null | undefined) {
  if (!settlement) return null;
  return accountIdFromSettlementField(settlement.linkedAccountId)
    ?? accountIdFromSettlementField(settlement.paymentAccountId)
    ?? accountIdFromSettlementField(settlement.accountId)
    ?? accountIdFromSettlementField(settlement.partnerAccountId)
    ?? accountIdFromSettlementField(settlement.resolvedAccountId);
}

export function resolveLabourWageSettlementAccountIdentity(
  settlement: SettlementAccountLike | null | undefined,
  accounts: AccountIdentityLike[] | AccountIdentityLookup,
): SettlementAccountResolution {
  const lookup = Array.isArray(accounts) ? buildAccountIdentityLookup(accounts) : accounts;
  const fields: Array<[string, unknown]> = settlement ? [
    ["linkedAccountId", settlement.linkedAccountId],
    ["paymentAccountId", settlement.paymentAccountId],
    ["accountId", settlement.accountId],
    ["partnerAccountId", settlement.partnerAccountId],
    ["resolvedAccountId", settlement.resolvedAccountId],
  ] : [];
  for (const [sourceField, value] of fields) {
    const rawValue = accountIdFromSettlementField(value);
    if (!rawValue) continue;
    const resolved = resolveAccountIdentity(rawValue, lookup);
    if (resolved.canonicalAccountId) {
      return { ...resolved, sourceField, rawValue };
    }
  }
  return {
    canonicalAccountId: null,
    matchedBy: "unmatched",
    matchedAccount: null,
    needsAccountMappingRepair: Boolean(settlement && fields.some(([, value]) => accountIdFromSettlementField(value))),
    sourceField: null,
    rawValue: null,
  };
}

export function isPostedLabourWageSettlement(settlement: LabourWageSettlement | null | undefined) {
  return Boolean(settlement
    && isActiveOperationalRecord(settlement)
    && settlement.status === "posted"
    && settlement.accountingStatus !== "accounting_missing");
}

export function isActiveSettlementForPartnerAccounting(settlement: LabourWageSettlement | null | undefined) {
  return Boolean(settlement
    && isActiveOperationalRecord(settlement)
    && settlement.status === "posted"
    && settlement.accountingStatus !== "accounting_missing");
}

export function getActiveLabourWageSettlements(settlements: LabourWageSettlement[]) {
  return settlements.filter(isPostedLabourWageSettlement);
}

export function getLabourWageSettlementLedgerAmount(settlement: SettlementAccountLike & { grossWages?: number; expenseAmount?: number; totalEarned?: number }) {
  return Number(settlement.grossWages ?? settlement.expenseAmount ?? settlement.totalEarned ?? 0);
}

export function getLabourWageSettlementAdvanceOffset(settlement: SettlementAccountLike & { advanceAdjustedNow?: number; advancesApplied?: number; appliedAdvances?: number; settledAdvanceAmount?: number }) {
  return Number(settlement.advanceAdjustedNow ?? settlement.advancesApplied ?? settlement.appliedAdvances ?? settlement.settledAdvanceAmount ?? 0);
}

export function getLabourWageSettlementCashPaidAmount(settlement: SettlementAccountLike & { paidAmount?: number; balanceAfterPayment?: number; payableBalance?: number; cashPayable?: number; cashPaid?: number }) {
  return Number(settlement.paidAmount ?? settlement.cashPaid ?? settlement.cashPayable ?? settlement.payableBalance ?? 0);
}

export function getLabourWageSettlementNonCashAppliedAmount(settlement: SettlementAccountLike & { advanceAdjustedNow?: number; advancesApplied?: number; appliedAdvances?: number; settledAdvanceAmount?: number }) {
  return Number(settlement.advanceAdjustedNow ?? settlement.advancesApplied ?? settlement.appliedAdvances ?? settlement.settledAdvanceAmount ?? 0);
}

export function getLabourWageSettlementRemainingAdvanceCarryForward(settlement: SettlementAccountLike & { remainingAdvanceCarryForward?: number; carryForwardAdvance?: number }) {
  return Number(settlement.remainingAdvanceCarryForward ?? settlement.carryForwardAdvance ?? 0);
}

export function getLabourSettlementAccountingSnapshot(
  advances: Advance[],
  settlements: LabourWageSettlement[],
  accountId: string,
  accounts: AccountIdentityLike[] = [],
  options: AccountingScopeOptions = {},
) {
  const accountLookup = buildAccountIdentityLookup(accounts);
  const farmId = options.farmId ?? null;
  const seasonId = options.seasonId ?? null;
  const farmMatches = (rowFarmId: string | null) => !farmId || rowFarmId === farmId || rowFarmId === null;
  const seasonMatches = (rowSeasonId: string | null) => !seasonId || rowSeasonId === seasonId || rowSeasonId === null;
  const activeSettlements = settlements.filter((settlement) =>
    isActiveSettlementForPartnerAccounting(settlement)
    && resolveCanonicalAccountId(resolveLabourWageSettlementAccountId(settlement), accountLookup) === accountId,
  ).filter((settlement) => farmMatches((settlement as LabourWageSettlement).farmId ?? null) && seasonMatches((settlement as LabourWageSettlement).seasonId ?? null));
  const advanceDiagnostics = advances.map((advance) => {
    const resolved = resolveAccountIdentity(advance.accountId ?? null, accountLookup, advance.sourceAccountName ?? null);
    return {
      ...advance,
      resolvedAccountId: resolved.canonicalAccountId,
      matchedBy: resolved.matchedBy,
      needsAccountMappingRepair: resolved.needsAccountMappingRepair,
    };
  });
  const totalLabourAdvancesPaid = advanceDiagnostics
    .filter((advance) => isActiveOperationalRecord(advance) && advance.resolvedAccountId === accountId && farmMatches(advance.farmId ?? null) && seasonMatches(advance.seasonId ?? null))
    .reduce((sum, advance) => sum + advance.amount, 0);
  const labourWageSettlements = activeSettlements
    .reduce((sum, settlement) => sum + getLabourWageSettlementNonCashAppliedAmount(settlement), 0);
  const settledThroughWageSettlements = labourWageSettlements;
  const labourSettlementCashPaid = activeSettlements
    .reduce((sum, settlement) => sum + getLabourWageSettlementCashPaidAmount(settlement), 0);
  const carryForwardAdvances = activeSettlements
    .reduce((sum, settlement) => sum + getLabourWageSettlementRemainingAdvanceCarryForward(settlement), 0);
  const outstandingLabourAdvances = Math.max(totalLabourAdvancesPaid - settledThroughWageSettlements + carryForwardAdvances, 0);
  const diagnostics: LabourSettlementAccountingDiagnostics = {
    accountId,
    totalAdvanceRows: advances.length,
    advanceRowsMatchedByCanonicalId: advanceDiagnostics.filter((advance) => isActiveOperationalRecord(advance) && advance.accountId === accountId && farmMatches(advance.farmId ?? null) && seasonMatches(advance.seasonId ?? null)).length,
    advanceRowsMatchedByAlias: advanceDiagnostics.filter((advance) => isActiveOperationalRecord(advance) && advance.accountId !== accountId && advance.resolvedAccountId === accountId && advance.matchedBy === "alias" && farmMatches(advance.farmId ?? null) && seasonMatches(advance.seasonId ?? null)).length,
    advanceRowsMatchedByNameFallback: advanceDiagnostics.filter((advance) => isActiveOperationalRecord(advance) && advance.resolvedAccountId === accountId && advance.matchedBy === "name_fallback" && farmMatches(advance.farmId ?? null) && seasonMatches(advance.seasonId ?? null)).length,
    advanceRowsUnmatchedNonDeleted: advanceDiagnostics.filter((advance) => isActiveOperationalRecord(advance) && !advance.resolvedAccountId).length,
    settlementRowsIncluded: activeSettlements.length,
    settlementRowsExcluded: settlements.length - activeSettlements.length,
    settlementRowsMatchedByCanonicalId: activeSettlements.filter((settlement) => resolveLabourWageSettlementAccountId(settlement) === accountId).length,
    settlementRowsMatchedByAlias: activeSettlements.filter((settlement) => {
      const resolved = resolveCanonicalAccountId(resolveLabourWageSettlementAccountId(settlement), accountLookup);
      return resolved === accountId && resolveLabourWageSettlementAccountId(settlement) !== accountId;
    }).length,
    settlementRowsMatchedByNameFallback: 0,
    settlementRowsUnmatchedNonDeleted: settlements.filter((settlement) => isActiveSettlementForPartnerAccounting(settlement) && resolveCanonicalAccountId(resolveLabourWageSettlementAccountId(settlement), accountLookup) !== accountId && farmMatches((settlement as LabourWageSettlement).farmId ?? null) && seasonMatches((settlement as LabourWageSettlement).seasonId ?? null)).length,
    needsAccountMappingRepair: advanceDiagnostics.some((advance) => isActiveOperationalRecord(advance) && advance.resolvedAccountId === accountId && advance.matchedBy === "name_fallback" && farmMatches(advance.farmId ?? null) && seasonMatches(advance.seasonId ?? null)),
  };
  return {
    activeSettlements,
    totalLabourAdvancesPaid,
    labourAdvancesSettledThroughWageSettlements: settledThroughWageSettlements,
    settledThroughWageSettlements,
    outstandingLabourAdvances,
    labourWageSettlements,
    labourSettlementNonCashApplied: labourWageSettlements,
    labourSettlementCashPaid,
    diagnostics,
  };
}

export function isLabourWageSettlementVoucher(voucher: SettlementVoucherLike | null | undefined) {
  return Boolean(
    voucher
    && isActiveOperationalRecord(voucher as Record<string, unknown>)
    && (voucher.settlementId
      || voucher.voucherPurpose === "labour_wage_settlement"
      || voucher.nonCashSettlement === true),
  );
}

export function getSettlementGeneratedVouchers<T extends SettlementVoucherLike>(vouchers: readonly T[]) {
  return vouchers.filter((voucher) => isLabourWageSettlementVoucher(voucher)) as T[];
}

export function getGeneralExpenseVouchers<T extends SettlementVoucherLike>(vouchers: readonly T[]) {
  return vouchers.filter((voucher) => !isLabourWageSettlementVoucher(voucher)) as T[];
}

export function getCashAffectingVouchers(vouchers: Voucher[]) {
  return vouchers.filter((voucher) => isActiveOperationalRecord(voucher));
}

export function totalSettledAdvances(settlements: LabourWageSettlement[], options: AccountingScopeOptions = {}) {
  const farmId = options.farmId ?? null;
  const seasonId = options.seasonId ?? null;
  const farmMatches = (rowFarmId: string | null) => !farmId || rowFarmId === farmId || rowFarmId === null;
  const seasonMatches = (rowSeasonId: string | null) => !seasonId || rowSeasonId === seasonId || rowSeasonId === null;
  return getActiveLabourWageSettlements(settlements)
    .filter((settlement) => farmMatches(settlement.farmId ?? null) && seasonMatches(settlement.seasonId ?? null))
    .reduce((sum, settlement) => sum + getLabourWageSettlementAdvanceOffset(settlement), 0);
}

export function outstandingLabourAdvances(advances: Advance[], settlements: LabourWageSettlement[], options: AccountingScopeOptions = {}) {
  const farmId = options.farmId ?? null;
  const seasonId = options.seasonId ?? null;
  const farmMatches = (rowFarmId: string | null) => !farmId || rowFarmId === farmId || rowFarmId === null;
  const seasonMatches = (rowSeasonId: string | null) => !seasonId || rowSeasonId === seasonId || rowSeasonId === null;
  const totalAdvances = advances.filter((advance) => isActiveOperationalRecord(advance) && farmMatches(advance.farmId ?? null) && seasonMatches(advance.seasonId ?? null)).reduce((sum, advance) => sum + advance.amount, 0);
  return Math.max(totalAdvances - totalSettledAdvances(settlements, options), 0);
}
