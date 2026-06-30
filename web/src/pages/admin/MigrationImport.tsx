import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Database, FileJson, UploadCloud } from "lucide-react";
import { Link } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { ImportVisibilityAuditPanel } from "../../components/ImportVisibilityAuditPanel";
import { cancelAndCleanMigrationImport, downloadMigrationImportFailures, fetchActiveMigrationImportJob, fetchAdminWorkspaces, fetchMigrationImportBatches, fetchMigrationImportCleanupPreview, fetchMigrationImportHistory, fetchMigrationImportJobStatus, fetchMigrationImportProgress, fetchWorkspaceImportContextRepairPreview, importMigrationData, repairDeletedFarmSeasonState, repairDuplicateImportedAccounts, repairImportedVoucherNumbers, repairMigrationImportVisibility, repairWorkspaceImportContext, validateMigrationImport, type MigrationImportBatchRecord, type MigrationImportHistoryRecord, type MigrationImportIssue, type MigrationImportJobDetail, type MigrationImportLogEntry, type MigrationImportProgress, type MigrationImportSummary, type WorkspaceImportContextPreview } from "../../lib/api";
import { formatMoney } from "../../lib/format";
import { clearCachedData } from "../../lib/offline-db";

type StepStatus = "done" | "running" | "waiting" | "failed";

function formatApiError(error: unknown, fallback: string) {
  if (!error) return fallback;
  if (typeof error === "object" && error !== null && "status" in error && "message" in error) {
    const status = String((error as { status?: number }).status ?? "");
    const message = String((error as { message?: string }).message ?? fallback);
    return status ? `HTTP ${status}: ${message}` : message;
  }
  if (error instanceof Error) return error.message;
  return fallback;
}

function buildCleanupStartingProgress(batchId: string): MigrationImportProgress {
  const now = new Date().toISOString();
  return {
    batchId,
    status: "running",
    stage: "Starting cleanup...",
    step: "Stopping import worker",
    percentage: 5,
    message: "Starting cleanup...",
    startedAt: now,
    updatedAt: now,
    elapsedSeconds: 0,
    estimatedRemainingSeconds: null,
    completedSteps: 0,
    totalSteps: 9,
    processedCount: 0,
    totalCount: 0,
    importedCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    failedCount: 0,
  };
}

function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const label = normalized === "in_progress"
    ? "Importing"
    : normalized === "partial_failed"
      ? "Failed"
      : normalized === "queued"
        ? "Importing"
        : normalized.charAt(0).toUpperCase() + normalized.slice(1).replace(/_/g, " ");
  return <span className={`migration-status-badge migration-status-badge--${normalized}`}>{label}</span>;
}

