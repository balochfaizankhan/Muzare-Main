import type { Labourer } from "./offline-db";

export type WorkerDisplayGroup = "active" | "inactive" | "archived";

export type WorkingPeriod = {
  workerStart: string;
  workerEnd: string | null;
};

export type SortWorkersOptions = {
  includeArchived?: boolean;
  includeInactive?: boolean;
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
  if (isArchivedWorker(worker)) return "archived";
  if (worker.active === false || Boolean(worker.endedOn)) return "inactive";
  return "active";
}

export function sortWorkersForDisplay<T extends Pick<Labourer, "name" | "createdAt" | "active" | "endedOn" | "isArchived">>(workers: T[], options: SortWorkersOptions = {}) {
  const filtered = options.includeArchived ? workers.slice() : workers.filter((worker) => !isArchivedWorker(worker));
  const rank: Record<WorkerDisplayGroup, number> = { active: 0, inactive: 1, archived: 2 };
  return filtered.sort((left, right) => {
    const groupDelta = rank[getWorkerDisplayGroup(left)] - rank[getWorkerDisplayGroup(right)];
    if (groupDelta !== 0) return groupDelta;
    const nameDelta = left.name.localeCompare(right.name);
    if (nameDelta !== 0) return nameDelta;
    const createdDelta = left.createdAt.localeCompare(right.createdAt);
    if (createdDelta !== 0) return createdDelta;
    return 0;
  });
}

export function isWorkerEligibleForAttendance(worker: Pick<Labourer, "createdAt" | "joinedOn" | "endedOn" | "firstAttendanceDate" | "lastAttendanceDate" | "inactiveDate" | "leftDate" | "isArchived">, selectedDate: string) {
  if (isArchivedWorker(worker)) return false;
  const { workerStart, workerEnd } = getWorkerWorkingPeriod(worker);
  return selectedDate >= workerStart && (!workerEnd || selectedDate <= workerEnd);
}

export function isWorkerEligibleForWageRatePeriod(worker: Pick<Labourer, "createdAt" | "joinedOn" | "endedOn" | "firstAttendanceDate" | "lastAttendanceDate" | "inactiveDate" | "leftDate" | "isArchived">, selectedFrom: string, selectedTo: string) {
  if (isArchivedWorker(worker)) return false;
  const { workerStart, workerEnd } = getWorkerWorkingPeriod(worker);
  const periodEnd = workerEnd ?? farFuture();
  return selectedFrom <= periodEnd && workerStart <= selectedTo;
}

export function isWorkerEligibleForAdvancePayment(worker: Pick<Labourer, "createdAt" | "joinedOn" | "isArchived">, _selectedDate: string) {
  return !isArchivedWorker(worker) && Boolean(worker.joinedOn || worker.createdAt);
}

export function isWorkerEligibleForSettlement(worker: Pick<Labourer, "createdAt" | "joinedOn" | "isArchived">, _selectedDate: string) {
  return !isArchivedWorker(worker) && Boolean(worker.joinedOn || worker.createdAt);
}
