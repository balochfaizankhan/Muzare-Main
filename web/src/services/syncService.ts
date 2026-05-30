import { deleteOperationalRecord as deleteOperationalRecordFromApi, fetchBootstrap, fetchOperationalRecords, saveOperationalRecord, type OperationalEntity, type OperationalRecordEnvelope } from "../lib/api";
import { clearCachedData, offlineDb, setActiveFarmId, setActiveSeasonId, setActiveWorkspaceId, type LocalRecord, type PendingMutation } from "../lib/offline-db";
import type { Table } from "dexie";

export type SyncStatus = "online" | "offline" | "pending" | "syncing" | "error";
export type SyncState = { status: SyncStatus; pendingCount: number; lastSyncTime: string | null; farmId?: string; seasonId?: string; message?: string };

const lastSyncKey = (workspaceId?: string) => `muzare-last-successful-sync:${workspaceId ?? "none"}`;
const listeners = new Set<(state: SyncState) => void>();
let context: { token: string; workspaceId: string; farmId?: string; seasonId?: string } | null = null;
let timer: number | null = null;
let syncing = false;
let state: SyncState = { status: navigator.onLine ? "online" : "offline", pendingCount: 0, lastSyncTime: null };
const maxAutomaticAttempts = 3;

const tables = {
  labourer: offlineDb.labourers, attendance: offlineDb.attendance, account: offlineDb.accounts,
  dispatch: offlineDb.dispatches, sale: offlineDb.sales, voucher: offlineDb.vouchers, partnerEntry: offlineDb.partnerEntries,
  advance: offlineDb.advances, inventoryEntry: offlineDb.inventoryEntries,
} as const;

function emit(next: Partial<SyncState> = {}) {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener(state));
}

function notify(message: string) {
  window.dispatchEvent(new CustomEvent("muzare-toast", { detail: message }));
}

function tableFor(entity: OperationalEntity) {
  return tables[entity] as unknown as Table<LocalRecord, string>;
}

async function cacheRecord(entity: OperationalEntity, record: OperationalRecordEnvelope["record"], pendingSync: boolean, farmId: string | null | undefined = context?.farmId, seasonId: string | null | undefined = context?.seasonId) {
  if (!context) throw new Error("Workspace synchronization is not initialized.");
  await tableFor(entity).put({ ...record, workspaceId: context.workspaceId, farmId, seasonId, pendingSync } as LocalRecord);
}

export async function queueOfflineRecord(entity: OperationalEntity, record: LocalRecord): Promise<void> {
  if (!context) throw new Error("Workspace synchronization is not initialized.");
  await cacheRecord(entity, record, true);
  const queuedAt = new Date().toISOString();
  const mutation: PendingMutation = {
    id: `${context.workspaceId}:${entity}:${record.id}`, entity, operation: "create", payload: record, attempts: 0,
    workspaceId: context.workspaceId, farmId: context.farmId, seasonId: context.seasonId,
    createdAt: queuedAt, updatedAt: queuedAt,
  };
  await offlineDb.pendingMutations.put(mutation);
  emit({ status: navigator.onLine ? "pending" : "offline", pendingCount: await getPendingCount() });
  notify(navigator.onLine ? "Saved locally. Syncing..." : "Saved locally. Will sync automatically when connection is restored.");
  window.dispatchEvent(new Event("muzare-local-data-change"));
}

export async function persistOperationalRecord<T extends LocalRecord>(entity: OperationalEntity, record: T): Promise<T> {
  const nextRecord = { ...record, updatedAt: new Date().toISOString(), pendingSync: true };
  await queueOfflineRecord(entity, nextRecord);
  if (navigator.onLine) void syncPendingRecords();
  return nextRecord;
}

export async function deleteOperationalRecord(entity: OperationalEntity, record: LocalRecord): Promise<void> {
  if (!context) throw new Error("Workspace synchronization is not initialized.");
  const queuedAt = new Date().toISOString();
  await tableFor(entity).delete(record.id);
  await offlineDb.pendingMutations.put({
    id: `${context.workspaceId}:${entity}:${record.id}`, entity, operation: "delete",
    payload: { ...record, updatedAt: queuedAt, pendingSync: true }, attempts: 0,
    workspaceId: context.workspaceId, farmId: record.farmId ?? context.farmId, seasonId: record.seasonId ?? context.seasonId,
    createdAt: queuedAt, updatedAt: queuedAt,
  });
  emit({ status: navigator.onLine ? "pending" : "offline", pendingCount: await getPendingCount() });
  notify(navigator.onLine ? "Attendance cleared locally. Syncing..." : "Attendance cleared locally. Will sync automatically when connection is restored.");
  window.dispatchEvent(new Event("muzare-local-data-change"));
  if (navigator.onLine) void syncPendingRecords();
}

