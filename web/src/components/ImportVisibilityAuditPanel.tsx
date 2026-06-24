import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../auth/AuthProvider";
import { fetchImportVisibilityAudit } from "../lib/api";
import { offlineDb } from "../lib/offline-db";
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
      && !row.deletedAt);

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
  const vouchers = filterScoped(vouchersAll, { includeGeneralFarmRecords: true }).length;
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
    ["Workforce", audit.data.statuses.workforce, audit.data.ui.workforce],
    ["Attendance", audit.data.statuses.attendance, audit.data.ui.attendance],
    ["Expenses", audit.data.statuses.expenses, audit.data.ui.expenses],
    ["Advances", audit.data.statuses.advances, audit.data.ui.advances],
    ["Reports", audit.data.statuses.reports, audit.data.ui.reports],
  ] : [], [audit.data]);

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>{title ?? "Import Visibility Audit"}</h2>
          <p>Identify whether a visibility issue is caused by import, sync, IndexedDB hydration, or active farm/season context.</p>
        </div>
        <button type="button" className="secondary-button" onClick={() => void audit.refetch()} disabled={audit.isFetching || !token || !workspaceId}>
          {audit.isFetching ? "Running..." : "Run Visibility Audit"}
        </button>
      </div>
      {audit.error ? <p className="error">{audit.error instanceof Error ? audit.error.message : "Unable to run visibility audit."}</p> : null}
      {!audit.data ? <p className="context-message">{t("layout.lastSuccessfulSync", { value: sync.lastSyncTime ? new Date(sync.lastSyncTime).toLocaleString() : "Not yet synchronized" })}</p> : null}
      {audit.data ? (
        <div className="migration-issues">
          <h3>Server Import Status</h3>
          <p><b>Import batch id</b> {audit.data.server.latestImport.batchId ?? "-"}</p>
          <p><b>Source file hash</b> {audit.data.server.latestImport.fileHash ?? "-"}</p>
          <p><b>Farms imported</b> {audit.data.server.server.farmsImported}</p>
          <p><b>Seasons imported</b> {audit.data.server.server.seasonsImported}</p>
          <p><b>Operational records by entity</b> {audit.data.server.server.operationalRecordsByEntity.length ? audit.data.server.server.operationalRecordsByEntity.map((item) => `${item.entityType}: ${item.count}`).join(" · ") : "-"}</p>
          <p><b>Active context</b> {audit.data.server.context.activeFarmName ?? "No farm"} · {audit.data.server.context.activeSeasonName ?? "No season"}</p>
          {audit.data.server.context.contextWarning ? <p className="context-message">{audit.data.server.context.contextWarning}</p> : null}

          <h3>Client Sync Status</h3>
          <p><b>Last sync time</b> {sync.lastSyncTime ? new Date(sync.lastSyncTime).toLocaleString() : "Not yet synchronized"}</p>
          <p><b>Operational records downloaded</b> {audit.data.client.downloaded}</p>
          <p><b>IndexedDB counts</b> labourers: {audit.data.client.labourers} · attendance: {audit.data.client.attendance} · advances: {audit.data.client.advances} · vouchers: {audit.data.client.vouchers} · sales: {audit.data.client.sales} · dispatches: {audit.data.client.dispatches} · accounts: {audit.data.client.accounts}</p>

          <h3>UI Visibility Status</h3>
          <div className="migration-visibility-grid">
            {rows.map(([label, status, count]) => {
              const item = status as { imported: boolean; synced: boolean; visible: boolean };
              return (
                <article key={String(label)} className="migration-visibility-card">
                  <strong>{String(label)}</strong>
                  <span>Visible count: {String(count)}</span>
                  <small>{item.imported ? "✓" : "✗"} Imported to server</small>
                  <small>{item.synced ? "✓" : "✗"} Synced to device</small>
                  <small>{item.visible ? "✓" : "✗"} Visible in module</small>
                </article>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}
