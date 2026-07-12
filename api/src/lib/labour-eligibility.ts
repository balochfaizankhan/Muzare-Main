type LabourLike = {
  active?: unknown;
  isArchived?: unknown;
  createdAt?: unknown;
  joinedOn?: unknown;
  endedOn?: unknown;
  firstAttendanceDate?: unknown;
  lastAttendanceDate?: unknown;
  inactiveDate?: unknown;
  leftDate?: unknown;
};

function normalizeDate(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 10) : "";
}

export function getLabourWorkingPeriod(worker: LabourLike) {
  const workerStart = normalizeDate(worker.firstAttendanceDate)
    || normalizeDate(worker.joinedOn)
    || normalizeDate(worker.createdAt);
  const workerEnd = normalizeDate(worker.leftDate)
    || normalizeDate(worker.inactiveDate)
    || normalizeDate(worker.endedOn)
    || normalizeDate(worker.lastAttendanceDate)
    || "";
  return { workerStart, workerEnd: workerEnd || null };
}

export function isLabourAvailableForEntry(worker: LabourLike, transactionDate: string) {
  if (worker.isArchived === true) return false;
  if (worker.active === false && !normalizeDate(worker.endedOn) && !normalizeDate(worker.inactiveDate) && !normalizeDate(worker.leftDate)) return false;
  const { workerStart, workerEnd } = getLabourWorkingPeriod(worker);
  if (workerStart && transactionDate < workerStart) return false;
  if (workerEnd && transactionDate > workerEnd) return false;
  return true;
}
