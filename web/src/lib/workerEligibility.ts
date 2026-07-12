import type { Labourer } from "./offline-db";

export type WorkerDisplayGroup = "active" | "inactive";

export type WorkingPeriod = {
  workerStart: string;
  workerEnd: string | null;
};

export type SortWorkersOptions = {
  includeInactive?: boolean;
  includeArchived?: boolean;
  sort?: "preserve" | "alphabetical" | "latest";
};

function normalizeDate(value?: string | null) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function farFuture() {
  return "9999-12-31";
}

export function isArchivedWorker(worker: Pick<Labourer, "isArchived">) {
  return worker.isArchived === true;
}

export function getWorkerWorkingPeriod(worker: Pick<Labourer, "createdAt" | "joinedOn" | "endedOn" | "firstAttendanceDate" | "lastAttendanceDate" | "inactiveDate" | "leftDate">): WorkingPeriod {
  const workerStart = normalizeDate(worker.firstAttendanceDate)
    || normalizeDate(worker.joinedOn)
    || worker.createdAt.slice(0, 10);
  const workerEnd = normalizeDate(worker.leftDate)
    || normalizeDate(worker.inactiveDate)
    || normalizeDate(worker.endedOn)
    || normalizeDate(worker.lastAttendanceDate)
    || null;
  return { workerStart, workerEnd };
}

export function getWorkerDisplayGroup(worker: Pick<Labourer, "active" | "endedOn" | "isArchived">): WorkerDisplayGroup {
  if (isArchivedWorker(worker)) return "inactive";
  if (worker.active === false || Boolean(worker.endedOn)) return "inactive";
  return "active";
}

export function groupWorkersByStatusPreserveOrder<T extends Pick<Labourer, "active" | "endedOn" | "isArchived">>(workers: T[]) {
  const active: T[] = [];
  const inactive: T[] = [];
  for (const worker of workers) {
    if (getWorkerDisplayGroup(worker) === "active") active.push(worker);
    else inactive.push(worker);
  }
  return [...active, ...inactive];
}

export function sortWorkersForDisplay<T extends Pick<Labourer, "name" | "createdAt" | "active" | "endedOn" | "isArchived" | "sortOrder" | "androidSortOrder" | "originalIndex">>(workers: T[], options: SortWorkersOptions = {}) {
  const filtered = options.includeArchived ? workers.slice() : workers.filter((worker) => !isArchivedWorker(worker));
  const grouped = groupWorkersByStatusPreserveOrder(filtered);
  if (options.sort === "alphabetical") return [...grouped].sort((left, right) => left.name.localeCompare(right.name));
  if (options.sort === "latest") {
    return [...grouped].sort((left, right) => {
      const leftSort = typeof left.sortOrder === "number" ? left.sortOrder
        : typeof left.androidSortOrder === "number" ? left.androidSortOrder
          : typeof left.originalIndex === "number" ? left.originalIndex
            : Date.parse(left.createdAt);
      const rightSort = typeof right.sortOrder === "number" ? right.sortOrder
        : typeof right.androidSortOrder === "number" ? right.androidSortOrder
          : typeof right.originalIndex === "number" ? right.originalIndex
            : Date.parse(right.createdAt);
      return rightSort - leftSort;
    });
  }
  return grouped;
}

export function isWorkerEligibleForAttendance(worker: Pick<Labourer, "active" | "createdAt" | "joinedOn" | "endedOn" | "firstAttendanceDate" | "lastAttendanceDate" | "inactiveDate" | "leftDate" | "isArchived">, selectedDate: string) {
  if (isArchivedWorker(worker)) return false;
  const { workerStart, workerEnd } = getWorkerWorkingPeriod(worker);
  if (selectedDate < workerStart) return false;
  if (workerEnd && selectedDate > workerEnd) return false;
  if (worker.active === false && !workerEnd) return false;
  return true;
}

export function isWorkerEligibleForWageRatePeriod(worker: Pick<Labourer, "createdAt" | "joinedOn" | "endedOn" | "firstAttendanceDate" | "lastAttendanceDate" | "inactiveDate" | "leftDate" | "isArchived">, selectedFrom: string, selectedTo: string) {
  if (isArchivedWorker(worker)) return false;
  const { workerStart, workerEnd } = getWorkerWorkingPeriod(worker);
  const periodEnd = workerEnd ?? farFuture();
  return selectedFrom <= periodEnd && workerStart <= selectedTo;
}

export function isLabourAvailableForEntry(worker: Pick<Labourer, "active" | "createdAt" | "joinedOn" | "endedOn" | "firstAttendanceDate" | "lastAttendanceDate" | "inactiveDate" | "leftDate" | "isArchived">, transactionDate: string) {
  if (isArchivedWorker(worker)) return false;
  const { workerStart, workerEnd } = getWorkerWorkingPeriod(worker);
  if (workerStart && transactionDate < workerStart) return false;
  if (workerEnd && transactionDate > workerEnd) return false;
  if (worker.active === false && !workerEnd) return false;
  return Boolean(workerStart);
}

export function isWorkerEligibleForAdvancePayment(worker: Pick<Labourer, "active" | "createdAt" | "joinedOn" | "endedOn" | "firstAttendanceDate" | "lastAttendanceDate" | "inactiveDate" | "leftDate" | "isArchived">, selectedDate: string) {
  return isLabourAvailableForEntry(worker, selectedDate);
}

export function isWorkerEligibleForSettlement(worker: Pick<Labourer, "active" | "createdAt" | "joinedOn" | "endedOn" | "firstAttendanceDate" | "lastAttendanceDate" | "inactiveDate" | "leftDate" | "isArchived">, selectedDate: string) {
  return isLabourAvailableForEntry(worker, selectedDate);
}
