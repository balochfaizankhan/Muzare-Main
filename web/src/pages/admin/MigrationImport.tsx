import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Database, FileJson, UploadCloud } from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { ImportVisibilityAuditPanel } from "../../components/ImportVisibilityAuditPanel";
import { cancelAndCleanMigrationImport, downloadMigrationImportFailures, fetchActiveMigrationImportJob, fetchAdminWorkspaces, fetchMigrationImportBatches, fetchMigrationImportCleanupPreview, fetchMigrationImportHistory, fetchMigrationImportJobStatus, fetchMigrationImportProgress, fetchWorkspaceImportContextRepairPreview, importMigrationData, repairDeletedFarmSeasonState, repairDuplicateImportedAccounts, repairImportedVoucherNumbers, repairMigrationImportVisibility, repairWorkspaceImportContext, validateMigrationImport, type MigrationImportBatchRecord, type MigrationImportHistoryRecord, type MigrationImportIssue, type MigrationImportJobDetail, type MigrationImportLogEntry, type MigrationImportProgress, type MigrationImportSummary, type WorkspaceImportContextPreview } from "../../lib/api";
import { formatDate, formatMoney } from "../../lib/format";
import { clearCachedData } from "../../lib/offline-db";
import { translateRecordType } from "../../locales/adminLocalizationBundle";
import { translateStatus } from "../../lib/statusLabels";

type StepStatus = "done" | "running" | "waiting" | "failed";

// The backend expects this exact English phrase; the surrounding instructions are localized
// while the phrase itself stays constant so the API contract keeps working in every language.
const CLEANUP_CONFIRMATION_PHRASE = "CANCEL AND CLEAN IMPORT";

// English stage identifiers coming from the import/cleanup workers, mapped to translation keys.
// Matching stays on the raw English strings; only the rendered label is localized.
const IMPORT_STAGES: Array<[string, string]> = [
  ["Reading JSON", "readingJson"],
  ["Validating file", "validatingFile"],
  ["Importing farms", "importingFarms"],
  ["Importing seasons", "importingSeasons"],
  ["Importing accounts", "importingAccounts"],
  ["Importing partners", "importingPartners"],
  ["Importing labour", "importingLabour"],
  ["Importing attendance", "importingAttendance"],
  ["Importing advances", "importingAdvances"],
  ["Importing vouchers", "importingVouchers"],
  ["Importing voucher items", "importingVoucherItems"],
  ["Repairing references", "repairingReferences"],
  ["Verifying import", "verifyingImport"],
  ["Completed", "completed"],
];

const CLEANUP_STAGES: Array<[string, string]> = [
  ["Stopping import worker", "stoppingImportWorker"],
  ["Finding imported records", "findingImportedRecords"],
  ["Removing operational records", "removingOperationalRecords"],
  ["Removing import failures", "removingImportFailures"],
  ["Cleaning seasons", "cleaningSeasons"],
  ["Cleaning farms", "cleaningFarms"],
  ["Detaching audit logs", "detachingAuditLogs"],
  ["Repairing session context", "repairingSessionContext"],
  ["Updating batch status", "updatingBatchStatus"],
  ["Completed", "completed"],
];

const STAGE_KEY_BY_TEXT: Record<string, string> = Object.fromEntries(
  [...IMPORT_STAGES, ...CLEANUP_STAGES, ["Starting cleanup...", "startingCleanup"] as [string, string]]
    .map(([text, key]) => [text.toLowerCase(), `migrationImport.stages.${key}`]),
);

function stageLabel(t: TFunction, raw: string | null | undefined): string {
  if (!raw) return "-";
  const key = STAGE_KEY_BY_TEXT[raw.trim().toLowerCase()];
  return key ? t(key) : raw;
}

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
  const { t } = useTranslation();
  const normalized = status.toLowerCase();
  const mapped = normalized === "in_progress" || normalized === "queued"
    ? "importing"
    : normalized === "partial_failed"
      ? "failed"
      : normalized;
  return <span className={`migration-status-badge migration-status-badge--${normalized}`}>{translateStatus(t, mapped)}</span>;
}

