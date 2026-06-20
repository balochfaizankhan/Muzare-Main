import { deleteOperationalRecord as deleteOperationalRecordFromApi, fetchBootstrap, fetchOperationalRecords, saveOperationalRecord, type OperationalEntity, type OperationalRecordEnvelope } from "../lib/api";
import { clearCachedData, offlineDb, setActiveFarmId, setActiveSeasonId, setActiveWorkspaceId, type LocalRecord, type PendingMutation } from "../lib/offline-db";
import type { Table } from "dexie";
import i18n from "../i18n";

export type SyncStatus = "online" | "offline" | "pending" | "syncing" | "error";
export type SyncState = {
  status: SyncStatus; pendingCount: number; lastSyncTime: string | null; farmId?: string; seasonId?: string;
  dataSource?: "cache" | "server"; message?: string;
};

const lastSyncKey = (workspaceId?: string) => `muzare-last-successful-sync:${workspaceId ?? "none"}`;
const operationalContextPrefix = "muzare-operational-context:";
const operationalContextKey = (workspaceId: string) => `${operationalContextPrefix}${workspaceId}`;
const listeners = new Set<(state: SyncState) => void>();
let context: { token: string; workspaceId: string; farmId?: string; seasonId?: string } | null = null;
let timer: number | null = null;
let syncing = false;
let state: SyncState = { status: navigator.onLine ? "online" : "offline", pendingCount: 0, lastSyncTime: null };
const maxAutomaticAttempts = 3;

const tables = {
  labourer: offlineDb.labourers, labourGroup: offlineDb.labourGroups, attendance: offlineDb.attendance, account: offlineDb.accounts,
  vehicle: offlineDb.vehicles, dateType: offlineDb.dateTypes, dispatch: offlineDb.dispatches, sale: offlineDb.sales, voucher: offlineDb.vouchers, partnerEntry: offlineDb.partnerEntries,
  advance: offlineDb.advances, labourPayment: offlineDb.labourPayments, productionEntry: offlineDb.productionEntries, inventoryEntry: offlineDb.inventoryEntries,
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

function rememberOperationalContext(workspaceId: string, farmId?: string, seasonId?: string) {
  if (!farmId || !seasonId) return;
  localStorage.setItem(operationalContextKey(workspaceId), JSON.stringify({ farmId, seasonId }));
}

function restoreOperationalContext(workspaceId: string) {
  try {
    return JSON.parse(localStorage.getItem(operationalContextKey(workspaceId)) ?? "null") as { farmId?: string; seasonId?: string } | null;
  } catch {
    return null;
  }
}

function applyOperationalContext(token: string, workspaceId: string, farmId?: string, seasonId?: string) {
  context = { token, workspaceId, farmId, seasonId };
  setActiveWorkspaceId(workspaceId);
  setActiveFarmId(farmId ?? null);
  setActiveSeasonId(seasonId ?? null);
  emit({ farmId, seasonId });
  window.dispatchEvent(new Event("muzare-local-data-change"));
}

async function cacheRecord(entity: OperationalEntity, record: OperationalRecordEnvelope["record"], pendingSync: boolean, farmId: string | null | undefined = context?.farmId, seasonId: string | null | undefined = context?.seasonId) {
  if (!context) throw new Error(i18n.t("sync.workspaceSyncNotInitialized"));
  await tableFor(entity).put({ ...record, workspaceId: context.workspaceId, farmId, seasonId, pendingSync } as LocalRecord);
}

export async function queueOfflineRecord(entity: OperationalEntity, record: LocalRecord): Promise<void> {
  if (!context) throw new Error(i18n.t("sync.workspaceSyncNotInitialized"));
  await cacheRecord(entity, record, true);
  const queuedAt = new Date().toISOString();
  const mutation: PendingMutation = {
    id: `${context.workspaceId}:${entity}:${record.id}`, entity, operation: "create", payload: record, attempts: 0,
    workspaceId: context.workspaceId, farmId: context.farmId, seasonId: context.seasonId,
    createdAt: queuedAt, updatedAt: queuedAt,
  };
  await offlineDb.pendingMutations.put(mutation);
  emit({ status: navigator.onLine ? "pending" : "offline", pendingCount: await getPendingCount() });
  notify(navigator.onLine ? i18n.t("sync.savedLocallySyncing") : i18n.t("sync.savedLocallyOffline"));
  window.dispatchEvent(new Event("muzare-local-data-change"));
}

export async function persistOperationalRecord<T extends LocalRecord>(entity: OperationalEntity, record: T): Promise<T> {
  const nextRecord = { ...record, updatedAt: new Date().toISOString(), pendingSync: true };
  await queueOfflineRecord(entity, nextRecord);
  if (navigator.onLine) void syncPendingRecords();
  return nextRecord;
}

export async function deleteOperationalRecord(entity: OperationalEntity, record: LocalRecord & { deletionReason?: string }): Promise<void> {
  if (!context) throw new Error("Workspace synchronization is not initialized.");
  const queuedAt = new Date().toISOString();
  const softDelete = entity === "partnerEntry" || entity === "advance" || entity === "voucher" || entity === "sale";
  const payload = softDelete ? { ...record, deletedAt: queuedAt, updatedAt: queuedAt, pendingSync: true } : { ...record, updatedAt: queuedAt, pendingSync: true };
  if (softDelete) await tableFor(entity).put(payload);
  else await tableFor(entity).delete(record.id);
  await offlineDb.pendingMutations.put({
    id: `${context.workspaceId}:${entity}:${record.id}`, entity, operation: "delete",
    payload, attempts: 0,
    workspaceId: context.workspaceId, farmId: record.farmId ?? context.farmId, seasonId: record.seasonId ?? context.seasonId,
    createdAt: queuedAt, updatedAt: queuedAt,
  });
  emit({ status: navigator.onLine ? "pending" : "offline", pendingCount: await getPendingCount() });
  const translatedLabel = entity === "partnerEntry" ? i18n.t("sync.partnerLedgerEntryDeleted")
    : entity === "advance" ? i18n.t("sync.labourAdvanceDeleted")
      : entity === "voucher" ? i18n.t("sync.expenseVoucherDeleted")
        : entity === "sale" ? i18n.t("sync.saleDeleted")
          : entity === "dispatch" ? i18n.t("sync.dispatchDeleted")
            : entity === "vehicle" ? i18n.t("sync.vehicleDeleted")
              : entity === "dateType" ? i18n.t("sync.dateTypeDeleted") : i18n.t("sync.attendanceCleared");
  notify(navigator.onLine ? i18n.t("sync.deletedLocallySyncing", { item: translatedLabel }) : i18n.t("sync.deletedLocallyOffline", { item: translatedLabel }));
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
          reason: (mutation.payload as { deletionReason?: string }).deletionReason,
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
      if (response.conflict) notify(i18n.t("sync.newerDatabaseChangeKept"));
      const latest = await offlineDb.pendingMutations.get(mutation.id);
      if (latest?.updatedAt !== mutation.updatedAt) continue;
      if (response.record.id !== (mutation.payload as LocalRecord).id) {
        if (mutation.entity === "partnerEntry") await tableFor(mutation.entity).put({ ...(mutation.payload as LocalRecord), pendingSync: false });
        else await tableFor(mutation.entity).delete((mutation.payload as LocalRecord).id);
      }
      await cacheRecord(mutation.entity, response.record, false, mutation.farmId, mutation.seasonId);
      await offlineDb.pendingMutations.delete(mutation.id);
      window.dispatchEvent(new Event("muzare-local-data-change"));
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
    notify(i18n.t("sync.workingOfflinePendingChanges"));
    return { synced: 0, pending: await getPendingCount() };
  }
  if ((await getPendingCount()) === 0) {
    await refreshOperationalData({ notifySuccess: false });
    notify(i18n.t("sync.databaseSynchronized"));
    return { synced: 0, pending: 0 };
  }
  const result = await syncPendingRecords({ force: true });
  notify(result.pending ? i18n.t("sync.recordsRemainPending", { count: result.pending }) : i18n.t("sync.recordsSyncedSuccessfully", { count: result.synced }));
  return result;
}

