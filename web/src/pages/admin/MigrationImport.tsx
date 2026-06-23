import { useMemo, useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, FileJson, ShieldAlert, UploadCloud } from "lucide-react";
import { useAuth } from "../../auth/AuthProvider";
import { fetchAdminWorkspaces, fetchMigrationImportHistory, importMigrationData, repairMigrationImportVisibility, validateMigrationImport, type MigrationImportHistoryRecord, type MigrationImportIssue, type MigrationImportLogEntry, type MigrationImportSummary } from "../../lib/api";
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
  const [showDetails, setShowDetails] = useState(false);
  const errors = issues.filter((issue) => issue.level === "error");
  const warnings = issues.filter((issue) => issue.level === "warning");
  const warningSummaries = [...warnings.reduce((map, issue) => {
    const current = map.get(issue.message);
    if (current) {
      current.count += 1;
      current.paths.push(issue.path);
    } else {
      map.set(issue.message, { count: 1, paths: [issue.path], message: issue.message });
    }
    return map;
  }, new Map<string, { count: number; paths: string[]; message: string }>()).values()];
  const visibleErrors = showDetails ? errors : errors.slice(0, 12);
  const visibleWarnings = showDetails ? warnings : [];
  return (
    <section className="migration-issues">
      <h3>Validation issues</h3>
      {!issues.length ? <p className="positive">No validation errors or warnings.</p> : null}
      {errors.length ? <><h4>Critical issues</h4>{visibleErrors.map((issue, index) => <p className="negative" key={`error:${index}`}><b>{issue.path}</b> {issue.message}</p>)}</> : null}
      {errors.length > visibleErrors.length ? <p>{errors.length - visibleErrors.length} more errors hidden. Use Show details to inspect all rows.</p> : null}
      {warningSummaries.length ? (
        <>
          <h4>Warnings summary</h4>
          {warningSummaries.slice(0, showDetails ? warningSummaries.length : 12).map((item, index) => (
            <p key={`warning-summary:${index}`}>
              <b>{item.count > 1 ? `${item.count} warnings` : item.paths[0]}</b> {item.message}
            </p>
          ))}
        </>
      ) : null}
      {visibleWarnings.length ? <><h4>Warning details</h4>{visibleWarnings.map((issue, index) => <p key={`warning:${index}`}><b>{issue.path}</b> {issue.message}</p>)}</> : null}
      {issues.length > 0 ? (
        <button type="button" className="secondary-button" onClick={() => setShowDetails((value) => !value)}>
          {showDetails ? "Hide details" : "Show details"}
        </button>
      ) : null}
    </section>
  );
}

const readLogDetails = (record: MigrationImportHistoryRecord) => {
  const details = record.details && typeof record.details === "object" ? record.details as Partial<MigrationImportLogEntry> & { importBatchId?: string } : {};
  return {
    batch: details.importBatchId ?? "-",
    step: details.step ?? record.action,
    status: details.status ?? record.action.replace("admin.migration_import.", ""),
    message: details.message ?? "",
    importedRows: details.importedRows,
    failedRows: details.failedRows,
  };
};

function ImportHistory({ records }: { records: MigrationImportHistoryRecord[] }) {
  return (
    <section className="migration-issues">
      <h3>Import history</h3>
      {!records.length ? <p className="activity-empty">No migration import logs for this workspace yet.</p> : null}
      {records.slice(0, 18).map((record) => {
        const details = readLogDetails(record);
        return (
          <p key={record.id} className={details.status === "failed" ? "negative" : undefined}>
            <b>{details.step}</b> {details.status} · {new Date(record.createdAt).toLocaleString()}
            {typeof details.importedRows === "number" ? ` · imported ${details.importedRows}` : ""}
            {typeof details.failedRows === "number" ? ` · failed ${details.failedRows}` : ""}
            {details.message ? ` · ${details.message}` : ""}
          </p>
        );
      })}
    </section>
  );
}

