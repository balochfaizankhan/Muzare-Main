import { ApiError, deleteOperationalRecord as deleteOperationalRecordFromApi, fetchBootstrap, fetchOperationalRecords, saveOperationalRecord, type OperationalEntity, type OperationalRecordEnvelope } from "../lib/api";
import { clearCachedData, offlineDb, setActiveFarmId, setActiveSeasonId, setActiveWorkspaceId, type LocalRecord, type PendingMutation } from "../lib/offline-db";
import { canQueueOperationalMutation } from "../lib/permissions";
import type { Table } from "dexie";
import i18n from "../i18n";

export type SyncStatus = "online" | "offline" | "pending" | "syncing" | "error";
export type SyncStartupStage = "checkingSession" | "loadingWorkspace" | "loadingContext" | "syncingLatestRecords" | "ready";
export type SyncState = {
  status: SyncStatus; pendingCount: number; lastSyncTime: string | null; farmId?: string; seasonId?: string;
  failedCount?: number;
  dataSource?: "cache" | "server"; message?: string;
  startupStage?: SyncStartupStage;
  startupInProgress?: boolean;
  lastProgressAt?: string | null;
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
const localDebugEnabled = import.meta.env.DEV;

type SyncErrorDetails = {
  code?: string;
  permissionKey?: string;
  moduleAction?: string;
  requestWorkspaceId?: string;
  activeWorkspaceId?: string | null;
  requestFarmId?: string | null;
  activeFarmId?: string | null;
  requestSeasonId?: string | null;
  activeSeasonId?: string | null;
};

const tables = {
  labourer: offlineDb.labourers, labourGroup: offlineDb.labourGroups, attendance: offlineDb.attendance, account: offlineDb.accounts,
  vehicle: offlineDb.vehicles, dateType: offlineDb.dateTypes, dispatch: offlineDb.dispatches, sale: offlineDb.sales, voucher: offlineDb.vouchers, partnerEntry: offlineDb.partnerEntries,
  advance: offlineDb.advances, labourPayment: offlineDb.labourPayments, productionEntry: offlineDb.productionEntries, inventoryEntry: offlineDb.inventoryEntries,
} as const;

function emit(next: Partial<SyncState> = {}) {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener(state));
}

function emitStartup(startupStage: SyncStartupStage, message: string, next: Partial<SyncState> = {}) {
  emit({
    startupStage,
    startupInProgress: startupStage !== "ready",
    lastProgressAt: new Date().toISOString(),
    message,
    ...next,
  });
}

function notify(message: string) {
  window.dispatchEvent(new CustomEvent("muzare-toast", { detail: message }));
}

