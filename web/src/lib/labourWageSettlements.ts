import type { Advance, LabourWageSettlement, Voucher } from "./offline-db";
import { isActiveOperationalRecord } from "./operationalRecords";

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
  status?: unknown;
  accountingStatus?: unknown;
  deletedAt?: unknown;
};

function accountIdFromSettlementField(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function resolveLabourWageSettlementAccountId(settlement: SettlementAccountLike | null | undefined) {
  if (!settlement) return null;
  return accountIdFromSettlementField(settlement.linkedAccountId)
    ?? accountIdFromSettlementField(settlement.paymentAccountId)
    ?? accountIdFromSettlementField(settlement.accountId);
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

export function getLabourWageSettlementLedgerAmount(settlement: SettlementAccountLike & { settledAdvanceAmount?: number; expenseAmount?: number }) {
  return Number(settlement.expenseAmount ?? settlement.settledAdvanceAmount ?? 0);
}

export function getLabourWageSettlementAdvanceOffset(settlement: SettlementAccountLike & { settledAdvanceAmount?: number }) {
  return Number(settlement.settledAdvanceAmount ?? 0);
}

export function getLabourWageSettlementCashPaidAmount(settlement: SettlementAccountLike & { payableBalance?: number; cashPayable?: number; cashPaid?: number; expenseAmount?: number; settledAdvanceAmount?: number }) {
  return Number(settlement.cashPaid ?? settlement.payableBalance ?? settlement.cashPayable ?? Math.max(Number(settlement.expenseAmount ?? 0) - Number(settlement.settledAdvanceAmount ?? 0), 0));
}

export function getLabourWageSettlementNonCashAppliedAmount(settlement: SettlementAccountLike & { settledAdvanceAmount?: number }) {
  return Number(settlement.settledAdvanceAmount ?? 0);
}

export function getLabourSettlementAccountingSnapshot(
  advances: Advance[],
  settlements: LabourWageSettlement[],
  accountId: string,
) {
  const activeSettlements = settlements.filter((settlement) =>
    isActiveSettlementForPartnerAccounting(settlement)
    && resolveLabourWageSettlementAccountId(settlement) === accountId,
  );
  const totalLabourAdvancesPaid = advances
    .filter((advance) => isActiveOperationalRecord(advance) && advance.accountId === accountId)
    .reduce((sum, advance) => sum + advance.amount, 0);
  const labourWageSettlements = activeSettlements
    .reduce((sum, settlement) => sum + getLabourWageSettlementNonCashAppliedAmount(settlement), 0);
  const settledThroughWageSettlements = activeSettlements
    .reduce((sum, settlement) => sum + getLabourWageSettlementAdvanceOffset(settlement), 0);
  const labourSettlementCashPaid = activeSettlements
    .reduce((sum, settlement) => sum + getLabourWageSettlementCashPaidAmount(settlement), 0);
  const outstandingLabourAdvances = Math.max(totalLabourAdvancesPaid - settledThroughWageSettlements, 0);
  return {
    activeSettlements,
    totalLabourAdvancesPaid,
    settledThroughWageSettlements,
    outstandingLabourAdvances,
    labourWageSettlements,
    labourSettlementCashPaid,
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

export function totalSettledAdvances(settlements: LabourWageSettlement[]) {
  return getActiveLabourWageSettlements(settlements).reduce((sum, settlement) => sum + settlement.settledAdvanceAmount, 0);
}

export function outstandingLabourAdvances(advances: Advance[], settlements: LabourWageSettlement[]) {
  const totalAdvances = advances.filter(isActiveOperationalRecord).reduce((sum, advance) => sum + advance.amount, 0);
  return Math.max(totalAdvances - totalSettledAdvances(settlements), 0);
}