function SummaryGrid({ summary }: { summary: MigrationImportSummary }) {
  const cards = [
    ["Farms", summary.counts.farms ?? 0],
    ["Seasons", summary.counts.seasons ?? 0],
    ["Labour", summary.counts.labour ?? summary.counts.labours ?? 0],
    ["Attendance", summary.counts.attendance ?? 0],
    ["Expenses", summary.counts.expenses ?? 0],
    ["Expense items", summary.counts.expenseItems ?? 0],
    ["Accounts", summary.counts.accounts ?? 0],
    ["Partners", summary.counts.partners ?? 0],
  ] as const;
  return (
    <div className="migration-summary">
      {cards.map(([label, value]) => (
        <article key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </article>
      ))}
      <article><span>Export version</span><strong>{summary.exportVersion ?? "-"}</strong></article>
      <article><span>Exported at</span><strong>{summary.exportedAt ? new Date(summary.exportedAt).toLocaleString() : "-"}</strong></article>
      <article><span>Total expenses</span><strong>{formatMoney(summary.totalExpenses)}</strong></article>
      <article><span>Total advances</span><strong>{formatMoney(summary.totalAdvances)}</strong></article>
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

function JobErrorPanel({ detail, onDownloadFailures }: { detail: MigrationImportJobDetail; onDownloadFailures: () => void }) {
  const lastSuccessfulStep = [...detail.steps].reverse().find((step) => step.status === "completed")?.name ?? "-";
  return (
    <section className="admin-section-card migration-issues">
      <h2>Import Failure</h2>
      <p className="worker-action-error">{detail.error || detail.message || detail.firstFailureMessage || "Import failed."}</p>
      <p><b>Job ID</b> {detail.jobId}</p>
      <p><b>Current step</b> {detail.currentStep}</p>
      <p><b>Last successful step</b> {lastSuccessfulStep}</p>
      <p><b>Imported</b> {detail.importedRows} · <b>Updated</b> {detail.updatedRows} · <b>Skipped</b> {detail.skippedRows} · <b>Failed</b> {detail.failedRows}</p>
      <div className="record-list__actions">
        <button type="button" className="secondary-button" onClick={onDownloadFailures}>Download failure CSV</button>
      </div>
      {detail.failures.slice(0, 10).map((failure) => (
        <p key={failure.id}>
          <b>{failure.step}</b> {failure.sourceRow ? `· row ${failure.sourceRow}` : ""} · {failure.errorMessage}
        </p>
      ))}
    </section>
  );
}

function IssueList({ issues }: { issues: MigrationImportIssue[] }) {
  const [showDetails, setShowDetails] = useState(false);
  const errors = issues.filter((issue) => issue.level === "error");
  const warnings = issues.filter((issue) => issue.level === "warning");
  return (
    <section className="migration-issues">
      <h3>Validation Warnings</h3>
      {!issues.length ? <p className="positive">No validation errors or warnings.</p> : null}
      {errors.length ? (
        <div className="migration-callout migration-callout--error">
          <strong>Validation failed</strong>
          <p>{errors[0]?.message ?? "Import validation failed."}</p>
        </div>
      ) : null}
      {warnings.length ? (
        <div className="migration-callout migration-callout--warning">
          <strong>{warnings.length} warning{warnings.length === 1 ? "" : "s"}</strong>
          <p>Warnings were detected. Review the details before importing.</p>
        </div>
      ) : null}
      {issues.length > 0 ? (
        <button type="button" className="secondary-button" onClick={() => setShowDetails((value) => !value)}>
          {showDetails ? "Hide details" : "Show details"}
        </button>
      ) : null}
      {showDetails ? (
        <div className="migration-detail-list">
          {issues.map((issue, index) => <p className={issue.level === "error" ? "negative" : undefined} key={`${issue.level}:${issue.path}:${index}`}><b>{issue.path}</b> {issue.message}</p>)}
        </div>
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
    sourceRows: details.sourceRows,
    importedRows: details.importedRows,
    updatedRows: details.updatedRows,
    skippedRows: details.skippedRows,
    failedRows: details.failedRows,
  };
};

function StepTimeline({ title, rows }: { title: string; rows: Array<{ label: string; status: StepStatus; detail?: string }> }) {
  return (
    <section className="migration-step-timeline">
      <h3>{title}</h3>
      <div className="migration-stage-list">
        {rows.map((row) => (
          <article key={row.label} className={`migration-stage-row migration-stage-row--${row.status}`}>
            <div>
              <strong>{row.label}</strong>
              {row.detail ? <p>{row.detail}</p> : null}
            </div>
            <span>{row.status === "done" ? "Done" : row.status === "running" ? "Running" : row.status === "failed" ? "Failed" : "Waiting"}</span>
          </article>
        ))}
      </div>
    </section>
  );
}

function ProgressCard({ progress, stageRows, isCleanup }: { progress: MigrationImportProgress; stageRows: Array<{ label: string; status: StepStatus; detail?: string }>; isCleanup: boolean }) {
  const staleSeconds = Math.max(0, Math.round((Date.now() - new Date(progress.updatedAt).getTime()) / 1000));
  const appearsStuck = progress.status === "running" && staleSeconds > 300;
  return (
    <section className="admin-section-card migration-progress-card">
      <div className="admin-section-heading">
        <div>
          <h2>Step 3 - {isCleanup ? "Cleanup Progress" : "Live Import Progress"}</h2>
          <p>{progress.message || (isCleanup ? "Cleaning the selected import batch." : "Importing Android data into the selected workspace.")}</p>
        </div>
        <StatusBadge status={appearsStuck ? "stuck" : progress.status} />
      </div>
      <div className="migration-progress-meta">
        <div className="migration-progress-bar" aria-hidden="true"><div style={{ width: `${Math.max(0, Math.min(100, progress.percentage))}%` }} /></div>
        <div className="migration-progress-stats">
          <article><span>Progress</span><strong>{progress.percentage}%</strong></article>
          <article><span>Current stage</span><strong>{progress.stage || "-"}</strong></article>
          <article><span>Current task</span><strong>{progress.step || "-"}</strong></article>
          <article><span>Processed</span><strong>{progress.processedCount} / {progress.totalCount || "-"}</strong></article>
          <article><span>Elapsed</span><strong>{progress.elapsedSeconds}s</strong></article>
          <article><span>Last updated</span><strong>{new Date(progress.updatedAt).toLocaleTimeString()}</strong></article>
        </div>
      </div>
      <StepTimeline title="Stages" rows={stageRows} />
      {appearsStuck ? <p className="worker-action-error">This import appears stuck.</p> : null}
    </section>
  );
}

function ResultCard({ validation, importResult, onReset }: { validation: Awaited<ReturnType<typeof validateMigrationImport>> | undefined; importResult: Awaited<ReturnType<typeof importMigrationData>> | undefined; onReset: () => void }) {
  if (!validation) return null;
  const result = importResult?.result;
  const audit = result?.postImportAudit;
  return (
    <section className="admin-section-card migration-results">
      <div className="admin-section-heading">
        <div>
          <h2>Step 4 - {result ? "Import Result" : "Validation Result"}</h2>
          <p>{result ? "Import completed. Review the result summary below." : validation.canImport ? "Validation passed. You can proceed with import." : "Validation finished with issues that need review."}</p>
        </div>
        {result ? <StatusBadge status="completed" /> : <StatusBadge status={validation.canImport ? "ready" : "failed"} />}
      </div>
      <SummaryGrid summary={validation.summary} />
      <div className="migration-balance-grid">
        <BalanceList title="Partner balances" rows={validation.summary.partnerBalances} />
        <BalanceList title="Cash / bank balances" rows={validation.summary.cashBankBalances} />
      </div>
      <IssueList issues={validation.issues} />
      {result ? (
        <div className="migration-result-grid">
          <article><span>Duration</span><strong>{result.startedAt && result.completedAt ? `${Math.max(1, Math.round((new Date(result.completedAt).getTime() - new Date(result.startedAt).getTime()) / 1000))}s` : "-"}</strong></article>
          <article><span>Imported rows</span><strong>{result.importCounts.reduce((sum, item) => sum + item.count, 0)}</strong></article>
          <article><span>Updated rows</span><strong>{result.logs?.reduce((sum, item) => sum + (item.updatedRows ?? 0), 0) ?? 0}</strong></article>
          <article><span>Warnings</span><strong>{validation.issues.filter((issue) => issue.level === "warning").length}</strong></article>
          <article><span>Failures</span><strong>{typeof result.failedRows === "number" ? result.failedRows : 0}</strong></article>
          <article><span>Inserted operational records</span><strong>{result.insertedOperationalRecords}</strong></article>
          {result.importCounts.map((item) => <article key={item.key}><span>{item.label}</span><strong>{item.count}</strong></article>)}
        </div>
      ) : null}
      {audit ? (
        <section className="migration-issues">
          <h3>Audit Summary</h3>
          <p><b>Voucher number audit</b> mismatches {audit.voucherNumberAudit.mismatches.length} · duplicates {audit.voucherNumberAudit.duplicateImportedVoucherNumbers.length}</p>
          <p><b>Relationship audit</b> attendance linked {audit.relationshipAudit.attendanceLinkedToLabour}/{audit.relationshipAudit.attendanceTotal} · advances linked to labour {audit.relationshipAudit.advancesLinkedToLabour}/{audit.relationshipAudit.advancesTotal} · vouchers linked to payment account {audit.relationshipAudit.vouchersLinkedToPaymentAccount}/{audit.relationshipAudit.vouchersTotal}</p>
          <p><b>Visibility audit</b> farms {audit.tableCounts.farms} · seasons {audit.tableCounts.seasons} · failed batches {audit.tableCounts.failedOrPartialBatches}</p>
        </section>
      ) : null}
      {result ? (
        <div className="record-list__actions">
          <Link className="secondary-button" to={result.attendanceJobId ? `/admin/imports/${result.attendanceJobId}` : "#"}>View full report</Link>
          <button type="button" className="secondary-button" onClick={onReset}>Import another file</button>
        </div>
      ) : null}
    </section>
  );
}

function HistoryTable({
  batches,
  records,
  selectedBatchId,
  onSelectBatch,
  workspaceLabel,
}: {
  batches: MigrationImportBatchRecord[];
  records: MigrationImportHistoryRecord[];
  selectedBatchId: string | null;
  onSelectBatch: (batchId: string | null) => void;
  workspaceLabel: string;
}) {
  const historyByBatch = records.reduce<Map<string, MigrationImportHistoryRecord[]>>((map, record) => {
    const batch = readLogDetails(record).batch;
    map.set(batch, [...(map.get(batch) ?? []), record]);
    return map;
  }, new Map());
  const selectedRecords = selectedBatchId ? historyByBatch.get(selectedBatchId) ?? [] : [];
  return (
    <section className="admin-section-card migration-history-card">
      <div className="admin-section-heading">
        <div>
          <h2>Step 6 - Import History</h2>
          <p>Recent import batches and their status.</p>
        </div>
      </div>
      {!batches.length ? <p className="activity-empty">No migration import history for this workspace yet.</p> : null}
      {batches.length ? (
        <div className="migration-history-table-wrap">
          <table className="migration-history-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>File</th>
                <th>Workspace</th>
                <th>Status</th>
                <th>Duration</th>
                <th>Summary</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {batches.slice(0, 12).map((batch) => {
                const duration = batch.completedAt ? `${Math.max(1, Math.round((new Date(batch.completedAt).getTime() - new Date(batch.startedAt).getTime()) / 1000))}s` : "-";
                return (
                  <tr key={batch.id}>
                    <td>{new Date(batch.startedAt).toLocaleString()}</td>
                    <td title={batch.fileName ?? "Imported JSON"}>{batch.fileName ?? "Imported JSON"}</td>
                    <td>{workspaceLabel}</td>
                    <td><StatusBadge status={batch.status} /></td>
                    <td>{duration}</td>
                    <td>{batch.fileHash.slice(0, 10)}... · updated {new Date(batch.updatedAt).toLocaleTimeString()}</td>
                    <td><button type="button" className="secondary-button" onClick={() => onSelectBatch(selectedBatchId === batch.id ? null : batch.id)}>View details</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {selectedBatchId ? (
        <div className="migration-history-drawer">
          <div className="migration-history-drawer__header">
            <div>
              <h3>Batch Details</h3>
              <p>{selectedBatchId}</p>
            </div>
            <button type="button" className="secondary-button" onClick={() => onSelectBatch(null)}>Close</button>
          </div>
          {!selectedRecords.length ? <p className="activity-empty">No detailed log entries found for this batch.</p> : null}
          {selectedRecords.map((record) => {
            const details = readLogDetails(record);
            return (
              <p key={record.id} className={details.status === "failed" ? "negative" : undefined}>
                <b>{details.step}</b> {details.status}
                {typeof details.sourceRows === "number" ? ` · source ${details.sourceRows}` : ""}
                {typeof details.importedRows === "number" ? ` · imported ${details.importedRows}` : ""}
                {typeof details.updatedRows === "number" ? ` · updated ${details.updatedRows}` : ""}
                {typeof details.skippedRows === "number" ? ` · skipped ${details.skippedRows}` : ""}
                {typeof details.failedRows === "number" ? ` · failed ${details.failedRows}` : ""}
                {details.message ? ` · ${details.message}` : ""}
              </p>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function ImportContextRepairPreviewCard({
  preview,
  backupConfirmed,
  onBackupConfirmed,
  repairResult,
}: {
  preview: WorkspaceImportContextPreview;
  backupConfirmed: boolean;
  onBackupConfirmed: (value: boolean) => void;
  repairResult: { repairedByEntity: Array<{ entityType: string; count: number }>; duplicateActiveVoucherNumbersAfter: Array<{ voucherNumber: string }>; voucherNumberMismatchesAfter: number } | null;
}) {
  return (
    <section className="migration-callout">
      <div className="admin-section-heading">
        <div>
          <h3>Repair Workspace Import Context</h3>
          <p>Preview the canonical farm/season remap before changing imported records.</p>
        </div>
      </div>
      <div className="migration-result-grid">
        <article><span>Canonical farm</span><strong>{preview.canonicalFarm ? `${preview.canonicalFarm.name}` : "None"}</strong></article>
        <article><span>Canonical season</span><strong>{preview.canonicalSeason ? `${preview.canonicalSeason.name}` : "Will create fallback"}</strong></article>
        <article><span>Old farms found</span><strong>{preview.oldFarms.length}</strong></article>
        <article><span>Old seasons found</span><strong>{preview.oldSeasons.length}</strong></article>
        <article><span>Voucher mismatches before</span><strong>{preview.voucherNumberMismatchesBefore}</strong></article>
        <article><span>Deleted vouchers excluded</span><strong>{preview.deletedRecordsExcludedCount}</strong></article>
      </div>
      {preview.recordsRemapPreview.length ? (
        <div className="attendance-import-table-wrap">
          <table className="attendance-import-table">
            <thead><tr><th>Entity</th><th>Records to remap</th></tr></thead>
            <tbody>{preview.recordsRemapPreview.map((row) => <tr key={row.entityType}><td>{row.entityType}</td><td>{row.count}</td></tr>)}</tbody>
          </table>
        </div>
      ) : <p>No imported operational records need farm/season remapping.</p>}
      {preview.oldFarms.length ? <p className="migration-context"><b>Old farms:</b> {preview.oldFarms.map((farm) => `${farm.name} [${farm.reasons.join(", ")}]`).join(" • ")}</p> : null}
      {preview.oldSeasons.length ? <p className="migration-context"><b>Old seasons:</b> {preview.oldSeasons.map((season) => `${season.name} [${season.reasons.join(", ")}]`).join(" • ")}</p> : null}
      {preview.duplicateActiveVoucherNumbersProjected.length ? <p className="worker-action-error">Projected duplicate active voucher numbers after remap: {preview.duplicateActiveVoucherNumbersProjected.map((group) => group.voucherNumber).join(", ")}. These will be left for manual resolution.</p> : null}
      <label className="inline-checkbox">
        <input type="checkbox" checked={backupConfirmed} onChange={(event) => onBackupConfirmed(event.target.checked)} />
        <span>I have created a database backup/export before repairing workspace import context.</span>
      </label>
      {repairResult ? <p className="positive">Repaired by entity: {repairResult.repairedByEntity.map((row) => `${row.entityType} ${row.count}`).join(" • ") || "0"}. Voucher mismatches after repair: {repairResult.voucherNumberMismatchesAfter}. Duplicate active voucher numbers after repair: {repairResult.duplicateActiveVoucherNumbersAfter.length}.</p> : null}
    </section>
  );
}

export function MigrationImport() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const [workspaceId, setWorkspaceId] = useState("");
  const currentJobStorageKey = workspaceId ? `migration-import-current-job:${workspaceId}` : "";
  const [fileName, setFileName] = useState("");
  const [payload, setPayload] = useState<unknown>(null);
  const [fileError, setFileError] = useState("");
  const [allowSummaryMismatch, setAllowSummaryMismatch] = useState(false);
  const [attendanceJobId, setAttendanceJobId] = useState("");
  const [selectedHistoryBatchId, setSelectedHistoryBatchId] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [visibilityAuditOpen, setVisibilityAuditOpen] = useState(false);
  const [importContextBackupConfirmed, setImportContextBackupConfirmed] = useState(false);
  const [cleanupBackupConfirmed, setCleanupBackupConfirmed] = useState(false);
  const [cleanupConfirmationText, setCleanupConfirmationText] = useState("");
  const [cleanupIncludeEdited, setCleanupIncludeEdited] = useState(false);
  const [cleanupStartingProgress, setCleanupStartingProgress] = useState<MigrationImportProgress | null>(null);
  const workspaces = useQuery({
    queryKey: ["admin-workspaces"],
    queryFn: () => fetchAdminWorkspaces(token!),
    enabled: Boolean(token),
  });
  const workspaceOptions = workspaces.data?.workspaces ?? [];
  const selectedWorkspace = useMemo(() => workspaceOptions.find((workspace) => workspace.id === workspaceId), [workspaceId, workspaceOptions]);

  const validate = useMutation({
    mutationFn: () => validateMigrationImport(token!, { workspaceId, payload, allowSummaryMismatch }),
  });
  const history = useQuery({
    queryKey: ["admin-migration-import-history", workspaceId],
    queryFn: () => fetchMigrationImportHistory(token!, workspaceId),
    enabled: Boolean(token && workspaceId),
  });
  const batches = useQuery({
    queryKey: ["admin-migration-import-batches", workspaceId],
    queryFn: () => fetchMigrationImportBatches(token!, workspaceId),
    enabled: Boolean(token && workspaceId),
    refetchInterval: 1000,
  });
  const latestBatch = batches.data?.records?.[0] ?? null;
  const [operationIntent, setOperationIntent] = useState<"import" | "cleanup" | null>(null);
  const activeImportJob = useQuery({
    queryKey: ["admin-migration-import-active-job", workspaceId],
    queryFn: () => fetchActiveMigrationImportJob(token!, workspaceId),
    enabled: Boolean(token && workspaceId),
    refetchInterval: 2000,
  });
  const refreshAfterImport = () => {
    void queryClient.invalidateQueries();
  };
  const runImport = useMutation({
    mutationFn: () => importMigrationData(token!, { workspaceId, payload, dryRun: false, allowDatabaseWrite: true, allowSummaryMismatch, fileName }),
    onSuccess: (data) => {
      const jobId = data.result?.attendanceJobId ?? "";
      setAttendanceJobId(jobId);
      if (jobId && currentJobStorageKey) window.localStorage.setItem(currentJobStorageKey, jobId);
      refreshAfterImport();
    },
  });
  const attendanceJob = useQuery({
    queryKey: ["admin-migration-import-attendance-job", attendanceJobId],
    queryFn: () => fetchMigrationImportJobStatus(token!, attendanceJobId),
    enabled: Boolean(token && attendanceJobId),
    refetchInterval: (query) => {
      const status = query.state.data?.job.status;
      return status === "completed" || status === "failed" ? false : 2000;
    },
  });
  const repairVisibility = useMutation({
    mutationFn: () => repairMigrationImportVisibility(token!, { workspaceId }),
    onSuccess: refreshAfterImport,
  });
  const repairDeletedState = useMutation({
    mutationFn: () => repairDeletedFarmSeasonState(token!, { workspaceId }),
    onSuccess: refreshAfterImport,
  });
  const repairDuplicateAccounts = useMutation({
    mutationFn: () => repairDuplicateImportedAccounts(token!, { workspaceId }),
    onSuccess: refreshAfterImport,
  });
  const repairVoucherNumbers = useMutation({
    mutationFn: () => repairImportedVoucherNumbers(token!, { workspaceId }),
    onSuccess: async () => {
      refreshAfterImport();
      window.dispatchEvent(new Event("muzare-data-refresh"));
      window.dispatchEvent(new Event("muzare-local-data-change"));
    },
  });
  const importContextPreview = useQuery({
    queryKey: ["admin-migration-import-repair-workspace-context-preview", workspaceId],
    queryFn: () => fetchWorkspaceImportContextRepairPreview(token!, workspaceId),
    enabled: false,
  });
  const repairImportContext = useMutation({
    mutationFn: () => repairWorkspaceImportContext(token!, { workspaceId, backupConfirmed: true }),
    onSuccess: async () => {
      await clearCachedData();
      refreshAfterImport();
      window.dispatchEvent(new Event("muzare-data-refresh"));
      window.dispatchEvent(new Event("muzare-local-data-change"));
      void importContextPreview.refetch();
    },
  });
  const cleanupPreview = useQuery({
    queryKey: ["admin-migration-import-cleanup-preview", workspaceId, latestBatch?.id],
    queryFn: () => fetchMigrationImportCleanupPreview(token!, workspaceId, latestBatch!.id),
    enabled: false,
  });
  const cleanFailedImport = useMutation({
    mutationFn: (batchId: string) => cancelAndCleanMigrationImport(token!, {
      workspaceId,
      batchId,
      confirmationText: "CANCEL AND CLEAN IMPORT",
      backupConfirmed: true,
      includeEditedImportedRecords: cleanupIncludeEdited,
    }),
    onSuccess: () => {
      setCleanupBackupConfirmed(false);
      setCleanupConfirmationText("");
      setCleanupStartingProgress(null);
      setOperationIntent(null);
      refreshAfterImport();
      void cleanupPreview.refetch();
    },
    onError: () => {
      setCleanupStartingProgress(null);
    },
  });
  const progressBatchId = operationIntent === "cleanup"
    ? latestBatch?.id ?? ""
    : latestBatch?.status === "running" || latestBatch?.status === "in_progress"
      ? latestBatch.id
      : "";
  const operationProgress = useQuery({
    queryKey: ["admin-migration-import-progress", progressBatchId],
    queryFn: () => fetchMigrationImportProgress(token!, progressBatchId),
    enabled: Boolean(token && progressBatchId && (runImport.isPending || cleanFailedImport.isPending || latestBatch?.status === "running" || latestBatch?.status === "in_progress")),
    refetchInterval: 1000,
  });

  useEffect(() => {
    if (!currentJobStorageKey) return;
    const savedJobId = window.localStorage.getItem(currentJobStorageKey);
    if (savedJobId) setAttendanceJobId(savedJobId);
  }, [currentJobStorageKey]);

  useEffect(() => {
    const activeJobId = activeImportJob.data?.job?.jobId;
    if (!activeJobId || !currentJobStorageKey) return;
    setAttendanceJobId(activeJobId);
    window.localStorage.setItem(currentJobStorageKey, activeJobId);
  }, [activeImportJob.data?.job?.jobId, currentJobStorageKey]);

  useEffect(() => {
    const status = attendanceJob.data?.job.status;
    if (!currentJobStorageKey || !status) return;
    if (status === "completed" || status === "failed") window.localStorage.removeItem(currentJobStorageKey);
  }, [attendanceJob.data?.job.status, currentJobStorageKey]);

  useEffect(() => {
    const status = operationProgress.data?.status;
    if (status === "completed" || status === "failed" || status === "cancelled") {
      setOperationIntent(null);
      setCleanupStartingProgress(null);
    }
  }, [operationProgress.data?.status]);

  useEffect(() => {
    if (runImport.isError || cleanFailedImport.isError) {
      setOperationIntent(null);
      setCleanupStartingProgress(null);
    }
  }, [runImport.isError, cleanFailedImport.isError]);

  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setFileError("");
    setPayload(null);
    setAllowSummaryMismatch(false);
    setAttendanceJobId("");
    setSelectedHistoryBatchId(null);
    validate.reset();
    runImport.reset();
    repairVisibility.reset();
    repairDeletedState.reset();
    repairDuplicateAccounts.reset();
    repairImportContext.reset();
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

  const resetWizard = () => {
    setFileName("");
    setPayload(null);
    setFileError("");
    setAllowSummaryMismatch(false);
    validate.reset();
    runImport.reset();
  };

  const validation = runImport.data ?? validate.data;
  const currentImportJob = attendanceJob.data?.job ?? activeImportJob.data?.job ?? runImport.data?.result?.attendanceJob ?? null;
  const isImportRunning = currentImportJob?.status === "queued" || currentImportJob?.status === "running";
  const isCleanupRunning = operationIntent === "cleanup" && (cleanFailedImport.isPending || operationProgress.data?.status === "running");
  const blockingOperation = Boolean(runImport.isPending || cleanFailedImport.isPending || isImportRunning || operationProgress.data?.status === "running");
  const canValidate = Boolean(token && workspaceId && payload && !validate.isPending && !blockingOperation);
  const canImport = Boolean(token && workspaceId && payload && validate.data?.canImport && !runImport.isPending && !blockingOperation);

  const pageStatus = useMemo(() => {
    if (isCleanupRunning) return "cancelled";
    if (blockingOperation && operationIntent === "import") return "importing";
    if (validate.isPending) return "validating";
    if (runImport.isError || cleanFailedImport.isError || latestBatch?.status === "failed" || latestBatch?.status === "partial_failed") return "failed";
    if (latestBatch && ["running", "in_progress"].includes(latestBatch.status) && (Date.now() - new Date(latestBatch.updatedAt).getTime()) > 10 * 60 * 1000) return "stuck";
    if (runImport.data?.imported || latestBatch?.status === "completed") return "completed";
    return "ready";
  }, [blockingOperation, cleanFailedImport.isError, isCleanupRunning, latestBatch, operationIntent, runImport.data?.imported, runImport.isError, validate.isPending]);

  const showProgress = Boolean(operationProgress.data || currentImportJob);
  const cleanupCanSubmit = Boolean(latestBatch && cleanupPreview.data?.preview && cleanupBackupConfirmed && cleanupConfirmationText === "CANCEL AND CLEAN IMPORT" && !cleanFailedImport.isPending);
  const cleanupProgress = operationIntent === "cleanup"
    ? (operationProgress.data ?? cleanupStartingProgress)
    : null;
  const importProgress = operationIntent !== "cleanup"
    ? operationProgress.data
    : null;

  const buildImportStageRows = (progressSource?: MigrationImportProgress | null) => {
    const stages = ["Reading JSON", "Validating file", "Importing farms", "Importing seasons", "Importing accounts", "Importing partners", "Importing labour", "Importing attendance", "Importing advances", "Importing vouchers", "Importing voucher items", "Repairing references", "Verifying import", "Completed"];
    const current = (progressSource?.stage || progressSource?.step || currentImportJob?.currentStep || "").toLowerCase();
    let seenCurrent = false;
    return stages.map((stage) => {
      const normalized = stage.toLowerCase();
      if (progressSource?.status === "failed" && current.includes(normalized.replace("importing ", ""))) return { label: stage, status: "failed" as const, detail: progressSource?.message };
      if (current && (current.includes(normalized) || normalized.includes(current))) {
        seenCurrent = true;
        return { label: stage, status: progressSource?.status === "completed" && stage === "Completed" ? "done" as const : "running" as const, detail: progressSource?.message };
      }
      if (!seenCurrent && current) return { label: stage, status: "done" as const };
      if (progressSource?.status === "completed" && stage === "Completed") return { label: stage, status: "done" as const };
      return { label: stage, status: "waiting" as const };
    });
  };

  const buildCleanupStageRows = (progressSource?: MigrationImportProgress | null) => {
    const stages = ["Stopping import worker", "Finding imported records", "Removing operational records", "Removing import failures", "Cleaning seasons", "Cleaning farms", "Detaching audit logs", "Repairing session context", "Updating batch status", "Completed"];
    const current = (progressSource?.stage || progressSource?.step || "").toLowerCase();
    let seenCurrent = false;
    return stages.map((stage) => {
      const normalized = stage.toLowerCase();
      if (progressSource?.status === "failed" && current.includes(normalized)) return { label: stage, status: "failed" as const, detail: progressSource?.message };
      if (current && (current.includes(normalized) || normalized.includes(current))) {
        seenCurrent = true;
        return { label: stage, status: progressSource?.status === "completed" && stage === "Completed" ? "done" as const : "running" as const, detail: progressSource?.message };
      }
      if (!seenCurrent && current) return { label: stage, status: "done" as const };
      if (progressSource?.status === "completed" && stage === "Completed") return { label: stage, status: "done" as const };
      return { label: stage, status: "waiting" as const };
    });
  };

  return (
    <main className="admin-page migration-page migration-wizard-page">
      <header className="admin-hero migration-hero">
        <div>
          <span className="eyebrow">Admin only</span>
          <h1>Android Migration Import</h1>
          <p>Import Android JSON data into a selected Muzare workspace.</p>
        </div>
        <StatusBadge status={pageStatus} />
      </header>

      <section className="admin-section-card migration-form">
        <div className="admin-section-heading">
          <div>
            <h2>Step 1 - Select Import</h2>
            <p>Select the target workspace and Android JSON export.</p>
          </div>
        </div>
        <label>
          <span>Target workspace</span>
          <select value={workspaceId} disabled={blockingOperation} onChange={(event) => {
            setWorkspaceId(event.target.value);
            setSelectedHistoryBatchId(null);
          }}>
            <option value="">Select workspace</option>
            {workspaceOptions.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name} ({workspace.status})</option>)}
          </select>
        </label>
        {selectedWorkspace ? <p className="migration-context">Import target: <b>{selectedWorkspace.name}</b> · {selectedWorkspace.contactEmail}</p> : null}
        <label className={`migration-file-picker${blockingOperation ? " migration-file-picker--disabled" : ""}`}>
          <FileJson size={18} />
          <span>{fileName || "Choose Android export .json file"}</span>
          <input accept="application/json,.json" type="file" disabled={blockingOperation} onChange={(event) => void readFile(event)} />
        </label>
        {fileError ? <p className="worker-action-error">{fileError}</p> : null}
        <label className="inline-checkbox">
          <input type="checkbox" checked={allowSummaryMismatch} disabled={blockingOperation} onChange={(event) => setAllowSummaryMismatch(event.target.checked)} />
          <span>Allow import if export summary counts do not match actual JSON arrays</span>
        </label>
        <div className="record-list__actions">
          <button type="button" disabled={!canValidate} onClick={() => validate.mutate()}><UploadCloud size={16} />Validate Import</button>
          <button type="button" disabled={!canImport} onClick={() => { setOperationIntent("import"); runImport.mutate(); }}><Database size={16} />Import Data</button>
        </div>
        {isImportRunning && currentImportJob ? (
          <p className="positive">
            Import job <b>{currentImportJob.jobId}</b> is running. Progress is shown below.
          </p>
        ) : null}
        {validate.error ? <p className="worker-action-error">{validate.error instanceof Error ? validate.error.message : "Validation failed."}</p> : null}
        {runImport.error ? <p className="worker-action-error">{runImport.error instanceof Error ? runImport.error.message : "Import failed."}</p> : null}
      </section>

      {validation ? <ResultCard validation={validation} importResult={runImport.data} onReset={resetWizard} /> : null}

      {showProgress || Boolean(cleanupProgress) ? (
        <ProgressCard
          progress={cleanupProgress ?? importProgress ?? {
            batchId: latestBatch?.id ?? "current",
            status: currentImportJob?.status === "queued" ? "pending" : currentImportJob?.status === "partial_failed" || currentImportJob?.status === "rolled_back" ? "failed" : currentImportJob?.status ?? "running",
            stage: currentImportJob?.currentStep ?? "Importing attendance",
            step: currentImportJob?.currentRow ?? currentImportJob?.currentStep ?? "",
            percentage: currentImportJob ? Math.min(100, Math.round((((currentImportJob.steps.reduce((sum, step) => sum + step.processed, 0)) || 0) / Math.max(1, currentImportJob.steps.reduce((sum, step) => sum + step.total, 0))) * 100)) : 0,
            completedSteps: currentImportJob?.steps.filter((step) => step.status === "completed").length ?? 0,
            totalSteps: currentImportJob?.steps.length ?? 0,
            message: currentImportJob?.message ?? "",
            processedCount: currentImportJob?.processedRows ?? 0,
            totalCount: currentImportJob?.sourceRows ?? 0,
            importedCount: currentImportJob?.importedRows ?? 0,
            updatedCount: currentImportJob?.updatedRows ?? 0,
            skippedCount: currentImportJob?.skippedRows ?? 0,
            failedCount: currentImportJob?.failedRows ?? 0,
            startedAt: new Date().toISOString(),
            updatedAt: currentImportJob?.lastProgressAt ?? new Date().toISOString(),
            elapsedSeconds: 0,
            estimatedRemainingSeconds: null,
          }}
          stageRows={operationIntent === "cleanup" ? buildCleanupStageRows(cleanupProgress) : buildImportStageRows(importProgress)}
          isCleanup={operationIntent === "cleanup"}
        />
      ) : null}

      {latestBatch && cleanFailedImport.data ? (
        <section className="admin-section-card migration-results">
          <div className="admin-section-heading">
            <div>
              <h2>Cleanup Result</h2>
              <p>{cleanFailedImport.data.message}</p>
            </div>
            <StatusBadge status={cleanFailedImport.data.result.batchStatus} />
          </div>
          <div className="migration-result-grid">
            <article><span>Operational records removed</span><strong>{cleanFailedImport.data.result.operationalRecordsRemoved}</strong></article>
            <article><span>Import failures removed</span><strong>{cleanFailedImport.data.result.importFailuresRemoved}</strong></article>
            <article><span>Seasons hard-deleted</span><strong>{cleanFailedImport.data.result.seasonsHardDeleted}</strong></article>
            <article><span>Seasons soft-deleted</span><strong>{cleanFailedImport.data.result.seasonsSoftDeleted}</strong></article>
            <article><span>Farms hard-deleted</span><strong>{cleanFailedImport.data.result.farmsHardDeleted}</strong></article>
            <article><span>Farms soft-deleted</span><strong>{cleanFailedImport.data.result.farmsSoftDeleted}</strong></article>
            <article><span>Audit logs detached</span><strong>{cleanFailedImport.data.result.auditLogsDetached}</strong></article>
            <article><span>Protected records skipped</span><strong>{cleanFailedImport.data.result.skippedProtectedRecords}</strong></article>
          </div>
          {cleanFailedImport.data.result.contextMessage ? <p className="migration-context"><b>Context repair:</b> {cleanFailedImport.data.result.contextMessage}</p> : null}
        </section>
      ) : null}

      <section className="admin-section-card migration-advanced-card">
        <button type="button" className="migration-section-toggle" onClick={() => setAdvancedOpen((value) => !value)}>
          <span>Step 5 - Advanced Recovery Tools</span>
          {advancedOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>
        {advancedOpen ? (
          <div className="migration-advanced-body">
            <div className="record-list__actions">
              <button type="button" className="secondary-button" disabled={!token || !workspaceId || importContextPreview.isFetching || blockingOperation} onClick={() => { void importContextPreview.refetch(); }}>
                Preview Repair Workspace Import Context
              </button>
              <button type="button" className="secondary-button" disabled={!token || !workspaceId || !importContextBackupConfirmed || repairImportContext.isPending || blockingOperation} onClick={() => repairImportContext.mutate()}>
                Repair Workspace Import Context
              </button>
              <button type="button" className="secondary-button" disabled={!token || !workspaceId || repairVisibility.isPending || blockingOperation} onClick={() => repairVisibility.mutate()}>
                Repair Previous Import Visibility
              </button>
              <button type="button" className="secondary-button" disabled={!token || !workspaceId || repairDeletedState.isPending || blockingOperation} onClick={() => repairDeletedState.mutate()}>
                Repair Deleted Farm/Season State
              </button>
              <button type="button" className="secondary-button" disabled={!token || !workspaceId || repairDuplicateAccounts.isPending || blockingOperation} onClick={() => repairDuplicateAccounts.mutate()}>
                Repair Duplicate Imported Accounts
              </button>
              <button type="button" className="secondary-button" disabled={!token || !workspaceId || repairVoucherNumbers.isPending || blockingOperation} onClick={() => repairVoucherNumbers.mutate()}>
                Repair Imported Voucher Numbers
              </button>
              <button type="button" className="secondary-button" onClick={() => setVisibilityAuditOpen((value) => !value)}>
                Run Visibility Audit
              </button>
            </div>
            {importContextPreview.data?.preview ? <ImportContextRepairPreviewCard
              preview={importContextPreview.data.preview}
              backupConfirmed={importContextBackupConfirmed}
              onBackupConfirmed={setImportContextBackupConfirmed}
              repairResult={repairImportContext.data ?? null}
            /> : null}
            {repairImportContext.data ? <p className="positive">{repairImportContext.data.message} Remapped records: {repairImportContext.data.repairedOperationalRecords}. Voucher mismatches after repair: {repairImportContext.data.voucherNumberMismatchesAfter}. Duplicate active voucher numbers after repair: {repairImportContext.data.duplicateActiveVoucherNumbersAfter.length}.</p> : null}
            {repairVisibility.data ? <p className="positive">{repairVisibility.data.message} Repaired records: {repairVisibility.data.repairedRecords}.</p> : null}
            {repairDeletedState.data ? <p className="positive">{repairDeletedState.data.message} Farms deactivated: {repairDeletedState.data.farmsDeactivated}. Seasons deactivated: {repairDeletedState.data.seasonsDeactivated}.</p> : null}
            {repairDuplicateAccounts.data ? <p className="positive">{repairDuplicateAccounts.data.message} Duplicate groups before: {repairDuplicateAccounts.data.duplicateGroupsBefore}. Child records remapped: {repairDuplicateAccounts.data.childRecordsRemapped}. Duplicate accounts removed: {repairDuplicateAccounts.data.duplicateAccountsRemoved}.</p> : null}
            {repairVoucherNumbers.data ? <p className="positive">{repairVoucherNumbers.data.message} Updated vouchers: {repairVoucherNumbers.data.vouchersUpdated}. Mismatches before: {repairVoucherNumbers.data.mismatchesBefore}. Mismatches after: {repairVoucherNumbers.data.mismatchesAfter}.</p> : null}
            {importContextPreview.error ? <p className="worker-action-error">{importContextPreview.error instanceof Error ? importContextPreview.error.message : "Workspace import context preview failed."}</p> : null}
            {repairImportContext.error ? <p className="worker-action-error">{repairImportContext.error instanceof Error ? repairImportContext.error.message : "Workspace import context repair failed."}</p> : null}
            {repairVisibility.error ? <p className="worker-action-error">{repairVisibility.error instanceof Error ? repairVisibility.error.message : "Visibility repair failed."}</p> : null}
            {repairDeletedState.error ? <p className="worker-action-error">{repairDeletedState.error instanceof Error ? repairDeletedState.error.message : "Deleted farm/season repair failed."}</p> : null}
            {repairDuplicateAccounts.error ? <p className="worker-action-error">{repairDuplicateAccounts.error instanceof Error ? repairDuplicateAccounts.error.message : "Duplicate account repair failed."}</p> : null}
            {repairVoucherNumbers.error ? <p className="worker-action-error">{repairVoucherNumbers.error instanceof Error ? repairVoucherNumbers.error.message : "Voucher number repair failed."}</p> : null}

            {visibilityAuditOpen && workspaceId ? <ImportVisibilityAuditPanel workspaceId={workspaceId} title="Import Visibility Audit" /> : null}

            {latestBatch ? (
              <div className="migration-danger-zone">
                <div className="migration-callout migration-callout--danger">
                  <strong>Cancel and Clean This Import</strong>
                  <p>This will cancel the selected import and remove incomplete imported data created by this import batch. This cannot be undone without a database backup.</p>
                </div>
                <div className="record-list__actions">
                  <button type="button" className="secondary-button" disabled={cleanupPreview.isFetching} onClick={() => { void cleanupPreview.refetch(); }}>
                    Preview Cleanup
                  </button>
                </div>
                {cleanupPreview.data?.preview ? (
                  <div className="migration-result-grid">
                    <article><span>Import batch status</span><strong>{cleanupPreview.data.preview.status}</strong></article>
                    <article><span>Import failures</span><strong>{cleanupPreview.data.preview.importFailures}</strong></article>
                    <article><span>Imported farms</span><strong>{cleanupPreview.data.preview.importedFarms}</strong></article>
                    <article><span>Imported seasons</span><strong>{cleanupPreview.data.preview.importedSeasons}</strong></article>
                    <article><span>Edited imported records</span><strong>{cleanupPreview.data.preview.editedImportedRecords}</strong></article>
                    <article><span>Open / failed batches</span><strong>{cleanupPreview.data.preview.openImportBatches}</strong></article>
                  </div>
                ) : null}
                <label className="inline-checkbox">
                  <input type="checkbox" checked={cleanupBackupConfirmed} onChange={(event) => setCleanupBackupConfirmed(event.target.checked)} />
                  <span>I have created a database backup/export before cleanup.</span>
                </label>
                <label className="inline-checkbox">
                  <input type="checkbox" checked={cleanupIncludeEdited} onChange={(event) => setCleanupIncludeEdited(event.target.checked)} />
                  <span>Also remove imported records that were later edited.</span>
                </label>
                <label className="migration-confirmation-field">
                  <span>Type this exact confirmation text</span>
                  <div className="migration-confirmation-hint">CANCEL AND CLEAN IMPORT</div>
                  <input
                    type="text"
                    value={cleanupConfirmationText}
                    onChange={(event) => setCleanupConfirmationText(event.target.value)}
                    placeholder="Type: CANCEL AND CLEAN IMPORT"
                    autoCapitalize="characters"
                    spellCheck={false}
                  />
                </label>
                <div className="record-list__actions">
                  <button
                    type="button"
                    className="danger-button"
                    disabled={!cleanupCanSubmit}
                    onClick={() => {
                      setOperationIntent("cleanup");
                      setCleanupStartingProgress(buildCleanupStartingProgress(latestBatch.id));
                      cleanFailedImport.mutate(latestBatch.id);
                    }}
                  >
                    {cleanFailedImport.isPending ? "Starting cleanup..." : "Cancel and Clean This Import"}
                  </button>
                </div>
                {cleanFailedImport.isPending && !operationProgress.data ? <p className="positive">Starting cleanup...</p> : null}
                {cleanupPreview.error ? <p className="worker-action-error">{cleanupPreview.error instanceof Error ? cleanupPreview.error.message : "Could not load cleanup preview."}</p> : null}
                {cleanFailedImport.error ? <p className="worker-action-error">{formatApiError(cleanFailedImport.error, "Cleanup failed.")}</p> : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      {workspaceId ? <HistoryTable batches={batches.data?.records ?? []} records={history.data?.records ?? []} selectedBatchId={selectedHistoryBatchId} onSelectBatch={setSelectedHistoryBatchId} workspaceLabel={selectedWorkspace?.name ?? "Selected workspace"} /> : null}

      {attendanceJob.data?.job.status === "failed" ? (
        <JobErrorPanel
          detail={{
            jobId: attendanceJob.data.job.jobId,
            status: attendanceJob.data.job.status,
            currentStep: attendanceJob.data.job.currentStep ?? "",
            message: attendanceJob.data.job.message ?? "",
            error: attendanceJob.data.job.message ?? "",
            stack: "",
            failures: [],
            importedRows: attendanceJob.data.job.importedRows,
            updatedRows: attendanceJob.data.job.updatedRows,
            skippedRows: attendanceJob.data.job.skippedRows,
            failedRows: attendanceJob.data.job.failedRows,
            steps: attendanceJob.data.job.steps,
            startedAt: attendanceJob.data.job.startedAt,
            completedAt: attendanceJob.data.job.completedAt ?? null,
            firstFailureMessage: attendanceJob.data.job.message ?? "",
          }}
          onDownloadFailures={() => void downloadMigrationImportFailures(token!, attendanceJob.data!.job.jobId)}
        />
      ) : null}
    </main>
  );
}
