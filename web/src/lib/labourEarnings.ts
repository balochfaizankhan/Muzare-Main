import type { Advance, Attendance, LabourEarning, LabourWageSettlement, WageRate } from "./offline-db";
import { isActiveOperationalRecord } from "./operationalRecords";
import { summarizeAttendanceWages } from "./wageRates";

export function isPendingLabourEarning(earning: LabourEarning | null | undefined) {
  return Boolean(earning && isActiveOperationalRecord(earning) && earning.status === "pending_settlement");
}

export function isSettledLabourEarning(earning: LabourEarning | null | undefined) {
  return Boolean(earning && isActiveOperationalRecord(earning) && earning.status === "settled");
}

export function isVoidedLabourEarning(earning: LabourEarning | null | undefined) {
  return Boolean(earning && (!isActiveOperationalRecord(earning) || earning.status === "voided"));
}

export function pendingLabourEarningsUpToDate(
  earnings: LabourEarning[],
  settlementDate: string,
  labourerId?: string,
) {
  return earnings.filter((earning) =>
    isPendingLabourEarning(earning)
    && earning.earningDate <= settlementDate
    && (!labourerId || earning.labourerId === labourerId));
}

export function sumLabourEarnings(earnings: LabourEarning[]) {
  return earnings.reduce((sum, earning) => sum + earning.amount, 0);
}

export function buildLabourEarningsProfileSummary(args: {
  labourerId: string;
  attendance: Attendance[];
  wageRates: WageRate[];
  earnings: LabourEarning[];
  advances: Advance[];
  settlements: LabourWageSettlement[];
}) {
  const attendanceSummary = summarizeAttendanceWages(args.labourerId, args.attendance, args.wageRates);
  const pendingEarnings = pendingLabourEarningsUpToDate(args.earnings, "9999-12-31", args.labourerId);
  const totalPendingEarnings = sumLabourEarnings(pendingEarnings);
  const advancesPaid = args.advances
    .filter((advance) => isActiveOperationalRecord(advance) && advance.labourerId === args.labourerId)
    .reduce((sum, advance) => sum + advance.amount, 0);
  const settledAdvances = args.settlements
    .filter((settlement) => isActiveOperationalRecord(settlement))
    .reduce((sum, settlement) => sum + settlement.settledAdvanceAmount, 0);
  const totalEarned = attendanceSummary.totalWage + totalPendingEarnings;
  const estimatedPayable = Math.max(totalEarned - advancesPaid, 0);
  const carryForwardAdvance = Math.max(advancesPaid - totalEarned, 0);
  return {
    attendanceSummary,
    pendingEarnings,
    totalPendingEarnings,
    advancesPaid,
    settledAdvances,
    totalEarned,
    estimatedPayable,
    carryForwardAdvance,
  };
}

export function labourEarningTypeLabel(type: LabourEarning["earningType"]) {
  return type;
}
