import type { Attendance, WageRate } from "./offline-db";
import { isActiveOperationalRecord } from "./operationalRecords";

export type WageRateStatus = "active" | "upcoming" | "expired" | "inactive";

function farFuture() {
  return "9999-12-31";
}

export function normalizeHalfDayRate(rate: Pick<WageRate, "dailyRate" | "halfDayRate">) {
  return typeof rate.halfDayRate === "number" && Number.isFinite(rate.halfDayRate)
    ? rate.halfDayRate
    : rate.dailyRate / 2;
}

export function getWageRateStatus(rate: WageRate, today: string) {
  if (rate.active === false || !isActiveOperationalRecord(rate)) return "inactive" satisfies WageRateStatus;
  if (rate.effectiveFrom > today) return "upcoming" satisfies WageRateStatus;
  if (rate.effectiveTo && rate.effectiveTo < today) return "expired" satisfies WageRateStatus;
  return "active" satisfies WageRateStatus;
}

export function compareWageRates(left: WageRate, right: WageRate) {
  return right.effectiveFrom.localeCompare(left.effectiveFrom)
    || (right.effectiveTo ?? farFuture()).localeCompare(left.effectiveTo ?? farFuture())
    || right.updatedAt.localeCompare(left.updatedAt)
    || right.id.localeCompare(left.id);
}

export function resolveApplicableWageRate(rates: WageRate[], labourerId: string, date: string) {
  return rates
    .filter((rate) =>
      isActiveOperationalRecord(rate)
      && rate.active !== false
      && rate.labourerId === labourerId
      && rate.effectiveFrom <= date
      && (!rate.effectiveTo || rate.effectiveTo >= date))
    .sort((left, right) =>
      right.effectiveFrom.localeCompare(left.effectiveFrom)
      || right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
}

export function wageForAttendanceStatus(status: Attendance["status"], rate: WageRate | null, fallbackDailyRate = 0) {
  const dailyRate = rate?.dailyRate ?? fallbackDailyRate;
  const halfDayRate = rate ? normalizeHalfDayRate(rate) : fallbackDailyRate > 0 ? fallbackDailyRate / 2 : 0;
  if (status === "present") return dailyRate;
  if (status === "half_day") return halfDayRate;
  return 0;
}

export function wageRateDisplay(rate: WageRate | null, fallbackDailyRate = 0) {
  const dailyRate = rate?.dailyRate ?? fallbackDailyRate;
  const halfDayRate = rate ? normalizeHalfDayRate(rate) : fallbackDailyRate > 0 ? fallbackDailyRate / 2 : 0;
  return { dailyRate, halfDayRate };
}

export function summarizeAttendanceWages(
  labourerId: string,
  attendance: Attendance[],
  rates: WageRate[],
  fallbackDailyRate = 0,
) {
  const records = attendance.filter((item) => item.labourerId === labourerId);
  const present = records.filter((item) => item.status === "present").length;
  const halfDay = records.filter((item) => item.status === "half_day").length;
  const absent = records.filter((item) => item.status === "absent").length;
  const payable = present + halfDay * 0.5;
  const appliedRates = records.map((record) => ({
    record,
    rate: resolveApplicableWageRate(rates, labourerId, record.date),
  }));
  const totalWage = appliedRates.reduce((sum, item) => sum + wageForAttendanceStatus(item.record.status, item.rate, fallbackDailyRate), 0);
  const missingRateDates = records
    .filter((record) => record.status !== "absent" && !resolveApplicableWageRate(rates, labourerId, record.date))
    .map((record) => record.date);
  const distinctDailyRates = [...new Set(appliedRates
    .filter((item) => item.rate || fallbackDailyRate > 0)
    .map((item) => wageRateDisplay(item.rate, fallbackDailyRate).dailyRate)
    .filter((value) => Number.isFinite(value) && value > 0))];
  return {
    records,
    present,
    halfDay,
    absent,
    payable,
    totalWage,
    missingRateDates,
    wageRateLabel: distinctDailyRates.length === 0 ? null : distinctDailyRates.length === 1 ? String(distinctDailyRates[0]) : "Mixed",
  };
}
