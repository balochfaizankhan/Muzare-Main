import type { Advance, LabourWageSettlement, Voucher } from "./offline-db";
import { isActiveOperationalRecord } from "./operationalRecords";

export function isPostedLabourWageSettlement(settlement: LabourWageSettlement | null | undefined) {
  return Boolean(settlement && isActiveOperationalRecord(settlement) && settlement.status === "posted");
}

export function getActiveLabourWageSettlements(settlements: LabourWageSettlement[]) {
  return settlements.filter(isPostedLabourWageSettlement);
}

export function isLabourWageSettlementVoucher(voucher: Voucher | null | undefined) {
  return Boolean(
    voucher
    && isActiveOperationalRecord(voucher)
    && ((voucher as Voucher & { settlementId?: unknown }).settlementId
      || (voucher as Voucher & { voucherPurpose?: unknown }).voucherPurpose === "labour_wage_settlement"
      || (voucher as Voucher & { nonCashSettlement?: unknown }).nonCashSettlement === true),
  );
}

export function getCashAffectingVouchers(vouchers: Voucher[]) {
  return vouchers.filter((voucher) => !isLabourWageSettlementVoucher(voucher));
}

export function totalSettledAdvances(settlements: LabourWageSettlement[]) {
  return getActiveLabourWageSettlements(settlements).reduce((sum, settlement) => sum + settlement.settledAdvanceAmount, 0);
}

export function outstandingLabourAdvances(advances: Advance[], settlements: LabourWageSettlement[]) {
  const totalAdvances = advances.filter(isActiveOperationalRecord).reduce((sum, advance) => sum + advance.amount, 0);
  return Math.max(totalAdvances - totalSettledAdvances(settlements), 0);
}
