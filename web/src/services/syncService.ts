import { fetchBootstrap, fetchOperationalRecords, saveOperationalRecord, type OperationalEntity, type OperationalRecordEnvelope } from "../lib/api";
import { offlineDb, type LocalRecord, type PendingMutation } from "../lib/offline-db";
import type { Table } from "dexie";

export type SyncStatus = "online" | "offline" | "pending" | "syncing" | "error";
export type SyncState = { status: SyncStatus; pendingCount: number; lastSyncTime: string | null; message?: string };

const lastSyncKey = "muzare-last-successful-sync";
const listeners = new Set<(state: SyncState) => void>();
let context: { token: string; workspaceId: string; farmId?: string; seasonId?: string } | null = null;
let timer: number | null = null;
let syncing = false;
let state: SyncState = { status: navigator.onLine ? "online" : "offline", pendingCount: 0, lastSyncTime: localStorage.getItem(lastSyncKey) };

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

async function cacheRecord(entity: OperationalEntity, record: OperationalRecordEnvelope["record"], pendingSync: boolean) {
  await tableFor(entity).put({ ...record, pendingSync } as LocalRecord);
}

function envelope(entity: OperationalEntity, record: LocalRecord): OperationalRecordEnvelope {
  if (!context) throw new Error("Workspace synchronization is not initialized.");
  return { ...context, entity, record };
}

export async function queueOfflineRecord(entity: OperationalEntity, record: LocalRecord): Promise<void> {
  if (!context) throw new Error("Workspace synchronization is not initialized.");
  await cacheRecord(entity, record, true);
  const queuedAt = new Date().toISOString();
  const mutation: PendingMutation = {
    id: `${entity}:${record.id}`, entity, operation: "create", payload: record, attempts: 0,
    workspaceId: context.workspaceId, farmId: context.farmId, seasonId: context.seasonId,
    createdAt: queuedAt, updatedAt: queuedAt,
  };
  await offlineDb.pendingMutations.put(mutation);
  emit({ status: navigator.onLine ? "pending" : "offline", pendingCount: await getPendingCount() });
  notify("Saved locally. Will sync automatically when connection is restored.");
}

export async function persistOperationalRecord<T extends LocalRecord>(entity: OperationalEntity, record: T): Promise<T> {
  const nextRecord = { ...record, updatedAt: new Date().toISOString(), pendingSync: false };
  try {
    if (!navigator.onLine) throw new Error("Browser is offline.");
    if (!context) throw new Error("Workspace synchronization is not initialized.");
    const response = await saveOperationalRecord(context.token, envelope(entity, nextRecord));
    const saved = { ...response.record, pendingSync: false } as T;
    await cacheRecord(entity, saved, false);
    await offlineDb.pendingMutations.delete(`${entity}:${record.id}`);
    const pendingCount = await getPendingCount();
    emit({ status: pendingCount ? "pending" : "online", pendingCount });
    return saved;
  } catch {
    await queueOfflineRecord(entity, nextRecord);
    return { ...nextRecord, pendingSync: true };
  }
}

export async function syncPendingRecords(): Promise<{ synced: number; pending: number }> {
  if (syncing) return { synced: 0, pending: await getPendingCount() };
  if (!navigator.onLine || !context) {
    emit({ status: "offline", pendingCount: await getPendingCount() });
    return { synced: 0, pending: await getPendingCount() };
  }
  syncing = true;
  emit({ status: "syncing" });
  let synced = 0;
  const pendingRecords = await offlineDb.pendingMutations.orderBy("createdAt").toArray();
  for (const mutation of pendingRecords) {
    try {
      const response = await saveOperationalRecord(context.token, {
        workspaceId: mutation.workspaceId || context.workspaceId, farmId: mutation.farmId || context.farmId, seasonId: mutation.seasonId || context.seasonId,
        entity: mutation.entity, record: normalizeRecord(mutation.payload as OperationalRecordEnvelope["record"]),
      });
      await cacheRecord(mutation.entity, response.record, false);
      await offlineDb.pendingMutations.delete(mutation.id);
      synced += 1;
    } catch {
      await offlineDb.pendingMutations.update(mutation.id, { attempts: mutation.attempts + 1 });
    }
  }
  syncing = false;
  const pending = await getPendingCount();
  if (pending === 0) {
    const lastSyncTime = new Date().toISOString();
    localStorage.setItem(lastSyncKey, lastSyncTime);
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
  const result = await syncPendingRecords();
  notify(result.pending ? `${result.pending} records remain pending` : `${result.synced} records synced successfully`);
  return result;
}

export async function refreshOperationalData(): Promise<void> {
  if (!context || !navigator.onLine) {
    emit({ status: "offline" });
    notify("Working offline. Refresh will retry when connectivity returns.");
    return;
  }
  try {
    const result = await fetchOperationalRecords(context.token, context.workspaceId);
    await pruneSynchronizedCache(result.records);
    for (const item of result.records) await cacheRecord(item.entity, item.record, false);
    const lastSyncTime = new Date().toISOString();
    localStorage.setItem(lastSyncKey, lastSyncTime);
    emit({ status: (await getPendingCount()) ? "pending" : "online", lastSyncTime, pendingCount: await getPendingCount() });
    window.dispatchEvent(new Event("muzare-data-refresh"));
    notify("Latest workspace data loaded from the database.");
  } catch {
    emit({ status: "error", pendingCount: await getPendingCount() });
    notify("Unable to refresh from the database. Cached workspace data is still available.");
  }
}

async function pruneSynchronizedCache(records: OperationalRecordEnvelope[]) {
  const remoteIds = new Map<OperationalEntity, Set<string>>();
  const queuedIds = new Set((await offlineDb.pendingMutations.toArray()).map((item) => item.id));
  for (const item of records) {
    const ids = remoteIds.get(item.entity) ?? new Set<string>();
    ids.add(item.record.id);
    remoteIds.set(item.entity, ids);
  }
  for (const entity of Object.keys(tables) as OperationalEntity[]) {
    const table = tableFor(entity);
    const localRecords = await table.toArray();
    const staleIds = localRecords
      .filter((item) => !item.pendingSync && !queuedIds.has(`${entity}:${item.id}`) && !remoteIds.get(entity)?.has(item.id))
      .map((item) => item.id);
    await table.bulkDelete(staleIds);
  }
}

export async function getPendingCount() {
  return offlineDb.pendingMutations.count();
}

export function getLastSyncTime() {
  return localStorage.getItem(lastSyncKey);
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
  if (timer) window.clearInterval(timer);
  timer = window.setInterval(() => void syncPendingRecords(), 30_000);
  try {
    const bootstrap = await fetchBootstrap(token);
    const farm = bootstrap.farms[0];
    const season = farm ? bootstrap.seasons.find((item) => item.farmId === farm.id) : bootstrap.seasons[0];
    context = { token, workspaceId, farmId: farm?.id, seasonId: season?.id };
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
}

window.addEventListener("online", () => {
  void refreshOperationalData();
  void syncPendingRecords();
});
window.addEventListener("offline", () => emit({ status: "offline" }));
