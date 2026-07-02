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

export function isPostedLabourWageSettlement(settlement: LabourWageSettlement | null | undefined) {
  return Boolean(settlement && isActiveOperationalRecord(settlement) && settlement.status === "posted");
}

export function getActiveLabourWageSettlements(settlements: LabourWageSettlement[]) {
  return settlements.filter(isPostedLabourWageSettlement);
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
