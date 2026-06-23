import { useMemo, useState, type ChangeEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Database, FileJson, ShieldAlert, UploadCloud } from "lucide-react";
import { useAuth } from "../../auth/AuthProvider";
import { fetchAdminWorkspaces, importMigrationData, validateMigrationImport, type MigrationImportIssue, type MigrationImportSummary } from "../../lib/api";
import { formatMoney } from "../../lib/format";

function SummaryGrid({ summary }: { summary: MigrationImportSummary }) {
  const countRows = Object.entries(summary.counts);
  const androidRows = Object.entries(summary.androidCounts ?? {});
  const mappedRows = summary.mappedCounts ?? [];
  const importRows = summary.importCounts ?? [];
  return (
    <div className="migration-summary">
      <article><span>Source</span><strong>{summary.source ?? "-"}</strong></article>
      <article><span>Export version</span><strong>{summary.exportVersion ?? "-"}</strong></article>
      <article><span>Exported at</span><strong>{summary.exportedAt ?? "-"}</strong></article>
      <article><span>Vouchers</span><strong>{summary.voucherCount}</strong></article>
      <article><span>Voucher items</span><strong>{summary.voucherItemCount}</strong></article>
      <article><span>Total expenses</span><strong>{formatMoney(summary.totalExpenses)}</strong></article>
      <article><span>Total advances</span><strong>{formatMoney(summary.totalAdvances)}</strong></article>
      <article><span>Total sales</span><strong>{formatMoney(summary.totalSales)}</strong></article>
      <article className="migration-summary__wide"><span>Android source counts</span><p>{androidRows.map(([key, value]) => `${key}: ${value}`).join(" · ")}</p></article>
      <article className="migration-summary__wide"><span>Android → PWA mapping</span><p>{mappedRows.map((item) => `${item.androidKey} → ${item.pwaKey}: ${item.count}`).join(" · ")}</p></article>
      <article className="migration-summary__wide"><span>Import counts</span><p>{importRows.map((item) => `${item.label}: ${item.count}`).join(" · ")}</p></article>
      <article className="migration-summary__wide"><span>Record counts</span><p>{countRows.map(([key, value]) => `${key}: ${value}`).join(" · ")}</p></article>
    </div>
  );
}

function BalanceList({ title, rows }: { title: string; rows: Array<{ name: string; balance: number }> }) {
  return (
    <section className="migration-balance-list">
      <h3>{title}</h3>
      {!rows.length ? <p className="activity-empty">No balances found in the export.</p> : rows.map((row) => (
        <div key={row.name}>
          <span>{row.name}</span>
          <strong>{formatMoney(row.balance)}</strong>
        </div>
      ))}
    </section>
  );
}

function IssueList({ issues }: { issues: MigrationImportIssue[] }) {
  const errors = issues.filter((issue) => issue.level === "error");
  const warnings = issues.filter((issue) => issue.level === "warning");
  return (
    <section className="migration-issues">
      <h3>Validation issues</h3>
      {!issues.length ? <p className="positive">No validation errors or warnings.</p> : null}
      {errors.length ? <><h4>Errors</h4>{errors.map((issue, index) => <p className="negative" key={`error:${index}`}><b>{issue.path}</b> {issue.message}</p>)}</> : null}
      {warnings.length ? <><h4>Warnings</h4>{warnings.map((issue, index) => <p key={`warning:${index}`}><b>{issue.path}</b> {issue.message}</p>)}</> : null}
    </section>
  );
}