export function MigrationImport() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
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
  const history = useQuery({
    queryKey: ["admin-migration-import-history", workspaceId],
    queryFn: () => fetchMigrationImportHistory(token!, workspaceId),
    enabled: Boolean(token && workspaceId),
  });
  const refreshAfterImport = () => {
    void queryClient.invalidateQueries();
  };
  const runImport = useMutation({
    mutationFn: () => importMigrationData(token!, { workspaceId, payload, dryRun: false, allowDatabaseWrite: true }),
    onSuccess: refreshAfterImport,
  });
  const repairVisibility = useMutation({
    mutationFn: () => repairMigrationImportVisibility(token!, { workspaceId }),
    onSuccess: refreshAfterImport,
  });

  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setFileError("");
    setPayload(null);
    validate.reset();
    runImport.reset();
    repairVisibility.reset();
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
          <select value={workspaceId} onChange={(event) => {
            setWorkspaceId(event.target.value);
            repairVisibility.reset();
          }}>
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
          <button type="button" className="secondary-button" disabled={!token || !workspaceId || repairVisibility.isPending} onClick={() => repairVisibility.mutate()}>
            Repair previous import visibility
          </button>
        </div>
        {validate.error ? <p className="worker-action-error">{validate.error instanceof Error ? validate.error.message : "Validation failed."}</p> : null}
        {runImport.error ? <p className="worker-action-error">{runImport.error instanceof Error ? runImport.error.message : "Import failed."}</p> : null}
        {repairVisibility.error ? <p className="worker-action-error">{repairVisibility.error instanceof Error ? repairVisibility.error.message : "Visibility repair failed."}</p> : null}
        {repairVisibility.data ? <p className="positive">{repairVisibility.data.message} Repaired records: {repairVisibility.data.repairedRecords}.</p> : null}
      </section>

      {workspaceId ? <ImportHistory records={history.data?.records ?? []} /> : null}

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
              {runImport.data.result.farmImportStats ? (
                <p>
                  <b>Farm import</b>{" "}
                  created {runImport.data.result.farmImportStats.created}, updated {runImport.data.result.farmImportStats.updated}, skipped duplicates {runImport.data.result.farmImportStats.skippedDuplicates}
                </p>
              ) : null}
              <p><b>Total expenses</b> {formatMoney(runImport.data.result.totalExpenses)}</p>
              <p><b>Total advances</b> {formatMoney(runImport.data.result.totalAdvances)}</p>
              <p><b>Inserted operational records</b> {runImport.data.result.insertedOperationalRecords}</p>
              {runImport.data.result.currentStep ? <p><b>Current step</b> {runImport.data.result.currentStep}</p> : null}
              {typeof runImport.data.result.failedRows === "number" ? <p><b>Failed/skipped rows</b> {runImport.data.result.failedRows}</p> : null}
              {runImport.data.result.startedAt ? <p><b>Started at</b> {new Date(runImport.data.result.startedAt).toLocaleString()}</p> : null}
              {runImport.data.result.completedAt ? <p><b>Completed at</b> {new Date(runImport.data.result.completedAt).toLocaleString()}</p> : null}
              {runImport.data.result.activeFarmId && runImport.data.result.activeSeasonId ? (
                <p><b>Active import context</b> Farm {runImport.data.result.activeFarmId} · Season {runImport.data.result.activeSeasonId}</p>
              ) : null}
              {runImport.data.result.logs?.length ? (
                <div>
                  <h4>Step log</h4>
                  {runImport.data.result.logs.map((item, index) => (
                    <p key={`${item.step}:${item.status}:${index}`}>
                      <b>{item.step}</b> {item.status}
                      {typeof item.importedRows === "number" ? ` · imported ${item.importedRows}` : ""}
                      {typeof item.failedRows === "number" ? ` · failed ${item.failedRows}` : ""}
                      {item.message ? ` · ${item.message}` : ""}
                    </p>
                  ))}
                </div>
              ) : null}
              <div className="record-list__actions">
                <button type="button" className="secondary-button" disabled={repairVisibility.isPending} onClick={() => repairVisibility.mutate()}>
                  Set imported farm active
                </button>
                <button type="button" className="secondary-button" disabled={repairVisibility.isPending} onClick={() => repairVisibility.mutate()}>
                  Set imported season active
                </button>
                <a className="secondary-button" href="/workspace/farms">View Imported Data</a>
                <a className="secondary-button" href="/workspace/farms">View farms</a>
                <a className="secondary-button" href="/workspace/seasons">View season</a>
                <a className="secondary-button" href="/workforce">View Labour</a>
                <a className="secondary-button" href="/expenses">View Expenses</a>
                <a className="secondary-button" href="/advances">View Advances</a>
                <a className="secondary-button" href="/reports?section=attendance">View attendance report</a>
              </div>
            </section>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}
