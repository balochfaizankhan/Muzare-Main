import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../auth/AuthProvider";
import { fetchImportVisibilityAudit } from "../lib/api";
import { formatDate } from "../lib/format";
import { translateRecordType } from "../locales/adminLocalizationBundle";
import { offlineDb } from "../lib/offline-db";
import { isActiveOperationalRecord } from "../lib/operationalRecords";
import { getActiveVouchers } from "../lib/voucherCollections";
import { useSyncState } from "../hooks/useSyncState";

type Props = {
  workspaceId: string;
  title?: string;
};

type ClientCounts = {
  labourers: number;
  attendance: number;
  advances: number;
  vouchers: number;
  sales: number;
  dispatches: number;
  accounts: number;
  downloaded: number;
};

async function countClientData(workspaceId: string, farmId: string | null, seasonId: string | null): Promise<ClientCounts> {
  const filterScoped = <T extends { workspaceId: string; farmId?: string | null; seasonId?: string | null; deletedAt?: string | null }>(rows: T[], options?: { includeGeneralFarmRecords?: boolean }) =>
    rows.filter((row) => row.workspaceId === workspaceId
      && (!farmId || row.farmId === farmId)
      && (!seasonId || row.seasonId === seasonId || (Boolean(options?.includeGeneralFarmRecords) && row.seasonId == null))
      && isActiveOperationalRecord(row));

  const [labourersAll, attendanceAll, advancesAll, vouchersAll, salesAll, dispatchesAll, accountsAll] = await Promise.all([
    offlineDb.labourers.where("workspaceId").equals(workspaceId).toArray(),
    offlineDb.attendance.where("workspaceId").equals(workspaceId).toArray(),
    offlineDb.advances.where("workspaceId").equals(workspaceId).toArray(),
    offlineDb.vouchers.where("workspaceId").equals(workspaceId).toArray(),
    offlineDb.sales.where("workspaceId").equals(workspaceId).toArray(),
    offlineDb.dispatches.where("workspaceId").equals(workspaceId).toArray(),
    offlineDb.accounts.where("workspaceId").equals(workspaceId).toArray(),
  ]);

  const labourers = filterScoped(labourersAll).filter((row) => row.active !== false).length;
  const attendance = filterScoped(attendanceAll).length;
  const advances = filterScoped(advancesAll).length;
  const vouchers = getActiveVouchers(filterScoped(vouchersAll, { includeGeneralFarmRecords: true })).length;
  const sales = filterScoped(salesAll).length;
  const dispatches = filterScoped(dispatchesAll).length;
  const accounts = filterScoped(accountsAll).length;
  return {
    labourers,
    attendance,
    advances,
    vouchers,
    sales,
    dispatches,
    accounts,
    downloaded: labourers + attendance + advances + vouchers + sales + dispatches + accounts,
  };
}