export async function refreshOperationalData(options: { notifySuccess?: boolean } = {}): Promise<void> {
  if (!context || !navigator.onLine) {
    emit({ status: "offline" });
    notify(i18n.t("sync.workingOfflineRefreshRetry"));
    return;
  }
  try {
    const result = await fetchOperationalRecords(context.token, context.workspaceId);
    const pendingDeletes = new Set((await offlineDb.pendingMutations.where("workspaceId").equals(context.workspaceId).toArray())
      .filter((item) => item.operation === "delete")
      .map((item) => item.id));
    for (const item of result.records) {
      if (pendingDeletes.has(`${context.workspaceId}:${item.entity}:${item.record.id}`)) continue;
      await cacheRecord(item.entity, item.record, false, item.farmId ?? undefined, item.seasonId ?? undefined);
    }
    if (result.snapshotConfirmed && result.farmId === context.farmId && result.seasonId === context.seasonId) {
      await pruneSynchronizedCache(result.records);
    }
    const lastSyncTime = new Date().toISOString();
    localStorage.setItem(lastSyncKey(context.workspaceId), lastSyncTime);
    emit({ status: (await getPendingCount()) ? "pending" : "online", dataSource: "server", lastSyncTime, pendingCount: await getPendingCount() });
    window.dispatchEvent(new Event("muzare-data-refresh"));
    if (options.notifySuccess !== false) notify(i18n.t("sync.latestWorkspaceDataLoaded"));
  } catch {
    emit({ status: navigator.onLine ? "error" : "offline", dataSource: "cache", pendingCount: await getPendingCount(), message: i18n.t("workforcePage.cachedLoadingLabour") });
    notify(i18n.t("sync.unableToRefreshCachedAvailable"));
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
      .filter((item) => item.farmId === context!.farmId && (item.seasonId === context!.seasonId || item.seasonId == null))
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
  const cached = restoreOperationalContext(workspaceId);
  applyOperationalContext(token, workspaceId, cached?.farmId, cached?.seasonId);
  emit({ dataSource: "cache", lastSyncTime: getLastSyncTime(), pendingCount: await getPendingCount() });
  if (timer) window.clearInterval(timer);
  timer = window.setInterval(() => void syncPendingRecords(), 30_000);
  try {
    const bootstrap = await fetchBootstrap(token);
    const farm = bootstrap.farms.find((item) => item.id === bootstrap.activeFarmId);
    const season = bootstrap.seasons.find((item) => item.id === bootstrap.activeSeasonId);
    applyOperationalContext(token, workspaceId, farm?.id, season?.id);
    rememberOperationalContext(workspaceId, farm?.id, season?.id);
    await refreshOperationalData();
    await syncPendingRecords();
  } catch {
    emit({ status: navigator.onLine ? "error" : "offline", dataSource: "cache", pendingCount: await getPendingCount(), message: i18n.t("workforcePage.cachedLoadingLabour") });
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
  Object.keys(localStorage).filter((key) => key.startsWith(operationalContextPrefix)).forEach((key) => localStorage.removeItem(key));
}

window.addEventListener("online", () => {
  void refreshOperationalData();
  void syncPendingRecords();
});
window.addEventListener("offline", () => emit({ status: "offline" }));
