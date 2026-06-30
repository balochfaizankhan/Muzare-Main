import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { SubpageHeader } from "../../components/SubpageHeader";
import { fetchAccountingDiagnostics, fetchAdminWorkspaces } from "../../lib/api";
import { formatMoney } from "../../lib/format";

const money = formatMoney;

export function AccountingDiagnostics() {
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
    ["Active vouchers", stats.active],
    ["Imported active vouchers", stats.importedActive],
    ["Deleted vouchers", stats.deleted],
    ["Visible in selected scope", stats.visibleInSelectedScope],
    ["Hidden from selected scope", stats.hiddenFromSelectedScope],
    ["Hidden imported vouchers", stats.hiddenImportedFromSelectedScope],
  ] : [], [stats]);

  return <div className="dashboard-page">
    <SubpageHeader title="Accounting Diagnostics" />
    <main className="subpage module-workspace">
      <section className="record-panel">
        <h2>Workspace Scope</h2>
        <p>Audit imported vouchers, deleted vouchers, duplicates, and visibility mismatches using the same active-record rules as the expense module.</p>
        <label>
          <span>Workspace</span>
          <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
            <option value="">Select workspace</option>
            {workspaceOptions.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
        </label>
      </section>

      {diagnostics.isLoading && <section className="record-panel"><p>Loading accounting diagnostics...</p></section>}
      {diagnostics.error && <section className="record-panel"><p className="error">{diagnostics.error instanceof Error ? diagnostics.error.message : "Unable to load accounting diagnostics."}</p></section>}

      {diagnostics.data && <>
        <section className="record-panel">
          <h2>Voucher Integrity Summary</h2>
          <div className="record-list">
            {summaryRows.map(([label, value]) => <article key={String(label)} className="account-card-clickable"><strong>{label}</strong><span>{value}</span></article>)}
          </div>
        </section>

        <section className="record-panel">
          <h2>Duplicate Voucher Numbers</h2>
          {!duplicateGroups.length ? <p>No duplicate active voucher numbers found.</p> : <div className="attendance-import-table-wrap">
            <table className="report-data-table">
              <thead><tr><th>Voucher</th><th>Count</th><th>Sources</th><th>Farms</th><th>Seasons</th><th>Record IDs</th></tr></thead>
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
          <h2>Hidden Active Vouchers</h2>
          {!hiddenActive.length ? <p>No hidden active vouchers detected for this scope.</p> : <div className="attendance-import-table-wrap">
            <table className="report-data-table">
              <thead><tr><th>Voucher</th><th>Date</th><th>Amount</th><th>Farm</th><th>Season</th><th>Source</th><th>Record ID</th></tr></thead>
              <tbody>
                {hiddenActive.map((row) => <tr key={row.id}>
                  <td>{row.voucherNumber}</td>
                  <td>{row.date || "-"}</td>
                  <td>{money(row.amount)}</td>
                  <td>{row.farmId ?? "-"}</td>
                  <td>{row.seasonId ?? "-"}</td>
                  <td>{row.imported ? "Imported" : "PWA"}</td>
                  <td>{row.id}</td>
                </tr>)}
              </tbody>
            </table>
          </div>}
        </section>

        <section className="record-panel">
          <h2>Deleted / Voided Vouchers</h2>
          {!deleted.length ? <p>No deleted or voided vouchers found.</p> : <div className="attendance-import-table-wrap">
            <table className="report-data-table">
              <thead><tr><th>Voucher</th><th>Date</th><th>Amount</th><th>Deleted At</th><th>Source</th><th>Record ID</th></tr></thead>
              <tbody>
                {deleted.map((row) => <tr key={row.id}>
                  <td>{row.voucherNumber}</td>
                  <td>{row.date || "-"}</td>
                  <td>{money(row.amount)}</td>
                  <td>{row.deletedAt ?? "-"}</td>
                  <td>{row.imported ? "Imported" : "PWA"}</td>
                  <td>{row.id}</td>
                </tr>)}
              </tbody>
            </table>
          </div>}
        </section>

        {hiddenImported.length > 0 && <section className="record-panel">
          <h2>Hidden Imported Vouchers</h2>
          <div className="attendance-import-table-wrap">
            <table className="report-data-table">
              <thead><tr><th>Voucher</th><th>Date</th><th>Amount</th><th>Old Expense ID</th><th>Farm</th><th>Season</th><th>Record ID</th></tr></thead>
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
