import i18n from "../i18n";
import type { Advance, Attendance, LabourEarning, LabourPayment, LabourWageSettlement, WageRate } from "./offline-db";
import { isActiveOperationalRecord } from "./operationalRecords";
import { normalizeHalfDayRate, resolveApplicableWageRate, summarizeAttendanceWages, wageForAttendanceStatus } from "./wageRates";

export type AttendanceWageBreakdownRow = {
  fromDate: string;
  toDate: string;
  rate: WageRate | null;
  dailyRate: number;
  halfDayRate: number;
  presentCount: number;
  halfDayCount: number;
  fullDayAmount: number;
  halfDayAmount: number;
  subtotal: number;
};

export type AttendanceWageBreakdown = {
  available: boolean;
  rows: AttendanceWageBreakdownRow[];
  totalWage: number;
};

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

export function labourEarningScopeLabel(earning: LabourEarning) {
  return earning.earningScope === "group"
    ? i18n.t("labourEarningsLabels.scopeGroup")
    : i18n.t("labourEarningsLabels.scopeIndividual");
}

export function labourEarningScopeTarget(earning: LabourEarning) {
  if (earning.earningScope === "group") {
    return earning.labourGroupName ?? earning.labourGroupId ?? i18n.t("labourEarningsLabels.labourGroupFallback");
  }
  return earning.labourerId ?? i18n.t("labourEarningsLabels.labourerFallback");
}

export function labourEarningsByScope(earnings: LabourEarning[]) {
  return earnings.reduce((totals, earning) => {
    if (earning.earningScope === "group") totals.group += earning.amount;
    else totals.individual += earning.amount;
    return totals;
  }, { individual: 0, group: 0 });
}

export function buildAttendanceWageBreakdown(
  labourerId: string,
  attendance: Attendance[],
  rates: WageRate[],
  fallbackDailyRate = 0,
): AttendanceWageBreakdown {
  const records = attendance
    .filter((item) => item.labourerId === labourerId)
    .slice()
    .sort((left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id));
  const rowsByKey = new Map<string, AttendanceWageBreakdownRow & { firstSeen: number }>();
  let available = true;

  records.forEach((record, index) => {
    const rate = resolveApplicableWageRate(rates, labourerId, record.date);
    if (record.status !== "absent" && !rate && fallbackDailyRate <= 0) available = false;
    const key = rate?.id ?? `fallback:${fallbackDailyRate}`;
    const dailyRate = rate?.dailyRate ?? fallbackDailyRate;
    const halfDayRate = rate ? normalizeHalfDayRate(rate) : fallbackDailyRate > 0 ? fallbackDailyRate / 2 : 0;
    const current = rowsByKey.get(key);
    const amount = wageForAttendanceStatus(record.status, rate, fallbackDailyRate);
    if (!current) {
      rowsByKey.set(key, {
        fromDate: record.date,
        toDate: record.date,
        rate,
        dailyRate,
        halfDayRate,
        presentCount: record.status === "present" ? 1 : 0,
        halfDayCount: record.status === "half_day" ? 1 : 0,
        fullDayAmount: record.status === "present" ? dailyRate : 0,
        halfDayAmount: record.status === "half_day" ? halfDayRate : 0,
        subtotal: amount,
        firstSeen: index,
      });
      return;
    }
    current.toDate = record.date;
    current.presentCount += record.status === "present" ? 1 : 0;
    current.halfDayCount += record.status === "half_day" ? 1 : 0;
    current.fullDayAmount += record.status === "present" ? dailyRate : 0;
    current.halfDayAmount += record.status === "half_day" ? halfDayRate : 0;
    current.subtotal += amount;
  });

  const rows = [...rowsByKey.values()]
    .sort((left, right) => left.firstSeen - right.firstSeen)
    .map(({ firstSeen: _firstSeen, ...row }) => row);

  return {
    available,
    rows,
    totalWage: rows.reduce((sum, row) => sum + row.subtotal, 0),
  };
}

export function buildLabourEarningsProfileSummary(args: {
  labourerId: string;
  attendance: Attendance[];
  wageRates: WageRate[];
  earnings: LabourEarning[];
  payments: LabourPayment[];
  advances: Advance[];
  settlements: LabourWageSettlement[];
}) {
  const attendanceSummary = summarizeAttendanceWages(args.labourerId, args.attendance, args.wageRates);
  const attendanceWageBreakdown = buildAttendanceWageBreakdown(args.labourerId, args.attendance, args.wageRates);
  const pendingEarnings = pendingLabourEarningsUpToDate(args.earnings, "9999-12-31", args.labourerId);
  const totalPendingEarnings = sumLabourEarnings(pendingEarnings);
  const advancesPaid = args.advances
    .filter((advance) => isActiveOperationalRecord(advance) && advance.labourerId === args.labourerId)
    .reduce((sum, advance) => sum + advance.amount, 0);
  const paymentsPaid = args.payments
    .filter((payment) => isActiveOperationalRecord(payment) && payment.labourerId === args.labourerId)
    .reduce((sum, payment) => sum + payment.amount, 0);
  const settledAdvances = args.settlements
    .filter((settlement) =>
      isActiveOperationalRecord(settlement)
      && settlement.settlementMode !== "group"
      && (settlement.includedLabourIds?.includes(args.labourerId) ?? false))
    .reduce((sum, settlement) => sum + settlement.settledAdvanceAmount, 0);
  const totalEarned = attendanceSummary.totalWage + totalPendingEarnings;
  const estimatedPayable = totalEarned - advancesPaid - paymentsPaid;
  const carryForwardAdvance = Math.max(advancesPaid - totalEarned, 0);
  return {
    attendanceSummary,
    attendanceWageBreakdown,
    pendingEarnings,
    totalPendingEarnings,
    advancesPaid,
    paymentsPaid,
    settledAdvances,
    totalEarned,
    estimatedPayable,
    carryForwardAdvance,
  };
}

export function labourEarningTypeLabel(type: LabourEarning["earningType"]) {
  const keys: Record<LabourEarning["earningType"], string> = {
    adjustment: "labourEarningsLabels.typeAdjustment",
    bonus: "labourEarningsLabels.typeBonus",
    incentive: "labourEarningsLabels.typeIncentive",
    lump_sum: "labourEarningsLabels.typeLumpSum",
    other: "labourEarningsLabels.typeOther",
    task: "labourEarningsLabels.typeTask",
  };
  const key = keys[type];
  return key ? i18n.t(key) : type;
}