export async function syncPendingRecords(options: { force?: boolean } = {}): Promise<{ synced: number; pending: number }> {
  if (syncing) return { synced: 0, pending: await getPendingCount() };
  if (!navigator.onLine || !context) {
    emit({ status: "offline", pendingCount: await getPendingCount() });
    return { synced: 0, pending: await getPendingCount() };
  }
  syncing = true;
  emit({ status: "syncing" });
  let synced = 0;
  const pendingRecords = (await offlineDb.pendingMutations.where("workspaceId").equals(context.workspaceId).sortBy("createdAt"))
    .filter((mutation) => mutation.farmId === context!.farmId && mutation.seasonId === context!.seasonId);
  for (const mutation of pendingRecords) {
    if (!options.force && (mutation.attempts >= maxAutomaticAttempts || (mutation.nextAttemptAt && mutation.nextAttemptAt > new Date().toISOString()))) continue;
    try {
      if (mutation.operation === "delete") {
        await deleteOperationalRecordFromApi(context.token, {
          workspaceId: context.workspaceId, farmId: mutation.farmId || context.farmId, seasonId: mutation.seasonId || context.seasonId,
          entity: mutation.entity, recordId: (mutation.payload as LocalRecord).id,
        });
        const latest = await offlineDb.pendingMutations.get(mutation.id);
        if (latest?.updatedAt !== mutation.updatedAt) continue;
        await tableFor(mutation.entity).delete((mutation.payload as LocalRecord).id);
        await offlineDb.pendingMutations.delete(mutation.id);
        synced += 1;
        continue;
      }
      const response = await saveOperationalRecord(context.token, {
        workspaceId: context.workspaceId, farmId: mutation.farmId || context.farmId, seasonId: mutation.seasonId || context.seasonId,
        entity: mutation.entity, record: normalizeRecord(mutation.payload as OperationalRecordEnvelope["record"]),
      });
      const latest = await offlineDb.pendingMutations.get(mutation.id);
      if (latest?.updatedAt !== mutation.updatedAt) continue;
      await cacheRecord(mutation.entity, response.record, false, mutation.farmId, mutation.seasonId);
      await offlineDb.pendingMutations.delete(mutation.id);
      synced += 1;
    } catch (error) {
      if (error instanceof Error && error.message.includes("PostgreSQL is the primary workspace database")) {
        if (mutation.operation === "delete") await tableFor(mutation.entity).delete((mutation.payload as LocalRecord).id);
        else await tableFor(mutation.entity).update((mutation.payload as LocalRecord).id, { pendingSync: false });
        await offlineDb.pendingMutations.delete(mutation.id);
        synced += 1;
        continue;
      }
      const attempts = Math.min(mutation.attempts + 1, maxAutomaticAttempts);
      await offlineDb.pendingMutations.update(mutation.id, {
        attempts,
        nextAttemptAt: new Date(Date.now() + 1_000 * 2 ** (attempts - 1)).toISOString(),
      });
      break;
    }
  }
  syncing = false;
  const pending = await getPendingCount();
  if (pending === 0) {
    const lastSyncTime = new Date().toISOString();
    localStorage.setItem(lastSyncKey(context.workspaceId), lastSyncTime);
    emit({ status: "online", pendingCount: 0, lastSyncTime, message: synced ? `${synced} records synced successfully` : undefined });
  } else {
    emit({ status: "error", pendingCount: pending, message: `${pending} records remain pending` });
  }
  return { synced, pending };
}

function normalizeRecord(record: OperationalRecordEnvelope["record"]) {
  return { ...record, updatedAt: record.updatedAt || record.createdAt };
}

export async function syncNow() {
  if (!navigator.onLine) {
    notify("Working offline. Pending changes will sync when connectivity returns.");
    return { synced: 0, pending: await getPendingCount() };
  }
  if ((await getPendingCount()) === 0) {
    await refreshOperationalData({ notifySuccess: false });
    notify("Database synchronized.");
    return { synced: 0, pending: 0 };
  }
  const result = await syncPendingRecords({ force: true });
  notify(result.pending ? `${result.pending} records remain pending` : `${result.synced} records synced successfully`);
  return result;
}

