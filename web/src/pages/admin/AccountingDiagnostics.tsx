import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../auth/AuthProvider";
import { AccountingDiagnosticsConsole } from "../../components/AccountingDiagnosticsConsole";
import { SubpageHeader } from "../../components/SubpageHeader";
import { fetchAccountingDiagnostics, fetchAdminWorkspaces } from "../../lib/api";
import { formatMoney } from "../../lib/format";

const money = formatMoney;

export function AccountingDiagnostics() {
  const { t } = useTranslation();
  const { token } = useAuth();
  const [workspaceId, setWorkspaceId] = useState("");
  const workspaces = useQuery({
    queryKey: ["admin-workspaces", "accounting-diagnostics"],
    enabled: Boolean(token),
    queryFn: () => fetchAdminWorkspaces(token!),
  });
  const diagnostics = useQuery({
    queryKey: ["accounting-diagnostics", workspaceId],
    enabled: Boolean(token && workspaceId),
    queryFn: () => fetchAccountingDiagnostics(token!, { workspaceId }),
  });

  const workspaceOptions = workspaces.data?.workspaces ?? [];
  const duplicateGroups = diagnostics.data?.duplicateVoucherGroups ?? [];
  const hiddenActive = diagnostics.data?.hiddenActiveVouchers ?? [];
  const hiddenImported = diagnostics.data?.hiddenImportedVouchers ?? [];
  const deleted = diagnostics.data?.deletedVouchers ?? [];
  const stats = diagnostics.data?.voucherStats;

  const summaryRows = useMemo(() => stats ? [
    [t("accountingDiagnostics.activeVouchers"), stats.active],
    [t("accountingDiagnostics.importedActiveVouchers"), stats.importedActive],
    [t("accountingDiagnostics.deletedVouchers"), stats.deleted],
    [t("accountingDiagnostics.visibleInScope"), stats.visibleInSelectedScope],
    [t("accountingDiagnostics.hiddenFromScope"), stats.hiddenFromSelectedScope],
    [t("accountingDiagnostics.hiddenImportedVouchers"), stats.hiddenImportedFromSelectedScope],
  ] : [], [stats, t]);

  const sourceLabel = (imported: boolean) => imported ? t("status.imported") : t("accountingDiagnostics.sourcePwa");

  return <div className="dashboard-page">
    <SubpageHeader title={t("accountingDiagnostics.title")} />
    <main className="subpage module-workspace">
      <section className="record-panel">
        <h2>{t("accountingDiagnostics.workspaceScope")}</h2>
        <p>{t("accountingDiagnostics.scopeDescription")}</p>
        <label>
          <span>{t("accountingDiagnostics.workspaceLabel")}</span>
          <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
            <option value="">{t("accountingDiagnostics.selectWorkspace")}</option>
            {workspaceOptions.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
        </label>
      </section>

      {diagnostics.isLoading && <section className="record-panel"><p>{t("accountingDiagnostics.loading")}</p></section>}
      {diagnostics.error && <section className="record-panel"><p className="error">{diagnostics.error instanceof Error ? diagnostics.error.message : t("accountingDiagnostics.loadFailed")}</p></section>}

      {diagnostics.data && <>
        <AccountingDiagnosticsConsole initialWorkspaceId={workspaceId} />

        <section className="record-panel">
          <h2>{t("accountingDiagnostics.integritySummary")}</h2>
          <div className="record-list">
            {summaryRows.map(([label, value]) => <article key={String(label)} className="account-card-clickable"><strong>{label}</strong><span>{value}</span></article>)}
          </div>
        </section>

        <section className="record-panel">
          <h2>{t("accountingDiagnostics.duplicateTitle")}</h2>
          {!duplicateGroups.length ? <p>{t("accountingDiagnostics.noDuplicates")}</p> : <div className="attendance-import-table-wrap">
            <table className="report-data-table">
              <thead><tr><th>{t("accountingDiagnostics.colVoucher")}</th><th>{t("accountingDiagnostics.colCount")}</th><th>{t("accountingDiagnostics.colSources")}</th><th>{t("accountingDiagnostics.colFarms")}</th><th>{t("accountingDiagnostics.colSeasons")}</th><th>{t("accountingDiagnostics.colRecordIds")}</th></tr></thead>
              <tbody>
                {duplicateGroups.map((group) => <tr key={group.voucherNumber}>
                  <td>{group.voucherNumber}</td>
                  <td>{group.count}</td>
                  <td>{group.sources.join(", ") || "-"}</td>
                  <td>{group.farms.join(", ") || "-"}</td>
                  <td>{group.seasons.join(", ") || "-"}</td>
                  <td>{group.recordIds.join(", ")}</td>
                </tr>)}
              </tbody>
            </table>
          </div>}
        </section>

        <section className="record-panel">
          <h2>{t("accountingDiagnostics.hiddenActiveTitle")}</h2>
          {!hiddenActive.length ? <p>{t("accountingDiagnostics.noHiddenActive")}</p> : <div className="attendance-import-table-wrap">
            <table className="report-data-table">
              <thead><tr><th>{t("accountingDiagnostics.colVoucher")}</th><th>{t("accountingDiagnostics.colDate")}</th><th>{t("accountingDiagnostics.colAmount")}</th><th>{t("accountingDiagnostics.colFarm")}</th><th>{t("accountingDiagnostics.colSeason")}</th><th>{t("accountingDiagnostics.colSource")}</th><th>{t("accountingDiagnostics.colRecordId")}</th></tr></thead>
              <tbody>
                {hiddenActive.map((row) => <tr key={row.id}>
                  <td>{row.voucherNumber}</td>
                  <td>{row.date || "-"}</td>
                  <td>{money(row.amount)}</td>
                  <td>{row.farmId ?? "-"}</td>
                  <td>{row.seasonId ?? "-"}</td>
                  <td>{sourceLabel(row.imported)}</td>
                  <td>{row.id}</td>
                </tr>)}
              </tbody>
            </table>
          </div>}
        </section>

        <section className="record-panel">
          <h2>{t("accountingDiagnostics.deletedTitle")}</h2>
          {!deleted.length ? <p>{t("accountingDiagnostics.noDeleted")}</p> : <div className="attendance-import-table-wrap">
            <table className="report-data-table">
              <thead><tr><th>{t("accountingDiagnostics.colVoucher")}</th><th>{t("accountingDiagnostics.colDate")}</th><th>{t("accountingDiagnostics.colAmount")}</th><th>{t("accountingDiagnostics.colDeletedAt")}</th><th>{t("accountingDiagnostics.colSource")}</th><th>{t("accountingDiagnostics.colRecordId")}</th></tr></thead>
              <tbody>
                {deleted.map((row) => <tr key={row.id}>
                  <td>{row.voucherNumber}</td>
                  <td>{row.date || "-"}</td>
                  <td>{money(row.amount)}</td>
                  <td>{row.deletedAt ?? "-"}</td>
                  <td>{sourceLabel(row.imported)}</td>
                  <td>{row.id}</td>
                </tr>)}
              </tbody>
            </table>
          </div>}
        </section>

        {hiddenImported.length > 0 && <section className="record-panel">
          <h2>{t("accountingDiagnostics.hiddenImportedTitle")}</h2>
          <div className="attendance-import-table-wrap">
            <table className="report-data-table">
              <thead><tr><th>{t("accountingDiagnostics.colVoucher")}</th><th>{t("accountingDiagnostics.colDate")}</th><th>{t("accountingDiagnostics.colAmount")}</th><th>{t("accountingDiagnostics.colOldExpenseId")}</th><th>{t("accountingDiagnostics.colFarm")}</th><th>{t("accountingDiagnostics.colSeason")}</th><th>{t("accountingDiagnostics.colRecordId")}</th></tr></thead>
              <tbody>
                {hiddenImported.map((row) => <tr key={row.id}>
                  <td>{row.voucherNumber}</td>
                  <td>{row.date || "-"}</td>
                  <td>{money(row.amount)}</td>
                  <td>{row.oldExpenseId ?? "-"}</td>
                  <td>{row.farmId ?? "-"}</td>
                  <td>{row.seasonId ?? "-"}</td>
                  <td>{row.id}</td>
                </tr>)}
              </tbody>
            </table>
          </div>
        </section>}
      </>}
    </main>
  </div>;
}
