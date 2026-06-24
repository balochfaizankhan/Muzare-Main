import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, FileJson, ShieldAlert, UploadCloud } from "lucide-react";
import { useAuth } from "../../auth/AuthProvider";
import { Link, useParams } from "react-router-dom";
import { cleanFailedMigrationImport, downloadMigrationImportFailures, fetchActiveMigrationImportJob, fetchAdminWorkspaces, fetchMigrationImportBatches, fetchMigrationImportCleanupPreview, fetchMigrationImportHistory, fetchMigrationImportJobDetail, fetchMigrationImportJobStatus, importMigrationData, markMigrationImportBatchClosed, repairMigrationImportVisibility, retryMigrationAttendance, rollbackMigrationImportBatch, validateMigrationImport, type MigrationImportBatchRecord, type MigrationImportHistoryRecord, type MigrationImportIssue, type MigrationImportJobDetail, type MigrationImportJobStatus, type MigrationImportLogEntry, type MigrationImportSummary } from "../../lib/api";
import { formatMoney } from "../../lib/format";

function SummaryGrid({ summary }: { summary: MigrationImportSummary }) {
  const countRows = Object.entries(summary.counts);
  const androidRows = Object.entries(summary.androidCounts ?? {});
  const exportSummaryRows = Object.entries(summary.exportSummaryCounts ?? {}).filter(([, value]) => value >= 0);
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
      {exportSummaryRows.length ? <article className="migration-summary__wide"><span>Export summary counts</span><p>{exportSummaryRows.map(([key, value]) => `${key}: ${value}`).join(" · ")}</p></article> : null}
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

function CurrentImportPanel({ job }: { job: MigrationImportJobStatus }) {
  const progress = job.steps.reduce((sum, step) => sum + step.processed, 0);
  const total = job.steps.reduce((sum, step) => sum + step.total, 0);
  const progressPercent = total > 0 ? Math.min(100, Math.round((progress / total) * 100)) : 0;
  return (
    <section className="migration-issues">
      <h3>Current Import</h3>
      <p className={job.status === "failed" ? "worker-action-error" : "positive"}>
        {job.status === "completed"
          ? "Import Complete"
          : job.status === "failed" || job.status === "partial_failed"
            ? "Import completed with failures."
            : job.status === "rolled_back"
              ? "Import was rolled back."
              : "Import job running."}
      </p>
      <p><b>Job ID</b> {job.jobId}</p>
      <p><b>Status</b> {job.status}</p>
      <p><b>Current step</b> {job.currentStep}</p>
      <p><b>Overall</b> {progress} / {total} processed</p>
      <div aria-hidden="true" style={{ height: 10, borderRadius: 999, background: "rgba(15, 23, 42, 0.08)", overflow: "hidden", margin: "0.75rem 0" }}>
        <div style={{ width: `${progressPercent}%`, height: "100%", background: "linear-gradient(90deg, #1f7a2e, #4f9a49)" }} />
      </div>
      <p><b>Base import</b> {job.steps.filter((step) => step.name !== "Attendance").every((step) => step.status === "completed") ? "Completed" : "Running"}</p>
      <p><b>Attendance</b> {job.steps.find((step) => step.name === "Attendance")?.status ?? "pending"} {job.processedRows} / {job.sourceRows}</p>
      <p><b>Current batch</b> {job.currentBatch} / {job.totalBatches}</p>
      <p><b>Imported</b> {job.importedRows} · <b>Updated</b> {job.updatedRows} · <b>Skipped</b> {job.skippedRows} · <b>Failed</b> {job.failedRows}</p>
      {job.currentRow ? <p><b>Current row</b> {job.currentRow}</p> : null}
      {job.message ? <p><b>Message</b> {job.message}</p> : null}
      <p><b>Last progress</b> {new Date(job.lastProgressAt).toLocaleString()}</p>
      <div>
        <h4>Detailed steps</h4>
        {job.steps.map((step) => (
          <p key={step.name}>
            <b>{step.name}</b> {step.status}
            {typeof step.batch === "number" && typeof step.batchTotal === "number" ? ` · batch ${step.batch}/${step.batchTotal}` : ""}
            {` · processed ${step.processed}/${step.total}`}
            {` · imported ${step.imported}`}
            {` · updated ${step.updated}`}
            {` · skipped ${step.skipped}`}
            {` · failed ${step.failed}`}
            {step.message ? ` · ${step.message}` : ""}
          </p>
        ))}
      </div>
      {job.logs?.length ? (
        <div>
          <h4>Recent job updates</h4>
          {job.logs.slice(-8).map((item, index) => (
            <p key={`${item.step}:${item.createdAt}:${index}`}>
              <b>{item.step}</b> {item.status}
              {typeof item.importedRows === "number" ? ` · imported ${item.importedRows}` : ""}
              {typeof item.updatedRows === "number" ? ` · updated ${item.updatedRows}` : ""}
              {typeof item.skippedRows === "number" ? ` · skipped ${item.skippedRows}` : ""}
              {typeof item.failedRows === "number" ? ` · failed ${item.failedRows}` : ""}
              {item.message ? ` · ${item.message}` : ""}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function JobErrorPanel({ detail, onDownloadFailures }: { detail: MigrationImportJobDetail; onDownloadFailures: () => void }) {
  const lastSuccessfulStep = [...detail.steps].reverse().find((step) => step.status === "completed")?.name ?? "-";
  return (
    <section className="migration-issues">
      <h3>{detail.currentStep || "Import Failure"}</h3>
      <p className="worker-action-error">{detail.error || detail.message || detail.firstFailureMessage || "Import failed."}</p>
      <p><b>Job ID</b> {detail.jobId}</p>
      <p><b>Current Step</b> {detail.currentStep}</p>
      <p><b>Last Successful Step</b> {lastSuccessfulStep}</p>
      <p><b>Processed</b> {detail.importedRows + detail.updatedRows + detail.skippedRows} / {detail.steps.reduce((sum, step) => sum + step.total, 0)}</p>
      <p><b>Imported</b> {detail.importedRows} · <b>Updated</b> {detail.updatedRows} · <b>Skipped</b> {detail.skippedRows} · <b>Failed</b> {detail.failedRows}</p>
      {detail.firstFailureMessage ? <p><b>First failure</b> {detail.firstFailureMessage}</p> : null}
      {detail.completedAt ? <p><b>Failed at</b> {new Date(detail.completedAt).toLocaleString()}</p> : null}
      <div className="record-list__actions">
        <button type="button" className="secondary-button" onClick={onDownloadFailures}>Download Failure CSV</button>
      </div>
      {detail.failures.slice(0, 10).length ? (
        <div>
          <h4>Failure details</h4>
          {detail.failures.slice(0, 10).map((failure) => (
            <p key={failure.id}>
              <b>{failure.step}</b> {failure.sourceRow ? `· row ${failure.sourceRow}` : ""} · {failure.errorMessage}
            </p>
          ))}
        </div>
      ) : null}
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
    sourceRows: details.sourceRows,
    importedRows: details.importedRows,
    updatedRows: details.updatedRows,
    skippedRows: details.skippedRows,
    failedRows: details.failedRows,
  };
};

function ImportHistory({ records }: { records: MigrationImportHistoryRecord[] }) {
  const grouped = records.reduce<Map<string, MigrationImportHistoryRecord[]>>((map, record) => {
    const batch = readLogDetails(record).batch;
    map.set(batch, [...(map.get(batch) ?? []), record]);
    return map;
  }, new Map());
  return (
    <section className="migration-issues">
      <h3>Import history</h3>
      {!records.length ? <p className="activity-empty">No migration import logs for this workspace yet.</p> : null}
      {[...grouped.entries()].slice(0, 8).map(([batch, batchRecords]) => (
        <div key={batch}>
          <p><b>Import job</b> {batch} · {new Date(batchRecords[0]?.createdAt ?? Date.now()).toLocaleString()}</p>
          {batchRecords.slice(0, 8).map((record) => {
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
                {batch !== "-" ? <> · <Link to={`/admin/imports/${batch}`}>View Details</Link></> : null}
              </p>
            );
          })}
        </div>
      ))}
    </section>
  );
}

function LatestBatchPanel({
  batch,
  onRetryAttendance,
  onRollback,
  onMarkClosed,
  retrying,
  rollingBack,
  closing,
}: {
  batch: MigrationImportBatchRecord;
  onRetryAttendance: () => void;
  onRollback: () => void;
  onMarkClosed: () => void;
  retrying: boolean;
  rollingBack: boolean;
  closing: boolean;
}) {
  return (
    <section className="migration-issues">
      <h3>Latest Import Batch</h3>
      <p><b>Batch ID</b> {batch.id}</p>
      <p><b>Status</b> {batch.status}</p>
      <p><b>File</b> {batch.fileName ?? "Imported JSON"} · {batch.fileHash.slice(0, 12)}</p>
      <p><b>Started</b> {new Date(batch.startedAt).toLocaleString()}</p>
      {batch.completedAt ? <p><b>Completed</b> {new Date(batch.completedAt).toLocaleString()}</p> : null}
      <div className="record-list__actions">
        <button type="button" className="secondary-button" onClick={onRetryAttendance} disabled={retrying || batch.status === "running"}>
          Retry Attendance Only
        </button>
        <button type="button" className="secondary-button" onClick={onRollback} disabled={rollingBack || batch.status === "running" || batch.status === "rolled_back"}>
          Rollback This Import
        </button>
        <button type="button" className="secondary-button" onClick={onMarkClosed} disabled={closing || !["failed", "partial_failed"].includes(batch.status)}>
          Mark Failed Batch Closed
        </button>
      </div>
    </section>
  );
}

function CleanupPanel({
  batch,
  preview,
  loadingPreview,
  onLoadPreview,
  backupConfirmed,
  setBackupConfirmed,
  includeEditedImportedRecords,
  setIncludeEditedImportedRecords,
  onCleanup,
  cleaning,
}: {
  batch: MigrationImportBatchRecord;
  preview: Awaited<ReturnType<typeof fetchMigrationImportCleanupPreview>>["preview"] | undefined;
  loadingPreview: boolean;
  onLoadPreview: () => void;
  backupConfirmed: boolean;
  setBackupConfirmed: (value: boolean) => void;
  includeEditedImportedRecords: boolean;
  setIncludeEditedImportedRecords: (value: boolean) => void;
  onCleanup: () => void;
  cleaning: boolean;
}) {
  return (
    <section className="migration-issues">
      <h3>Clean Failed Android Import</h3>
      <p className="worker-action-error">This will remove failed Android import dump data. This cannot be undone without backup.</p>
      <p><b>Selected batch</b> {batch.id}</p>
      <div className="record-list__actions">
        <button type="button" className="secondary-button" onClick={onLoadPreview} disabled={loadingPreview}>
          Preview Cleanup
        </button>
      </div>
      {preview ? (
        <div>
          <p><b>Import batches</b> {preview.importBatches} · <b>Open/failed batches</b> {preview.openImportBatches}</p>
          <p><b>Import failures</b> {preview.importFailures}</p>
          <p><b>Imported farms</b> {preview.importedFarms} · <b>Imported seasons</b> {preview.importedSeasons}</p>
          <p><b>Edited imported records</b> {preview.editedImportedRecords}</p>
          <h4>Operational dump by entity</h4>
          {!preview.operationalRecordsByEntity.length ? <p className="activity-empty">No matching imported operational dump records found.</p> : preview.operationalRecordsByEntity.map((item) => (
            <p key={item.entityType}><b>{item.entityType}</b> {item.count}</p>
          ))}
        </div>
      ) : null}
      <label className="inline-checkbox">
        <input type="checkbox" checked={backupConfirmed} onChange={(event) => setBackupConfirmed(event.target.checked)} />
        <span>I have created a database backup/export before cleanup.</span>
      </label>
      <label className="inline-checkbox">
        <input type="checkbox" checked={includeEditedImportedRecords} onChange={(event) => setIncludeEditedImportedRecords(event.target.checked)} />
        <span>Also remove imported records that were later edited.</span>
      </label>
      <div className="record-list__actions">
        <button type="button" disabled={!preview || !backupConfirmed || cleaning} onClick={onCleanup}>
          Clean Failed Import Dump
        </button>
      </div>
    </section>
  );
}

export function MigrationImport() {
  const { token } = useAuth();
  const { jobId: routeJobId } = useParams();
  const queryClient = useQueryClient();
  const [workspaceId, setWorkspaceId] = useState("");
  const currentJobStorageKey = workspaceId ? `migration-import-current-job:${workspaceId}` : "";
  const [fileName, setFileName] = useState("");
  const [payload, setPayload] = useState<unknown>(null);
  const [fileError, setFileError] = useState("");
  const [allowSummaryMismatch, setAllowSummaryMismatch] = useState(false);
  const [attendanceJobId, setAttendanceJobId] = useState("");
  const [cleanupBackupConfirmed, setCleanupBackupConfirmed] = useState(false);
  const [cleanupIncludeEdited, setCleanupIncludeEdited] = useState(false);
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
    refetchInterval: 4000,
  });
  const latestBatch = batches.data?.records?.[0] ?? null;
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
  const jobDetail = useQuery({
    queryKey: ["admin-migration-import-job-detail", routeJobId],
    queryFn: () => fetchMigrationImportJobDetail(token!, routeJobId!),
    enabled: Boolean(token && routeJobId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "running" || status === "queued" ? 2000 : false;
    },
  });
  const repairVisibility = useMutation({
    mutationFn: () => repairMigrationImportVisibility(token!, { workspaceId }),
    onSuccess: refreshAfterImport,
  });
  const retryAttendanceOnly = useMutation({
    mutationFn: (batchId: string) => retryMigrationAttendance(token!, { workspaceId, batchId }),
    onSuccess: (data) => {
      setAttendanceJobId(data.job.jobId);
      if (currentJobStorageKey) window.localStorage.setItem(currentJobStorageKey, data.job.jobId);
      refreshAfterImport();
    },
  });
  const rollbackBatch = useMutation({
    mutationFn: (batchId: string) => rollbackMigrationImportBatch(token!, { workspaceId, batchId }),
    onSuccess: refreshAfterImport,
  });
  const markBatchClosed = useMutation({
    mutationFn: (batchId: string) => markMigrationImportBatchClosed(token!, { workspaceId, batchId }),
    onSuccess: refreshAfterImport,
  });
  const cleanupPreview = useQuery({
    queryKey: ["admin-migration-import-cleanup-preview", workspaceId, latestBatch?.id],
    queryFn: () => fetchMigrationImportCleanupPreview(token!, workspaceId, latestBatch!.id),
    enabled: false,
  });
  const cleanFailedImport = useMutation({
    mutationFn: (batchId: string) => cleanFailedMigrationImport(token!, {
      workspaceId,
      batchId,
      confirmation: "CLEAN FAILED IMPORT",
      backupConfirmed: true,
      includeEditedImportedRecords: cleanupIncludeEdited,
    }),
    onSuccess: () => {
      setCleanupBackupConfirmed(false);
      refreshAfterImport();
      void cleanupPreview.refetch();
    },
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

  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setFileError("");
    setPayload(null);
    setAllowSummaryMismatch(false);
    setAttendanceJobId("");
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
  const currentImportJob = attendanceJob.data?.job ?? activeImportJob.data?.job ?? runImport.data?.result?.attendanceJob ?? null;
  const isImportRunning = currentImportJob?.status === "queued" || currentImportJob?.status === "running";
  const canValidate = Boolean(token && workspaceId && payload && !validate.isPending);
  const canImport = Boolean(token && workspaceId && payload && validate.data?.canImport && !runImport.isPending && !isImportRunning);

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
        <label className="inline-checkbox">
          <input type="checkbox" checked={allowSummaryMismatch} onChange={(event) => setAllowSummaryMismatch(event.target.checked)} />
          <span>Allow import if export summary counts do not match actual JSON arrays</span>
        </label>
        <div className="record-list__actions">
          <button type="button" disabled={!canValidate} onClick={() => validate.mutate()}><UploadCloud size={16} />Validate Import</button>
          {validate.data?.canImport ? <button type="button" disabled={!canImport} onClick={() => runImport.mutate()}><Database size={16} />Import Data</button> : null}
          <button type="button" className="secondary-button" disabled={!token || !workspaceId || repairVisibility.isPending} onClick={() => repairVisibility.mutate()}>
            Repair previous import visibility
          </button>
        </div>
        {isImportRunning && currentImportJob ? (
          <p className="positive">
            An import is already running. Resume progress below for job <b>{currentImportJob.jobId}</b>.
          </p>
        ) : null}
        {validate.error ? <p className="worker-action-error">{validate.error instanceof Error ? validate.error.message : "Validation failed."}</p> : null}
        {runImport.error ? <p className="worker-action-error">{runImport.error instanceof Error ? runImport.error.message : "Import failed."}</p> : null}
        {repairVisibility.error ? <p className="worker-action-error">{repairVisibility.error instanceof Error ? repairVisibility.error.message : "Visibility repair failed."}</p> : null}
        {repairVisibility.data ? <p className="positive">{repairVisibility.data.message} Repaired records: {repairVisibility.data.repairedRecords}.</p> : null}
      </section>

      {jobDetail.data ? <JobErrorPanel detail={jobDetail.data} onDownloadFailures={() => void downloadMigrationImportFailures(token!, jobDetail.data!.jobId)} /> : null}
      {jobDetail.error ? <p className="worker-action-error">{jobDetail.error instanceof Error ? jobDetail.error.message : "Could not load import job details."}</p> : null}
      {currentImportJob ? <CurrentImportPanel job={currentImportJob} /> : null}
      {latestBatch ? (
        <>
          <LatestBatchPanel
            batch={latestBatch}
            onRetryAttendance={() => retryAttendanceOnly.mutate(latestBatch.id)}
            onRollback={() => rollbackBatch.mutate(latestBatch.id)}
            onMarkClosed={() => markBatchClosed.mutate(latestBatch.id)}
            retrying={retryAttendanceOnly.isPending}
            rollingBack={rollbackBatch.isPending}
            closing={markBatchClosed.isPending}
          />
          <CleanupPanel
            batch={latestBatch}
            preview={cleanupPreview.data?.preview}
            loadingPreview={cleanupPreview.isFetching}
            onLoadPreview={() => { void cleanupPreview.refetch(); }}
            backupConfirmed={cleanupBackupConfirmed}
            setBackupConfirmed={setCleanupBackupConfirmed}
            includeEditedImportedRecords={cleanupIncludeEdited}
            setIncludeEditedImportedRecords={setCleanupIncludeEdited}
            onCleanup={() => cleanFailedImport.mutate(latestBatch.id)}
            cleaning={cleanFailedImport.isPending}
          />
        </>
      ) : null}
      {retryAttendanceOnly.error ? <p className="worker-action-error">{retryAttendanceOnly.error instanceof Error ? retryAttendanceOnly.error.message : "Attendance retry failed."}</p> : null}
      {rollbackBatch.error ? <p className="worker-action-error">{rollbackBatch.error instanceof Error ? rollbackBatch.error.message : "Rollback failed."}</p> : null}
      {markBatchClosed.error ? <p className="worker-action-error">{markBatchClosed.error instanceof Error ? markBatchClosed.error.message : "Could not close failed batch."}</p> : null}
      {cleanupPreview.error ? <p className="worker-action-error">{cleanupPreview.error instanceof Error ? cleanupPreview.error.message : "Could not load cleanup preview."}</p> : null}
      {cleanFailedImport.error ? <p className="worker-action-error">{cleanFailedImport.error instanceof Error ? cleanFailedImport.error.message : "Cleanup failed."}</p> : null}
      {cleanFailedImport.data ? <p className="positive">{cleanFailedImport.data.message} Removed {cleanFailedImport.data.result.operationalRecords} dump records.</p> : null}
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
              {attendanceJob.error ? <p className="worker-action-error">{attendanceJob.error instanceof Error ? attendanceJob.error.message : "Could not load attendance import job status."}</p> : null}
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
                      {typeof item.sourceRows === "number" ? ` · source ${item.sourceRows}` : ""}
                      {typeof item.importedRows === "number" ? ` · imported ${item.importedRows}` : ""}
                      {typeof item.updatedRows === "number" ? ` · updated ${item.updatedRows}` : ""}
                      {typeof item.skippedRows === "number" ? ` · skipped ${item.skippedRows}` : ""}
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
