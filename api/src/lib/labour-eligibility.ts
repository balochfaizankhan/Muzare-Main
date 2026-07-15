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
  archivedAt?: unknown;
  deletedAt?: unknown;
  deleted?: unknown;
  status?: unknown;
  deactivatedAt?: unknown;
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

export function isLabourSelectableForAdvance(worker: LabourLike, _transactionDate: string) {
  const lifecycleStatus = typeof worker.status === "string" ? worker.status.trim().toLowerCase() : "";
  const explicitlyDeleted = normalizeDate(worker.deletedAt)
    || worker.deleted === true
    || (typeof worker.deleted === "string" && worker.deleted.trim().toLowerCase() === "true")
    || lifecycleStatus === "deleted";
  if (explicitlyDeleted) return false;
  if (worker.isArchived === true || normalizeDate(worker.archivedAt)) return false;
  if (lifecycleStatus === "archived") return false;
  if (normalizeDate(worker.deactivatedAt) || lifecycleStatus === "deactivated") return false;
  return true;
}