export function ImportVisibilityAuditPanel({ workspaceId, title }: Props) {
  const { t } = useTranslation();
  const { token } = useAuth();
  const sync = useSyncState();
  const audit = useQuery({
    queryKey: ["import-visibility-audit", workspaceId],
    enabled: false,
    queryFn: async () => {
      const server = await fetchImportVisibilityAudit(token!, workspaceId);
      const client = await countClientData(workspaceId, server.context.activeFarmId, server.context.activeSeasonId);
      const serverCounts = new Map(server.server.operationalRecordsByEntity.map((item) => [item.entityType, item.count]));
      const reportVisible = client.attendance + client.advances + client.vouchers + client.sales + client.dispatches;
      return {
        server,
        client,
        ui: {
          workforce: client.labourers,
          attendance: client.attendance,
          expenses: client.vouchers,
          advances: client.advances,
          reports: reportVisible,
        },
        statuses: {
          workforce: { imported: (serverCounts.get("labourer") ?? 0) > 0, synced: client.labourers > 0, visible: client.labourers > 0 },
          attendance: { imported: (serverCounts.get("attendance") ?? 0) > 0, synced: client.attendance > 0, visible: client.attendance > 0 },
          expenses: { imported: (serverCounts.get("voucher") ?? 0) > 0, synced: client.vouchers > 0, visible: client.vouchers > 0 },
          advances: { imported: (serverCounts.get("advance") ?? 0) > 0, synced: client.advances > 0, visible: client.advances > 0 },
          reports: { imported: ((serverCounts.get("attendance") ?? 0) + (serverCounts.get("voucher") ?? 0) + (serverCounts.get("advance") ?? 0) + (serverCounts.get("sale") ?? 0) + (serverCounts.get("dispatch") ?? 0)) > 0, synced: reportVisible > 0, visible: reportVisible > 0 },
        },
      };
    },
  });

  const rows = useMemo(() => audit.data ? [
    [t("systemValues.permissions.workforce"), audit.data.statuses.workforce, audit.data.ui.workforce],
    [t("systemValues.permissions.attendance"), audit.data.statuses.attendance, audit.data.ui.attendance],
    [t("systemValues.permissions.expenses"), audit.data.statuses.expenses, audit.data.ui.expenses],
    [t("systemValues.permissions.advances"), audit.data.statuses.advances, audit.data.ui.advances],
    [t("systemValues.permissions.reports"), audit.data.statuses.reports, audit.data.ui.reports],
  ] : [], [audit.data, t]);

  const lastSyncLabel = sync.lastSyncTime
    ? formatDate(new Date(sync.lastSyncTime), { dateStyle: "medium", timeStyle: "short" })
    : t("importVisibilityAudit.notYetSynced");

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>{title ?? t("importVisibilityAudit.title")}</h2>
          <p>{t("importVisibilityAudit.description")}</p>
        </div>
        <button type="button" className="secondary-button" onClick={() => void audit.refetch()} disabled={audit.isFetching || !token || !workspaceId}>
          {audit.isFetching ? t("importVisibilityAudit.running") : t("importVisibilityAudit.run")}
        </button>
      </div>
      {audit.error ? <p className="error">{audit.error instanceof Error ? audit.error.message : t("importVisibilityAudit.failed")}</p> : null}
      {!audit.data ? <p className="context-message">{t("layout.lastSuccessfulSync", { value: lastSyncLabel })}</p> : null}
      {audit.data ? (
        <div className="migration-issues">
          <h3>{t("importVisibilityAudit.serverImportStatus")}</h3>
          <p><b>{t("importVisibilityAudit.importBatchId")}</b> {audit.data.server.latestImport.batchId ?? "-"}</p>
          <p><b>{t("importVisibilityAudit.sourceFileHash")}</b> {audit.data.server.latestImport.fileHash ?? "-"}</p>
          <p><b>{t("importVisibilityAudit.farmsImported")}</b> {audit.data.server.server.farmsImported}</p>
          <p><b>{t("importVisibilityAudit.seasonsImported")}</b> {audit.data.server.server.seasonsImported}</p>
          <p><b>{t("importVisibilityAudit.operationalRecordsByEntity")}</b> {audit.data.server.server.operationalRecordsByEntity.length ? audit.data.server.server.operationalRecordsByEntity.map((item) => `${translateRecordType(t, item.entityType)}: ${item.count}`).join(" · ") : "-"}</p>
          <p><b>{t("importVisibilityAudit.activeContext")}</b> {audit.data.server.context.activeFarmName ?? t("importVisibilityAudit.noFarm")} · {audit.data.server.context.activeSeasonName ?? t("importVisibilityAudit.noSeason")}</p>
          {audit.data.server.context.contextWarning ? <p className="context-message">{audit.data.server.context.contextWarning}</p> : null}

          <h3>{t("importVisibilityAudit.clientSyncStatus")}</h3>
          <p><b>{t("importVisibilityAudit.lastSyncTime")}</b> {lastSyncLabel}</p>
          <p><b>{t("importVisibilityAudit.recordsDownloaded")}</b> {audit.data.client.downloaded}</p>
          <p><b>{t("importVisibilityAudit.indexedDbCounts")}</b> {t("adminRecordTypes.labourers")}: {audit.data.client.labourers} · {t("adminRecordTypes.attendance")}: {audit.data.client.attendance} · {t("adminRecordTypes.advances")}: {audit.data.client.advances} · {t("adminRecordTypes.vouchers")}: {audit.data.client.vouchers} · {t("adminRecordTypes.sales")}: {audit.data.client.sales} · {t("adminRecordTypes.dispatches")}: {audit.data.client.dispatches} · {t("adminRecordTypes.accounts")}: {audit.data.client.accounts}</p>

          <h3>{t("importVisibilityAudit.uiVisibilityStatus")}</h3>
          <div className="migration-visibility-grid">
            {rows.map(([label, status, count]) => {
              const item = status as { imported: boolean; synced: boolean; visible: boolean };
              return (
                <article key={String(label)} className="migration-visibility-card">
                  <strong>{String(label)}</strong>
                  <span>{t("importVisibilityAudit.visibleCount", { count: Number(count) })}</span>
                  <small>{item.imported ? "✓" : "✗"} {t("importVisibilityAudit.importedToServer")}</small>
                  <small>{item.synced ? "✓" : "✗"} {t("importVisibilityAudit.syncedToDevice")}</small>
                  <small>{item.visible ? "✓" : "✗"} {t("importVisibilityAudit.visibleInModule")}</small>
                </article>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}