function debugVoucherSync(stage: string, detail: Record<string, unknown>) {
  if (!localDebugEnabled) return;
  console.log(`[voucher-sync] ${stage}`, detail);
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

async function cacheRecord(
  entity: OperationalEntity,
  record: OperationalRecordEnvelope["record"],
  pendingSync: boolean,
  farmId: string | null | undefined = (record as Partial<LocalRecord>).farmId ?? context?.farmId,
  seasonId: string | null | undefined = (record as Partial<LocalRecord>).seasonId ?? context?.seasonId,
  workspaceId: string | undefined = (record as Partial<LocalRecord>).workspaceId ?? context?.workspaceId,
) {
  if (!context) throw new Error(i18n.t("sync.workspaceSyncNotInitialized"));
  await tableFor(entity).put({ ...record, workspaceId: workspaceId ?? context.workspaceId, farmId, seasonId, pendingSync } as LocalRecord);
}

function assertCanQueueMutation(entity: OperationalEntity, operation: "create" | "edit" | "delete") {
  if (!canQueueOperationalMutation(entity, operation)) {
    notify(i18n.t("common.viewOnlyAccess"));
    throw new Error(i18n.t("sync.permissionDenied"));
  }
}

function isRetryableSyncError(error: unknown) {
  if (!(error instanceof ApiError)) return true;
  return error.status >= 500 || error.status === 408 || error.status === 425 || error.status === 429;
}

function isPermissionDeniedSyncError(error: unknown) {
  return error instanceof ApiError && error.status === 403;
}

function syncErrorDetails(error: unknown): SyncErrorDetails | null {
  return error instanceof ApiError && error.details && typeof error.details === "object"
    ? error.details as SyncErrorDetails
    : null;
}

function isStaleContextSyncError(error: unknown) {
  const code = syncErrorDetails(error)?.code;
  return code === "stale_workspace_context" || code === "stale_farm_context" || code === "stale_season_context";
}

function formatPermissionDeniedMessage(details: SyncErrorDetails | null) {
  if (!details?.permissionKey) return i18n.t("sync.permissionDenied");
  return i18n.t("sync.permissionDeniedWithKey", { permission: details.permissionKey });
}

function formatStaleContextMessage(details: SyncErrorDetails | null) {
  if (!details) return i18n.t("sync.staleWorkspaceContext");
  if (details.code === "stale_workspace_context") {
    return i18n.t("sync.staleWorkspaceContextDetail", {
      active: details.activeWorkspaceId ?? "-",
      request: details.requestWorkspaceId ?? "-",
    });
  }
  if (details.code === "stale_farm_context") {
    return i18n.t("sync.staleFarmContextDetail", {
      active: details.activeFarmId ?? "-",
      request: details.requestFarmId ?? "-",
    });
  }
  if (details.code === "stale_season_context") {
    return i18n.t("sync.staleSeasonContextDetail", {
      active: details.activeSeasonId ?? "-",
      request: details.requestSeasonId ?? "-",
    });
  }
  return i18n.t("sync.staleWorkspaceContext");
}

async function getContextMutations() {
  return context
    ? offlineDb.pendingMutations.where("workspaceId").equals(context.workspaceId)
      .filter((mutation) => mutation.farmId === context!.farmId && mutation.seasonId === context!.seasonId)
      .toArray()
    : [];
}

async function refreshSyncState(next: Partial<SyncState> = {}) {
  const mutations = await getContextMutations();
  const pendingCount = mutations.filter((mutation) => (mutation.status ?? "pending") !== "resolved"
    && (mutation.status ?? "pending") !== "discarded"
    && (mutation.retryable ?? true)).length;
  const failedCount = mutations.filter((mutation) =>
    (mutation.status === "failed" || mutation.status === "permission_denied" || mutation.status === "stale_context") && !(mutation.retryable ?? true)).length;
  emit({ pendingCount, failedCount, ...next });
}

export async function queueOfflineRecord(entity: OperationalEntity, record: LocalRecord, operation: "create" | "edit" = "create"): Promise<void> {
  if (!context) throw new Error(i18n.t("sync.workspaceSyncNotInitialized"));
  assertCanQueueMutation(entity, operation);
  const recordWorkspaceId = record.workspaceId || context.workspaceId;
  const recordFarmId = record.farmId ?? context.farmId;
  const recordSeasonId = record.seasonId ?? context.seasonId;
  await cacheRecord(entity, { ...record, workspaceId: recordWorkspaceId, farmId: recordFarmId, seasonId: recordSeasonId }, true, recordFarmId, recordSeasonId, recordWorkspaceId);
  const queuedAt = new Date().toISOString();
  const mutation: PendingMutation = {
    id: `${recordWorkspaceId}:${entity}:${record.id}`, entity, operation: operation === "edit" ? "update" : operation, payload: { ...record, workspaceId: recordWorkspaceId, farmId: recordFarmId, seasonId: recordSeasonId }, attempts: 0,
    clientMutationId: `${recordWorkspaceId}:${entity}:${record.id}`,
    status: "pending",
    retryable: true,
    workspaceId: recordWorkspaceId, farmId: recordFarmId, seasonId: recordSeasonId,
    createdAt: queuedAt, updatedAt: queuedAt,
  };
  await offlineDb.pendingMutations.put(mutation);
  if (entity === "voucher") {
    debugVoucherSync("queued", {
      operation,
      mutationId: mutation.id,
      clientRecordId: record.id,
      workspaceId: recordWorkspaceId,
      farmId: recordFarmId,
      seasonId: recordSeasonId,
    });
  }
  await refreshSyncState({ status: navigator.onLine ? "pending" : "offline" });
  notify(navigator.onLine ? i18n.t("sync.savedLocallySyncing") : i18n.t("sync.savedLocallyOffline"));
  window.dispatchEvent(new Event("muzare-local-data-change"));
}

export async function persistOperationalRecord<T extends LocalRecord>(entity: OperationalEntity, record: T): Promise<T> {
  const existing = await tableFor(entity).get(record.id);
  const operation = existing ? "edit" : "create";
  const nextRecord = { ...record, updatedAt: new Date().toISOString(), pendingSync: true };
  await queueOfflineRecord(entity, nextRecord, operation);
  if (navigator.onLine) void syncPendingRecords();
  return nextRecord;
}

export async function deleteOperationalRecord(entity: OperationalEntity, record: LocalRecord & { deletionReason?: string }): Promise<void> {
  if (!context) throw new Error("Workspace synchronization is not initialized.");
  assertCanQueueMutation(entity, "delete");
  const queuedAt = new Date().toISOString();
  const softDelete = entity === "partnerEntry" || entity === "advance" || entity === "voucher" || entity === "sale";
  const payload = softDelete ? { ...record, deletedAt: queuedAt, updatedAt: queuedAt, pendingSync: true } : { ...record, updatedAt: queuedAt, pendingSync: true };
  if (softDelete) await tableFor(entity).put(payload);
  else await tableFor(entity).delete(record.id);
  await offlineDb.pendingMutations.put({
    id: `${context.workspaceId}:${entity}:${record.id}`, entity, operation: "delete",
    payload, attempts: 0,
    clientMutationId: `${context.workspaceId}:${entity}:${record.id}`,
    status: "pending",
    retryable: true,
    workspaceId: context.workspaceId, farmId: record.farmId ?? context.farmId, seasonId: record.seasonId ?? context.seasonId,
    createdAt: queuedAt, updatedAt: queuedAt,
  });
  await refreshSyncState({ status: navigator.onLine ? "pending" : "offline" });
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
    await refreshSyncState({ status: "offline" });
    return { synced: 0, pending: await getPendingCount() };
  }
  syncing = true;
  emit({ status: "syncing" });
  let synced = 0;
  const pendingRecords = (await offlineDb.pendingMutations.where("workspaceId").equals(context.workspaceId).sortBy("createdAt"))
    .filter((mutation) => mutation.farmId === context!.farmId
      && mutation.seasonId === context!.seasonId
      && (mutation.status ?? "pending") !== "resolved"
      && (mutation.status ?? "pending") !== "discarded");
  let hadPermanentFailures = false;
  for (const mutation of pendingRecords) {
    if (!options.force && !((mutation.retryable ?? true))) continue;
    if (!options.force && (mutation.attempts >= maxAutomaticAttempts || (mutation.nextAttemptAt && mutation.nextAttemptAt > new Date().toISOString()))) continue;
    const payloadScope = mutation.payload as Partial<LocalRecord>;
    if (
      (payloadScope.workspaceId && payloadScope.workspaceId !== mutation.workspaceId)
      || ((payloadScope.farmId ?? null) !== (mutation.farmId ?? null))
      || ((payloadScope.seasonId ?? null) !== (mutation.seasonId ?? null))
    ) {
      const lastError = i18n.t("sync.staleQueueItemScopeMismatch");
      await offlineDb.pendingMutations.update(mutation.id, {
        status: "stale_context",
        retryable: false,
        lastError,
        lastAttemptedAt: new Date().toISOString(),
      });
      if (mutation.entity === "voucher") {
        debugVoucherSync("sync-failed", {
          mutationId: mutation.id,
          clientRecordId: (mutation.payload as LocalRecord).id,
          staleContext: true,
          lastError,
          mutationWorkspaceId: mutation.workspaceId,
          payloadWorkspaceId: payloadScope.workspaceId ?? null,
          mutationFarmId: mutation.farmId ?? null,
          payloadFarmId: payloadScope.farmId ?? null,
          mutationSeasonId: mutation.seasonId ?? null,
          payloadSeasonId: payloadScope.seasonId ?? null,
        });
      }
      window.dispatchEvent(new Event("muzare-local-data-change"));
      notify(lastError);
      hadPermanentFailures = true;
      continue;
    }
    try {
      if (mutation.entity === "voucher") {
        debugVoucherSync("sync-start", {
          mutationId: mutation.id,
          clientRecordId: (mutation.payload as LocalRecord).id,
          workspaceId: mutation.workspaceId,
          farmId: mutation.farmId,
          seasonId: mutation.seasonId,
          operation: mutation.operation,
          attempts: mutation.attempts,
        });
      }
      await offlineDb.pendingMutations.update(mutation.id, {
        status: "syncing",
        lastAttemptedAt: new Date().toISOString(),
        lastError: undefined,
      });
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
        if (mutation.entity === "voucher") {
          debugVoucherSync("delete-synced", {
            mutationId: mutation.id,
            clientRecordId: (mutation.payload as LocalRecord).id,
          });
        }
        window.dispatchEvent(new Event("muzare-local-data-change"));
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
      if (mutation.entity === "voucher") {
        debugVoucherSync("sync-success", {
          mutationId: mutation.id,
          clientRecordId: response.record.id,
          voucherNumber: (response.record as Record<string, unknown>).voucherNumber,
        });
      }
      window.dispatchEvent(new Event("muzare-local-data-change"));
      synced += 1;
    } catch (error) {
      const permissionDenied = isPermissionDeniedSyncError(error);
      const staleContext = isStaleContextSyncError(error);
      const details = syncErrorDetails(error);
      if (error instanceof Error && error.message.includes("PostgreSQL is the primary workspace database")) {
        if (mutation.operation === "delete") await tableFor(mutation.entity).delete((mutation.payload as LocalRecord).id);
        else await tableFor(mutation.entity).update((mutation.payload as LocalRecord).id, { pendingSync: false });
        await offlineDb.pendingMutations.delete(mutation.id);
        synced += 1;
        continue;
      }
      const retryable = isRetryableSyncError(error);
      const attempts = Math.min(mutation.attempts + 1, maxAutomaticAttempts);
      const nextAttemptAt = retryable && attempts < maxAutomaticAttempts
        ? new Date(Date.now() + 1_000 * 2 ** (attempts - 1)).toISOString()
        : undefined;
      const lastError = staleContext
        ? formatStaleContextMessage(details)
        : permissionDenied
          ? formatPermissionDeniedMessage(details)
        : error instanceof Error
          ? error.message
          : "Unknown sync failure.";
      await offlineDb.pendingMutations.update(mutation.id, {
        attempts,
        retryable: staleContext ? false : retryable && attempts < maxAutomaticAttempts,
        status: staleContext
          ? "stale_context"
          : permissionDenied
          ? "permission_denied"
          : retryable && attempts < maxAutomaticAttempts
            ? "pending"
            : "failed",
        lastError,
        nextAttemptAt,
        lastAttemptedAt: new Date().toISOString(),
      });
      if (mutation.entity === "voucher") {
        debugVoucherSync("sync-failed", {
          mutationId: mutation.id,
          clientRecordId: (mutation.payload as LocalRecord).id,
          retryable,
          permissionDenied,
          staleContext,
          attempts,
          lastError,
          workspaceId: mutation.workspaceId,
          farmId: mutation.farmId,
          seasonId: mutation.seasonId,
          details,
        });
      }
      window.dispatchEvent(new Event("muzare-local-data-change"));
      if (staleContext) notify(lastError);
      else if (permissionDenied) notify(lastError);
      else if (!(retryable && attempts < maxAutomaticAttempts)) notify(lastError);
      if (!(retryable && attempts < maxAutomaticAttempts)) hadPermanentFailures = true;
      if (retryable && attempts < maxAutomaticAttempts) continue;
    }
  }
  syncing = false;
  const pending = await getPendingCount();
  const failedMutations = (await getContextMutations()).filter((mutation) =>
    (mutation.status === "failed" || mutation.status === "permission_denied" || mutation.status === "stale_context") && !(mutation.retryable ?? true));
  if (pending === 0) {
    const lastSyncTime = new Date().toISOString();
    localStorage.setItem(lastSyncKey(context.workspaceId), lastSyncTime);
    await refreshSyncState({ status: failedMutations.length || hadPermanentFailures ? "error" : "online", lastSyncTime, message: failedMutations.length ? i18n.t("sync.someItemsNeedReview") : (synced ? `${synced} records synced successfully` : undefined) });
  } else {
    await refreshSyncState({ status: failedMutations.length ? "error" : "pending", message: `${pending} records remain pending` });
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
    await refreshSyncState({ status: (await getPendingCount()) ? "pending" : "online", dataSource: "server", lastSyncTime });
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
    .filter((mutation) => mutation.farmId === context!.farmId
      && mutation.seasonId === context!.seasonId
      && (mutation.status ?? "pending") !== "resolved"
      && (mutation.status ?? "pending") !== "discarded"
      && (mutation.retryable ?? true)).count() : 0;
}

export async function getSyncQueueItems() {
  const items = await getContextMutations();
  return items.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function retrySyncQueueItem(mutationId: string) {
  const item = await offlineDb.pendingMutations.get(mutationId);
  if (item && item.operation !== "delete") {
    await tableFor(item.entity).update((item.payload as LocalRecord).id, { pendingSync: true });
  }
  await offlineDb.pendingMutations.update(mutationId, {
    attempts: 0,
    retryable: true,
    status: "pending",
    nextAttemptAt: undefined,
    lastError: undefined,
  });
  await refreshSyncState({ status: navigator.onLine ? "pending" : "offline" });
  if (navigator.onLine) await syncPendingRecords({ force: true });
}

export async function resolveSyncQueueItem(mutationId: string) {
  const item = await offlineDb.pendingMutations.get(mutationId);
  if (!item) return;
  if (item.operation === "delete") await tableFor(item.entity).delete((item.payload as LocalRecord).id);
  else await tableFor(item.entity).update((item.payload as LocalRecord).id, { pendingSync: false });
  await offlineDb.pendingMutations.update(mutationId, {
    status: "resolved",
    retryable: false,
    resolvedAt: new Date().toISOString(),
  });
  await refreshSyncState({ status: navigator.onLine ? "online" : "offline" });
  window.dispatchEvent(new Event("muzare-local-data-change"));
}

export async function discardSyncQueueItem(mutationId: string) {
  const item = await offlineDb.pendingMutations.get(mutationId);
  if (!item) return;
  if (item.operation !== "delete") await tableFor(item.entity).update((item.payload as LocalRecord).id, { pendingSync: false });
  await offlineDb.pendingMutations.update(mutationId, {
    status: "discarded",
    retryable: false,
    resolvedAt: new Date().toISOString(),
  });
  await refreshSyncState({ status: navigator.onLine ? "online" : "offline" });
  window.dispatchEvent(new Event("muzare-local-data-change"));
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
  emitStartup("loadingWorkspace", i18n.t("sync.loadingWorkspace"), {
    dataSource: "cache",
    lastSyncTime: getLastSyncTime(),
    status: navigator.onLine ? "online" : "offline",
  });
  await refreshSyncState({ dataSource: "cache", lastSyncTime: getLastSyncTime() });
  if (timer) window.clearInterval(timer);
  timer = window.setInterval(() => void syncPendingRecords(), 30_000);
  void (async () => {
    try {
      const bootstrap = await fetchBootstrap(token);
      const farm = bootstrap.farms.find((item) => item.id === bootstrap.activeFarmId);
      const season = bootstrap.seasons.find((item) => item.id === bootstrap.activeSeasonId);
      applyOperationalContext(token, workspaceId, farm?.id, season?.id);
      rememberOperationalContext(workspaceId, farm?.id, season?.id);
      emitStartup("loadingContext", i18n.t("sync.loadingFarmSeason"), {
        farmId: farm?.id,
        seasonId: season?.id,
        dataSource: "cache",
      });
      window.dispatchEvent(new Event("muzare-data-refresh"));
      emitStartup("syncingLatestRecords", navigator.onLine ? i18n.t("sync.syncingLatestRecords") : i18n.t("sync.offlineReady"));
      await refreshOperationalData({ notifySuccess: false });
      await syncPendingRecords();
      emitStartup("ready", navigator.onLine ? i18n.t("sync.connectedReady") : i18n.t("sync.offlineReady"), {
        startupInProgress: false,
        status: navigator.onLine ? state.status : "offline",
      });
    } catch {
      await refreshSyncState({
        status: navigator.onLine ? "error" : "offline",
        dataSource: "cache",
        message: i18n.t("workforcePage.cachedLoadingLabour"),
        startupStage: "ready",
        startupInProgress: false,
        lastProgressAt: new Date().toISOString(),
      });
    }
  })();
}

export async function repairStaleSyncQueueItem(mutationId: string) {
  if (!context) throw new Error(i18n.t("sync.workspaceSyncNotInitialized"));
  const item = await offlineDb.pendingMutations.get(mutationId);
  if (!item) return;
  const payload = item.payload as LocalRecord;
  const repairedPayload = {
    ...payload,
    workspaceId: context.workspaceId,
    farmId: payload.farmId ?? context.farmId ?? null,
    seasonId: payload.seasonId ?? context.seasonId ?? null,
    pendingSync: true,
  };
  await tableFor(item.entity).update(payload.id, repairedPayload);
  await offlineDb.pendingMutations.update(mutationId, {
    payload: repairedPayload,
    workspaceId: context.workspaceId,
    farmId: repairedPayload.farmId ?? undefined,
    seasonId: repairedPayload.seasonId ?? undefined,
    attempts: 0,
    retryable: true,
    status: "pending",
    nextAttemptAt: undefined,
    lastError: undefined,
    updatedAt: new Date().toISOString(),
  });
  await refreshSyncState({ status: navigator.onLine ? "pending" : "offline" });
  if (navigator.onLine) await syncPendingRecords({ force: true });
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