function SummaryGrid({ summary }: { summary: MigrationImportSummary }) {
  const { t } = useTranslation();
  const cards = [
    [t("migrationImport.counts.farms"), summary.counts.farms ?? 0],
    [t("migrationImport.counts.seasons"), summary.counts.seasons ?? 0],
    [t("migrationImport.counts.labour"), summary.counts.labour ?? summary.counts.labours ?? 0],
    [t("migrationImport.counts.attendance"), summary.counts.attendance ?? 0],
    [t("migrationImport.counts.expenses"), summary.counts.expenses ?? 0],
    [t("migrationImport.counts.expenseItems"), summary.counts.expenseItems ?? 0],
    [t("migrationImport.counts.accounts"), summary.counts.accounts ?? 0],
    [t("migrationImport.counts.partners"), summary.counts.partners ?? 0],
  ] as const;
  return (
    <div className="migration-summary">
      {cards.map(([label, value]) => (
        <article key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </article>
      ))}
      <article><span>{t("migrationImport.exportVersion")}</span><strong>{summary.exportVersion ?? "-"}</strong></article>
      <article><span>{t("migrationImport.exportedAt")}</span><strong>{summary.exportedAt ? formatDate(summary.exportedAt, { dateStyle: "medium", timeStyle: "short" }) : "-"}</strong></article>
      <article><span>{t("migrationImport.totalExpenses")}</span><strong>{formatMoney(summary.totalExpenses)}</strong></article>
      <article><span>{t("migrationImport.totalAdvances")}</span><strong>{formatMoney(summary.totalAdvances)}</strong></article>
    </div>
  );
}

function BalanceList({ title, rows }: { title: string; rows: Array<{ name: string; balance: number }> }) {
  const { t } = useTranslation();
  return (
    <section className="migration-balance-list">
      <h3>{title}</h3>
      {!rows.length ? <p className="activity-empty">{t("migrationImport.noBalances")}</p> : rows.map((row) => (
        <div key={row.name}>
          <span>{row.name}</span>
          <strong>{formatMoney(row.balance)}</strong>
        </div>
      ))}
    </section>
  );
}

function JobErrorPanel({ detail, onDownloadFailures }: { detail: MigrationImportJobDetail; onDownloadFailures: () => void }) {
  const { t } = useTranslation();
  const lastSuccessfulStep = [...detail.steps].reverse().find((step) => step.status === "completed")?.name ?? "-";
  return (
    <section className="admin-section-card migration-issues">
      <h2>{t("migrationImport.importFailure")}</h2>
      <p className="worker-action-error">{detail.error || detail.message || detail.firstFailureMessage || t("migrationImport.importFailed")}</p>
      <p><b>{t("migrationImport.jobId")}</b> {detail.jobId}</p>
      <p><b>{t("migrationImport.currentStep")}</b> {stageLabel(t, detail.currentStep)}</p>
      <p><b>{t("migrationImport.lastSuccessfulStep")}</b> {stageLabel(t, lastSuccessfulStep)}</p>
      <p><b>{t("migrationImport.imported")}</b> {detail.importedRows} · <b>{t("migrationImport.updated")}</b> {detail.updatedRows} · <b>{t("migrationImport.skipped")}</b> {detail.skippedRows} · <b>{t("migrationImport.failed")}</b> {detail.failedRows}</p>
      <div className="record-list__actions">
        <button type="button" className="secondary-button" onClick={onDownloadFailures}>{t("migrationImport.downloadFailureCsv")}</button>
      </div>
      {detail.failures.slice(0, 10).map((failure) => (
        <p key={failure.id}>
          <b>{failure.step}</b> {failure.sourceRow ? `· ${t("migrationImport.rowNumber", { row: failure.sourceRow })}` : ""} · {failure.errorMessage}
        </p>
      ))}
    </section>
  );
}