export function MigrationImport() {
  const { token } = useAuth();
  const [workspaceId, setWorkspaceId] = useState("");
  const [fileName, setFileName] = useState("");
  const [payload, setPayload] = useState<unknown>(null);
  const [fileError, setFileError] = useState("");
  const workspaces = useQuery({
    queryKey: ["admin-workspaces"],
    queryFn: () => fetchAdminWorkspaces(token!),
    enabled: Boolean(token),
  });
  const workspaceOptions = workspaces.data?.workspaces ?? [];
  const selectedWorkspace = useMemo(() => workspaceOptions.find((workspace) => workspace.id === workspaceId), [workspaceId, workspaceOptions]);

  const validate = useMutation({
    mutationFn: () => validateMigrationImport(token!, { workspaceId, payload }),
  });
  const runImport = useMutation({
    mutationFn: () => importMigrationData(token!, { workspaceId, payload, dryRun: false, allowDatabaseWrite: true }),
  });

  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setFileError("");
    setPayload(null);
    validate.reset();
    runImport.reset();
    if (!file) return;
    setFileName(file.name);
    if (!file.name.toLowerCase().endsWith(".json")) {
      setFileError("Please select a .json export file.");
      return;
    }
    try {
      setPayload(JSON.parse(await file.text()) as unknown);
    } catch {
      setFileError("The selected file is not valid JSON.");
    }
  };

  const validation = runImport.data ?? validate.data;
  const canValidate = Boolean(token && workspaceId && payload && !validate.isPending);
  const canImport = Boolean(token && workspaceId && payload && validate.data?.canImport && !runImport.isPending);

  return (
    <main className="admin-page migration-page">
      <header className="admin-hero">
        <span className="eyebrow">Admin only</span>
        <h1>Migration Import</h1>
        <p>Validate and import JSON exported from the Android app into a selected PWA workspace for migration testing.</p>
      </header>

      <section className="admin-section-card migration-warning">
        <ShieldAlert size={20} />
        <div>
          <strong>Use a dev database first.</strong>
          <p>Imports are blocked unless you explicitly allow database writes. Keep dry-run enabled until totals reconcile.</p>
        </div>
      </section>

      <section className="admin-section-card migration-form">
        <div className="admin-section-heading">
          <div>
            <h2>Import source</h2>
            <p>Select the target workspace and Android JSON export.</p>
          </div>
        </div>
        <label>
          <span>Target workspace</span>
          <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
            <option value="">Select workspace</option>
            {workspaceOptions.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name} ({workspace.status})</option>)}
          </select>
        </label>
        {selectedWorkspace ? <p className="migration-context">Import target: <b>{selectedWorkspace.name}</b> · {selectedWorkspace.contactEmail}</p> : null}
        <label className="migration-file-picker">
          <FileJson size={18} />
          <span>{fileName || "Choose Android export .json file"}</span>
          <input accept="application/json,.json" type="file" onChange={(event) => void readFile(event)} />
        </label>
        {fileError ? <p className="worker-action-error">{fileError}</p> : null}
        <div className="record-list__actions">
          <button type="button" disabled={!canValidate} onClick={() => validate.mutate()}><UploadCloud size={16} />Validate Import</button>
          {validate.data?.canImport ? <button type="button" disabled={!canImport} onClick={() => runImport.mutate()}><Database size={16} />Import Data</button> : null}
        </div>
        {validate.error ? <p className="worker-action-error">{validate.error instanceof Error ? validate.error.message : "Validation failed."}</p> : null}
        {runImport.error ? <p className="worker-action-error">{runImport.error instanceof Error ? runImport.error.message : "Import failed."}</p> : null}
      </section>

      {validation ? (
        <section className="admin-section-card migration-results">
          <div className="admin-section-heading">
            <div>
              <h2>{runImport.data?.imported ? "Import complete" : "Validation summary"}</h2>
              <p>{runImport.data?.message ?? (validation.canImport ? "Export is ready for dry-run/import." : "Resolve errors before importing.")}</p>
            </div>
          </div>
          <SummaryGrid summary={validation.summary} />
          <div className="migration-balance-grid">
            <BalanceList title="Partner balances" rows={validation.summary.partnerBalances} />
            <BalanceList title="Cash/bank balances" rows={validation.summary.cashBankBalances} />
          </div>
          <IssueList issues={validation.issues} />
          {runImport.data?.result ? (
            <section className="migration-issues">
              <h3>Import summary</h3>
              <p className="positive">Migration imported successfully.</p>
              {runImport.data.result.importCounts.map((item) => <p key={item.key}><b>{item.label}</b> {item.count}</p>)}
              <p><b>Total expenses</b> {formatMoney(runImport.data.result.totalExpenses)}</p>
              <p><b>Total advances</b> {formatMoney(runImport.data.result.totalAdvances)}</p>
              <p><b>Inserted operational records</b> {runImport.data.result.insertedOperationalRecords}</p>
            </section>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}