export async function refreshOperationalData(options: { notifySuccess?: boolean } = {}): Promise<void> {
  if (!context || !navigator.onLine) {
    emit({ status: "offline" });
    notify("Working offline. Refresh will retry when connectivity returns.");
    return;
  }
  try {
    const result = await fetchOperationalRecords(context.token, context.workspaceId);
    await pruneSynchronizedCache(result.records);
    const pendingDeletes = new Set((await offlineDb.pendingMutations.where("workspaceId").equals(context.workspaceId).toArray())
      .filter((item) => item.operation === "delete")
      .map((item) => item.id));
    for (const item of result.records) {
      if (pendingDeletes.has(`${context.workspaceId}:${item.entity}:${item.record.id}`)) continue;
      await cacheRecord(item.entity, item.record, false, item.farmId ?? undefined, item.seasonId ?? undefined);
    }
    const lastSyncTime = new Date().toISOString();
    localStorage.setItem(lastSyncKey(context.workspaceId), lastSyncTime);
    emit({ status: (await getPendingCount()) ? "pending" : "online", lastSyncTime, pendingCount: await getPendingCount() });
    window.dispatchEvent(new Event("muzare-data-refresh"));
    if (options.notifySuccess !== false) notify("Latest workspace data loaded from the database.");
  } catch {
    emit({ status: "error", pendingCount: await getPendingCount() });
    notify("Unable to refresh from the database. Cached workspace data is still available.");
  }
}

async function pruneSynchronizedCache(records: OperationalRecordEnvelope[]) {
  const remoteIds = new Map<OperationalEntity, Set<string>>();
  if (!context) return;
  const queuedIds = new Set((await offlineDb.pendingMutations.where("workspaceId").equals(context.workspaceId).toArray()).map((item) => item.id));
  for (const item of records) {
    const ids = remoteIds.get(item.entity) ?? new Set<string>();
    ids.add(item.record.id);
    remoteIds.set(item.entity, ids);
  }
  for (const entity of Object.keys(tables) as OperationalEntity[]) {
    const table = tableFor(entity);
    const localRecords = await table.where("workspaceId").equals(context.workspaceId).toArray();
    const staleIds = localRecords
      .filter((item) => !item.pendingSync && !queuedIds.has(`${context!.workspaceId}:${entity}:${item.id}`) && !remoteIds.get(entity)?.has(item.id))
      .map((item) => item.id);
    await table.bulkDelete(staleIds);
  }
}

export async function getPendingCount() {
  return context ? offlineDb.pendingMutations.where("workspaceId").equals(context.workspaceId)
    .filter((mutation) => mutation.farmId === context!.farmId && mutation.seasonId === context!.seasonId).count() : 0;
}

export function getLastSyncTime() {
  return localStorage.getItem(lastSyncKey(context?.workspaceId));
}

export function subscribeSyncState(listener: (next: SyncState) => void) {
  listeners.add(listener);
  listener(state);
  return () => {
    listeners.delete(listener);
  };
}

export async function startSyncService(token: string, workspaceId: string) {
  context = { token, workspaceId };
  setActiveWorkspaceId(workspaceId);
  emit({ lastSyncTime: getLastSyncTime(), pendingCount: await getPendingCount() });
  if (timer) window.clearInterval(timer);
  timer = window.setInterval(() => void syncPendingRecords(), 30_000);
  try {
    const bootstrap = await fetchBootstrap(token);
    const farm = bootstrap.farms.find((item) => item.id === bootstrap.activeFarmId);
    const season = bootstrap.seasons.find((item) => item.id === bootstrap.activeSeasonId);
    context = { token, workspaceId, farmId: farm?.id, seasonId: season?.id };
    setActiveFarmId(farm?.id ?? null);
    setActiveSeasonId(season?.id ?? null);
    emit({ farmId: farm?.id, seasonId: season?.id });
    await refreshOperationalData();
    await syncPendingRecords();
  } catch {
    emit({ status: navigator.onLine ? "error" : "offline", pendingCount: await getPendingCount() });
  }
}

export function stopSyncService() {
  if (timer) window.clearInterval(timer);
  timer = null;
  context = null;
  setActiveWorkspaceId(null);
  setActiveFarmId(null);
  setActiveSeasonId(null);
}

export async function clearWorkspaceCache() {
  stopSyncService();
  await clearCachedData();
}

window.addEventListener("online", () => {
  void refreshOperationalData();
  void syncPendingRecords();
});
window.addEventListener("offline", () => emit({ status: "offline" }));