function IssueList({ issues }: { issues: MigrationImportIssue[] }) {
  const { t } = useTranslation();
  const [showDetails, setShowDetails] = useState(false);
  const errors = issues.filter((issue) => issue.level === "error");
  const warnings = issues.filter((issue) => issue.level === "warning");
  return (
    <section className="migration-issues">
      <h3>{t("migrationImport.validationWarnings")}</h3>
      {!issues.length ? <p className="positive">{t("migrationImport.noValidationIssues")}</p> : null}
      {errors.length ? (
        <div className="migration-callout migration-callout--error">
          <strong>{t("migrationImport.validationFailedTitle")}</strong>
          <p>{errors[0]?.message ?? t("migrationImport.importValidationFailed")}</p>
        </div>
      ) : null}
      {warnings.length ? (
        <div className="migration-callout migration-callout--warning">
          <strong>{t("migrationImport.warningCount", { count: warnings.length })}</strong>
          <p>{t("migrationImport.warningsDetected")}</p>
        </div>
      ) : null}
      {issues.length > 0 ? (
        <button type="button" className="secondary-button" onClick={() => setShowDetails((value) => !value)}>
          {showDetails ? t("migrationImport.hideDetails") : t("migrationImport.showDetails")}
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
  const { t } = useTranslation();
  return (
    <section className="migration-step-timeline">
      <h3>{title}</h3>
      <div className="migration-stage-list">
        {rows.map((row) => (
          <article key={row.label} className={`migration-stage-row migration-stage-row--${row.status}`}>
            <div>
              <strong>{stageLabel(t, row.label)}</strong>
              {row.detail ? <p>{row.detail}</p> : null}
            </div>
            <span>{translateStatus(t, row.status)}</span>
          </article>
        ))}
      </div>
    </section>
  );
}

function ProgressCard({ progress, stageRows, isCleanup }: { progress: MigrationImportProgress; stageRows: Array<{ label: string; status: StepStatus; detail?: string }>; isCleanup: boolean }) {
  const { t } = useTranslation();
  const staleSeconds = Math.max(0, Math.round((Date.now() - new Date(progress.updatedAt).getTime()) / 1000));
  const appearsStuck = progress.status === "running" && staleSeconds > 300;
  return (
    <section className="admin-section-card migration-progress-card">
      <div className="admin-section-heading">
        <div>
          <h2>{isCleanup ? t("migrationImport.step3CleanupTitle") : t("migrationImport.step3ImportTitle")}</h2>
          <p>{progress.message || (isCleanup ? t("migrationImport.cleanupDefaultMessage") : t("migrationImport.importDefaultMessage"))}</p>
        </div>
        <StatusBadge status={appearsStuck ? "stuck" : progress.status} />
      </div>
      <div className="migration-progress-meta">
        <div className="migration-progress-bar" aria-hidden="true"><div style={{ width: `${Math.max(0, Math.min(100, progress.percentage))}%` }} /></div>
        <div className="migration-progress-stats">
          <article><span>{t("migrationImport.progress")}</span><strong>{progress.percentage}%</strong></article>
          <article><span>{t("migrationImport.currentStage")}</span><strong>{stageLabel(t, progress.stage)}</strong></article>
          <article><span>{t("migrationImport.currentTask")}</span><strong>{stageLabel(t, progress.step)}</strong></article>
          <article><span>{t("migrationImport.processed")}</span><strong>{progress.processedCount} / {progress.totalCount || "-"}</strong></article>
          <article><span>{t("migrationImport.elapsed")}</span><strong>{t("migrationImport.secondsShort", { count: progress.elapsedSeconds })}</strong></article>
          <article><span>{t("migrationImport.lastUpdated")}</span><strong>{formatDate(progress.updatedAt, { timeStyle: "medium" })}</strong></article>
        </div>
      </div>
      <StepTimeline title={t("migrationImport.stagesTitle")} rows={stageRows} />
      {appearsStuck ? <p className="worker-action-error">{t("migrationImport.importAppearsStuck")}</p> : null}
    </section>
  );
}

function ResultCard({ validation, importResult, onReset }: { validation: Awaited<ReturnType<typeof validateMigrationImport>> | undefined; importResult: Awaited<ReturnType<typeof importMigrationData>> | undefined; onReset: () => void }) {
  const { t } = useTranslation();
  if (!validation) return null;
  const result = importResult?.result;
  const audit = result?.postImportAudit;
  return (
    <section className="admin-section-card migration-results">
      <div className="admin-section-heading">
        <div>
          <h2>{result ? t("migrationImport.step4ImportResult") : t("migrationImport.step4ValidationResult")}</h2>
          <p>{result ? t("migrationImport.importCompletedMessage") : validation.canImport ? t("migrationImport.validationPassedMessage") : t("migrationImport.validationIssuesMessage")}</p>
        </div>
        {result ? <StatusBadge status="completed" /> : <StatusBadge status={validation.canImport ? "ready" : "failed"} />}
      </div>
      <SummaryGrid summary={validation.summary} />
      <div className="migration-balance-grid">
        <BalanceList title={t("migrationImport.partnerBalances")} rows={validation.summary.partnerBalances} />
        <BalanceList title={t("migrationImport.cashBankBalances")} rows={validation.summary.cashBankBalances} />
      </div>
      <IssueList issues={validation.issues} />
      {result ? (
        <div className="migration-result-grid">
          <article><span>{t("migrationImport.duration")}</span><strong>{result.startedAt && result.completedAt ? t("migrationImport.secondsShort", { count: Math.max(1, Math.round((new Date(result.completedAt).getTime() - new Date(result.startedAt).getTime()) / 1000)) }) : "-"}</strong></article>
          <article><span>{t("migrationImport.importedRows")}</span><strong>{result.importCounts.reduce((sum, item) => sum + item.count, 0)}</strong></article>
          <article><span>{t("migrationImport.updatedRows")}</span><strong>{result.logs?.reduce((sum, item) => sum + (item.updatedRows ?? 0), 0) ?? 0}</strong></article>
          <article><span>{t("migrationImport.warnings")}</span><strong>{validation.issues.filter((issue) => issue.level === "warning").length}</strong></article>
          <article><span>{t("migrationImport.failures")}</span><strong>{typeof result.failedRows === "number" ? result.failedRows : 0}</strong></article>
          <article><span>{t("migrationImport.insertedOperationalRecords")}</span><strong>{result.insertedOperationalRecords}</strong></article>
          {result.importCounts.map((item) => <article key={item.key}><span>{translateRecordType(t, item.key) || item.label}</span><strong>{item.count}</strong></article>)}
        </div>
      ) : null}
      {audit ? (
        <section className="migration-issues">
          <h3>{t("migrationImport.auditSummary")}</h3>
          <p><b>{t("migrationImport.voucherNumberAudit")}</b> {t("migrationImport.voucherNumberAuditLine", { mismatches: audit.voucherNumberAudit.mismatches.length, duplicates: audit.voucherNumberAudit.duplicateImportedVoucherNumbers.length })}</p>
          <p><b>{t("migrationImport.relationshipAudit")}</b> {t("migrationImport.relationshipAuditLine", {
            attendanceLinked: audit.relationshipAudit.attendanceLinkedToLabour,
            attendanceTotal: audit.relationshipAudit.attendanceTotal,
            advancesLinked: audit.relationshipAudit.advancesLinkedToLabour,
            advancesTotal: audit.relationshipAudit.advancesTotal,
            vouchersLinked: audit.relationshipAudit.vouchersLinkedToPaymentAccount,
            vouchersTotal: audit.relationshipAudit.vouchersTotal,
          })}</p>
          <p><b>{t("migrationImport.visibilityAuditLabel")}</b> {t("migrationImport.visibilityAuditLine", { farms: audit.tableCounts.farms, seasons: audit.tableCounts.seasons, failedBatches: audit.tableCounts.failedOrPartialBatches })}</p>
        </section>
      ) : null}
      {result ? (
        <div className="record-list__actions">
          <Link className="secondary-button" to={result.attendanceJobId ? `/admin/imports/${result.attendanceJobId}` : "#"}>{t("migrationImport.viewFullReport")}</Link>
          <button type="button" className="secondary-button" onClick={onReset}>{t("migrationImport.importAnotherFile")}</button>
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
  const { t } = useTranslation();
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
          <h2>{t("migrationImport.step6Title")}</h2>
          <p>{t("migrationImport.step6Description")}</p>
        </div>
      </div>
      {!batches.length ? <p className="activity-empty">{t("migrationImport.noHistory")}</p> : null}
      {batches.length ? (
        <div className="migration-history-table-wrap">
          <table className="migration-history-table">
            <thead>
              <tr>
                <th>{t("migrationImport.colDate")}</th>
                <th>{t("migrationImport.colFile")}</th>
                <th>{t("migrationImport.colWorkspace")}</th>
                <th>{t("migrationImport.colStatus")}</th>
                <th>{t("migrationImport.colDuration")}</th>
                <th>{t("migrationImport.colSummary")}</th>
                <th>{t("migrationImport.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {batches.slice(0, 12).map((batch) => {
                const duration = batch.completedAt ? t("migrationImport.secondsShort", { count: Math.max(1, Math.round((new Date(batch.completedAt).getTime() - new Date(batch.startedAt).getTime()) / 1000)) }) : "-";
                return (
                  <tr key={batch.id}>
                    <td>{formatDate(batch.startedAt, { dateStyle: "medium", timeStyle: "short" })}</td>
                    <td title={batch.fileName ?? t("migrationImport.importedJson")}>{batch.fileName ?? t("migrationImport.importedJson")}</td>
                    <td>{workspaceLabel}</td>
                    <td><StatusBadge status={batch.status} /></td>
                    <td>{duration}</td>
                    <td>{t("migrationImport.historyUpdatedCell", { hash: batch.fileHash.slice(0, 10), time: formatDate(batch.updatedAt, { timeStyle: "short" }) })}</td>
                    <td><button type="button" className="secondary-button" onClick={() => onSelectBatch(selectedBatchId === batch.id ? null : batch.id)}>{t("migrationImport.viewDetails")}</button></td>
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
              <h3>{t("migrationImport.batchDetails")}</h3>
              <p>{selectedBatchId}</p>
            </div>
            <button type="button" className="secondary-button" onClick={() => onSelectBatch(null)}>{t("common.close")}</button>
          </div>
          {!selectedRecords.length ? <p className="activity-empty">{t("migrationImport.noBatchLogs")}</p> : null}
          {selectedRecords.map((record) => {
            const details = readLogDetails(record);
            return (
              <p key={record.id} className={details.status === "failed" ? "negative" : undefined}>
                <b>{stageLabel(t, details.step)}</b> {translateStatus(t, details.status)}
                {typeof details.sourceRows === "number" ? ` · ${t("migrationImport.sourceCount", { count: details.sourceRows })}` : ""}
                {typeof details.importedRows === "number" ? ` · ${t("migrationImport.importedCount", { count: details.importedRows })}` : ""}
                {typeof details.updatedRows === "number" ? ` · ${t("migrationImport.updatedCount", { count: details.updatedRows })}` : ""}
                {typeof details.skippedRows === "number" ? ` · ${t("migrationImport.skippedCount", { count: details.skippedRows })}` : ""}
                {typeof details.failedRows === "number" ? ` · ${t("migrationImport.failedCount", { count: details.failedRows })}` : ""}
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
  const { t } = useTranslation();
  return (
    <section className="migration-callout">
      <div className="admin-section-heading">
        <div>
          <h3>{t("migrationImport.repairContextTitle")}</h3>
          <p>{t("migrationImport.repairContextDescription")}</p>
        </div>
      </div>
      <div className="migration-result-grid">
        <article><span>{t("migrationImport.canonicalFarm")}</span><strong>{preview.canonicalFarm ? `${preview.canonicalFarm.name}` : t("migrationImport.none")}</strong></article>
        <article><span>{t("migrationImport.canonicalSeason")}</span><strong>{preview.canonicalSeason ? `${preview.canonicalSeason.name}` : t("migrationImport.willCreateFallback")}</strong></article>
        <article><span>{t("migrationImport.oldFarmsFound")}</span><strong>{preview.oldFarms.length}</strong></article>
        <article><span>{t("migrationImport.oldSeasonsFound")}</span><strong>{preview.oldSeasons.length}</strong></article>
        <article><span>{t("migrationImport.voucherMismatchesBefore")}</span><strong>{preview.voucherNumberMismatchesBefore}</strong></article>
        <article><span>{t("migrationImport.deletedVouchersExcluded")}</span><strong>{preview.deletedRecordsExcludedCount}</strong></article>
      </div>
      {preview.recordsRemapPreview.length ? (
        <div className="attendance-import-table-wrap">
          <table className="attendance-import-table">
            <thead><tr><th>{t("migrationImport.colEntity")}</th><th>{t("migrationImport.colRecordsToRemap")}</th></tr></thead>
            <tbody>{preview.recordsRemapPreview.map((row) => <tr key={row.entityType}><td>{translateRecordType(t, row.entityType)}</td><td>{row.count}</td></tr>)}</tbody>
          </table>
        </div>
      ) : <p>{t("migrationImport.noRemapNeeded")}</p>}
      {preview.oldFarms.length ? <p className="migration-context"><b>{t("migrationImport.oldFarmsLabel")}</b> {preview.oldFarms.map((farm) => `${farm.name} [${farm.reasons.join(", ")}]`).join(" • ")}</p> : null}
      {preview.oldSeasons.length ? <p className="migration-context"><b>{t("migrationImport.oldSeasonsLabel")}</b> {preview.oldSeasons.map((season) => `${season.name} [${season.reasons.join(", ")}]`).join(" • ")}</p> : null}
      {preview.duplicateActiveVoucherNumbersProjected.length ? <p className="worker-action-error">{t("migrationImport.projectedDuplicates", { list: preview.duplicateActiveVoucherNumbersProjected.map((group) => group.voucherNumber).join(", ") })}</p> : null}
      <label className="inline-checkbox">
        <input type="checkbox" checked={backupConfirmed} onChange={(event) => onBackupConfirmed(event.target.checked)} />
        <span>{t("migrationImport.backupConfirmContext")}</span>
      </label>
      {repairResult ? <p className="positive">{t("migrationImport.repairedByEntityResult", {
        list: repairResult.repairedByEntity.map((row) => `${translateRecordType(t, row.entityType)} ${row.count}`).join(" • ") || "0",
        mismatches: repairResult.voucherNumberMismatchesAfter,
        duplicates: repairResult.duplicateActiveVoucherNumbersAfter.length,
      })}</p> : null}
    </section>
  );
}

export function MigrationImport() {
  const { t } = useTranslation();
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
      confirmationText: CLEANUP_CONFIRMATION_PHRASE,
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
      setFileError(t("migrationImport.fileNotJson"));
      return;
    }
    try {
      setPayload(JSON.parse(await file.text()) as unknown);
    } catch {
      setFileError(t("migrationImport.fileInvalidJson"));
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
  const cleanupCanSubmit = Boolean(latestBatch && cleanupPreview.data?.preview && cleanupBackupConfirmed && cleanupConfirmationText === CLEANUP_CONFIRMATION_PHRASE && !cleanFailedImport.isPending);
  const cleanupProgress = operationIntent === "cleanup"
    ? (operationProgress.data ?? cleanupStartingProgress)
    : null;
  const importProgress = operationIntent !== "cleanup"
    ? operationProgress.data
    : null;

  const buildImportStageRows = (progressSource?: MigrationImportProgress | null) => {
    const stages = IMPORT_STAGES.map(([text]) => text);
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
    const stages = CLEANUP_STAGES.map(([text]) => text);
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
          <span className="eyebrow">{t("migrationImport.eyebrow")}</span>
          <h1>{t("migrationImport.title")}</h1>
          <p>{t("migrationImport.subtitle")}</p>
        </div>
        <StatusBadge status={pageStatus} />
      </header>

      <section className="admin-section-card migration-form">
        <div className="admin-section-heading">
          <div>
            <h2>{t("migrationImport.step1Title")}</h2>
            <p>{t("migrationImport.step1Description")}</p>
          </div>
        </div>
        <label>
          <span>{t("migrationImport.targetWorkspace")}</span>
          <select value={workspaceId} disabled={blockingOperation} onChange={(event) => {
            setWorkspaceId(event.target.value);
            setSelectedHistoryBatchId(null);
          }}>
            <option value="">{t("migrationImport.selectWorkspace")}</option>
            {workspaceOptions.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name} ({translateStatus(t, workspace.status)})</option>)}
          </select>
        </label>
        {selectedWorkspace ? <p className="migration-context">{t("migrationImport.importTarget")} <b>{selectedWorkspace.name}</b> · {selectedWorkspace.contactEmail}</p> : null}
        <label className={`migration-file-picker${blockingOperation ? " migration-file-picker--disabled" : ""}`}>
          <FileJson size={18} />
          <span>{fileName || t("migrationImport.chooseFile")}</span>
          <input accept="application/json,.json" type="file" disabled={blockingOperation} onChange={(event) => void readFile(event)} />
        </label>
        {fileError ? <p className="worker-action-error">{fileError}</p> : null}
        <label className="inline-checkbox">
          <input type="checkbox" checked={allowSummaryMismatch} disabled={blockingOperation} onChange={(event) => setAllowSummaryMismatch(event.target.checked)} />
          <span>{t("migrationImport.allowSummaryMismatch")}</span>
        </label>
        <div className="record-list__actions">
          <button type="button" disabled={!canValidate} onClick={() => validate.mutate()}><UploadCloud size={16} />{t("migrationImport.validateImport")}</button>
          <button type="button" disabled={!canImport} onClick={() => { setOperationIntent("import"); runImport.mutate(); }}><Database size={16} />{t("migrationImport.importData")}</button>
        </div>
        {isImportRunning && currentImportJob ? (
          <p className="positive">
            {t("migrationImport.importJobRunning", { jobId: currentImportJob.jobId })}
          </p>
        ) : null}
        {validate.error ? <p className="worker-action-error">{validate.error instanceof Error ? validate.error.message : t("migrationImport.validationFailed")}</p> : null}
        {runImport.error ? <p className="worker-action-error">{runImport.error instanceof Error ? runImport.error.message : t("migrationImport.importFailed")}</p> : null}
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
              <h2>{t("migrationImport.cleanupResultTitle")}</h2>
              <p>{cleanFailedImport.data.message}</p>
            </div>
            <StatusBadge status={cleanFailedImport.data.result.batchStatus} />
          </div>
          <div className="migration-result-grid">
            <article><span>{t("migrationImport.operationalRecordsRemoved")}</span><strong>{cleanFailedImport.data.result.operationalRecordsRemoved}</strong></article>
            <article><span>{t("migrationImport.importFailuresRemoved")}</span><strong>{cleanFailedImport.data.result.importFailuresRemoved}</strong></article>
            <article><span>{t("migrationImport.seasonsHardDeleted")}</span><strong>{cleanFailedImport.data.result.seasonsHardDeleted}</strong></article>
            <article><span>{t("migrationImport.seasonsSoftDeleted")}</span><strong>{cleanFailedImport.data.result.seasonsSoftDeleted}</strong></article>
            <article><span>{t("migrationImport.farmsHardDeleted")}</span><strong>{cleanFailedImport.data.result.farmsHardDeleted}</strong></article>
            <article><span>{t("migrationImport.farmsSoftDeleted")}</span><strong>{cleanFailedImport.data.result.farmsSoftDeleted}</strong></article>
            <article><span>{t("migrationImport.auditLogsDetached")}</span><strong>{cleanFailedImport.data.result.auditLogsDetached}</strong></article>
            <article><span>{t("migrationImport.protectedRecordsSkipped")}</span><strong>{cleanFailedImport.data.result.skippedProtectedRecords}</strong></article>
          </div>
          {cleanFailedImport.data.result.contextMessage ? <p className="migration-context"><b>{t("migrationImport.contextRepair")}</b> {cleanFailedImport.data.result.contextMessage}</p> : null}
        </section>
      ) : null}

      <section className="admin-section-card migration-advanced-card">
        <button type="button" className="migration-section-toggle" onClick={() => setAdvancedOpen((value) => !value)}>
          <span>{t("migrationImport.step5Title")}</span>
          {advancedOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>
        {advancedOpen ? (
          <div className="migration-advanced-body">
            <div className="record-list__actions">
              <button type="button" className="secondary-button" disabled={!token || !workspaceId || importContextPreview.isFetching || blockingOperation} onClick={() => { void importContextPreview.refetch(); }}>
                {t("migrationImport.previewRepairContext")}
              </button>
              <button type="button" className="secondary-button" disabled={!token || !workspaceId || !importContextBackupConfirmed || repairImportContext.isPending || blockingOperation} onClick={() => repairImportContext.mutate()}>
                {t("migrationImport.repairContext")}
              </button>
              <button type="button" className="secondary-button" disabled={!token || !workspaceId || repairVisibility.isPending || blockingOperation} onClick={() => repairVisibility.mutate()}>
                {t("migrationImport.repairVisibility")}
              </button>
              <button type="button" className="secondary-button" disabled={!token || !workspaceId || repairDeletedState.isPending || blockingOperation} onClick={() => repairDeletedState.mutate()}>
                {t("migrationImport.repairDeletedState")}
              </button>
              <button type="button" className="secondary-button" disabled={!token || !workspaceId || repairDuplicateAccounts.isPending || blockingOperation} onClick={() => repairDuplicateAccounts.mutate()}>
                {t("migrationImport.repairDuplicateAccounts")}
              </button>
              <button type="button" className="secondary-button" disabled={!token || !workspaceId || repairVoucherNumbers.isPending || blockingOperation} onClick={() => repairVoucherNumbers.mutate()}>
                {t("migrationImport.repairVoucherNumbers")}
              </button>
              <button type="button" className="secondary-button" onClick={() => setVisibilityAuditOpen((value) => !value)}>
                {t("migrationImport.runVisibilityAudit")}
              </button>
            </div>
            {importContextPreview.data?.preview ? <ImportContextRepairPreviewCard
              preview={importContextPreview.data.preview}
              backupConfirmed={importContextBackupConfirmed}
              onBackupConfirmed={setImportContextBackupConfirmed}
              repairResult={repairImportContext.data ?? null}
            /> : null}
            {repairImportContext.data ? <p className="positive">{repairImportContext.data.message} {t("migrationImport.repairContextResult", { records: repairImportContext.data.repairedOperationalRecords, mismatches: repairImportContext.data.voucherNumberMismatchesAfter, duplicates: repairImportContext.data.duplicateActiveVoucherNumbersAfter.length })}</p> : null}
            {repairVisibility.data ? <p className="positive">{repairVisibility.data.message} {t("migrationImport.repairVisibilityResult", { count: repairVisibility.data.repairedRecords })}</p> : null}
            {repairDeletedState.data ? <p className="positive">{repairDeletedState.data.message} {t("migrationImport.repairDeletedResult", { farms: repairDeletedState.data.farmsDeactivated, seasons: repairDeletedState.data.seasonsDeactivated })}</p> : null}
            {repairDuplicateAccounts.data ? <p className="positive">{repairDuplicateAccounts.data.message} {t("migrationImport.repairDuplicateResult", { groups: repairDuplicateAccounts.data.duplicateGroupsBefore, remapped: repairDuplicateAccounts.data.childRecordsRemapped, removed: repairDuplicateAccounts.data.duplicateAccountsRemoved })}</p> : null}
            {repairVoucherNumbers.data ? <p className="positive">{repairVoucherNumbers.data.message} {t("migrationImport.repairVoucherResult", { updated: repairVoucherNumbers.data.vouchersUpdated, before: repairVoucherNumbers.data.mismatchesBefore, after: repairVoucherNumbers.data.mismatchesAfter })}</p> : null}
            {importContextPreview.error ? <p className="worker-action-error">{importContextPreview.error instanceof Error ? importContextPreview.error.message : t("migrationImport.previewContextFailed")}</p> : null}
            {repairImportContext.error ? <p className="worker-action-error">{repairImportContext.error instanceof Error ? repairImportContext.error.message : t("migrationImport.contextRepairFailed")}</p> : null}
            {repairVisibility.error ? <p className="worker-action-error">{repairVisibility.error instanceof Error ? repairVisibility.error.message : t("migrationImport.visibilityRepairFailed")}</p> : null}
            {repairDeletedState.error ? <p className="worker-action-error">{repairDeletedState.error instanceof Error ? repairDeletedState.error.message : t("migrationImport.deletedStateRepairFailed")}</p> : null}
            {repairDuplicateAccounts.error ? <p className="worker-action-error">{repairDuplicateAccounts.error instanceof Error ? repairDuplicateAccounts.error.message : t("migrationImport.duplicateAccountsRepairFailed")}</p> : null}
            {repairVoucherNumbers.error ? <p className="worker-action-error">{repairVoucherNumbers.error instanceof Error ? repairVoucherNumbers.error.message : t("migrationImport.voucherNumbersRepairFailed")}</p> : null}

            {visibilityAuditOpen && workspaceId ? <ImportVisibilityAuditPanel workspaceId={workspaceId} title={t("importVisibilityAudit.title")} /> : null}

            {latestBatch ? (
              <div className="migration-danger-zone">
                <div className="migration-callout migration-callout--danger">
                  <strong>{t("migrationImport.dangerTitle")}</strong>
                  <p>{t("migrationImport.dangerDescription")}</p>
                </div>
                <div className="record-list__actions">
                  <button type="button" className="secondary-button" disabled={cleanupPreview.isFetching} onClick={() => { void cleanupPreview.refetch(); }}>
                    {t("migrationImport.previewCleanup")}
                  </button>
                </div>
                {cleanupPreview.data?.preview ? (
                  <div className="migration-result-grid">
                    <article><span>{t("migrationImport.batchStatus")}</span><strong>{translateStatus(t, cleanupPreview.data.preview.status)}</strong></article>
                    <article><span>{t("migrationImport.importFailuresCount")}</span><strong>{cleanupPreview.data.preview.importFailures}</strong></article>
                    <article><span>{t("migrationImport.importedFarms")}</span><strong>{cleanupPreview.data.preview.importedFarms}</strong></article>
                    <article><span>{t("migrationImport.importedSeasons")}</span><strong>{cleanupPreview.data.preview.importedSeasons}</strong></article>
                    <article><span>{t("migrationImport.editedImportedRecords")}</span><strong>{cleanupPreview.data.preview.editedImportedRecords}</strong></article>
                    <article><span>{t("migrationImport.openFailedBatches")}</span><strong>{cleanupPreview.data.preview.openImportBatches}</strong></article>
                  </div>
                ) : null}
                <label className="inline-checkbox">
                  <input type="checkbox" checked={cleanupBackupConfirmed} onChange={(event) => setCleanupBackupConfirmed(event.target.checked)} />
                  <span>{t("migrationImport.backupConfirmCleanup")}</span>
                </label>
                <label className="inline-checkbox">
                  <input type="checkbox" checked={cleanupIncludeEdited} onChange={(event) => setCleanupIncludeEdited(event.target.checked)} />
                  <span>{t("migrationImport.includeEditedRecords")}</span>
                </label>
                <label className="migration-confirmation-field">
                  <span>{t("migrationImport.typeConfirmation")}</span>
                  <div className="migration-confirmation-hint">{CLEANUP_CONFIRMATION_PHRASE}</div>
                  <input
                    type="text"
                    value={cleanupConfirmationText}
                    onChange={(event) => setCleanupConfirmationText(event.target.value)}
                    placeholder={t("migrationImport.confirmationPlaceholder", { phrase: CLEANUP_CONFIRMATION_PHRASE })}
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
                    {cleanFailedImport.isPending ? t("migrationImport.startingCleanup") : t("migrationImport.cancelCleanButton")}
                  </button>
                </div>
                {cleanFailedImport.isPending && !operationProgress.data ? <p className="positive">{t("migrationImport.startingCleanup")}</p> : null}
                {cleanupPreview.error ? <p className="worker-action-error">{cleanupPreview.error instanceof Error ? cleanupPreview.error.message : t("migrationImport.cleanupPreviewFailed")}</p> : null}
                {cleanFailedImport.error ? <p className="worker-action-error">{formatApiError(cleanFailedImport.error, t("migrationImport.cleanupFailed"))}</p> : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      {workspaceId ? <HistoryTable batches={batches.data?.records ?? []} records={history.data?.records ?? []} selectedBatchId={selectedHistoryBatchId} onSelectBatch={setSelectedHistoryBatchId} workspaceLabel={selectedWorkspace?.name ?? t("migrationImport.selectedWorkspaceFallback")} /> : null}

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
