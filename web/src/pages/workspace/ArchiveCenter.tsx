import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { ArchiveRestore, CircleAlert, Layers3, Lock, RotateCcw, ShieldCheck, SquareCheckBig } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../auth/AuthProvider";
import { SearchInput } from "../../components/SearchInput";
import { SubpageHeader } from "../../components/SubpageHeader";
import { useSyncState } from "../../hooks/useSyncState";
import {
  archiveLabourBatch,
  fetchLabourArchiveBatches,
  previewLabourArchive,
  restoreLabourArchiveBatch,
  type LabourArchiveBatch,
  type LabourArchivePreview,
  type LabourArchiveType,
  type LabourArchiveValidation,
  validateLabourArchive,
} from "../../lib/api";
import { getActiveFarmId, getActiveSeasonId } from "../../lib/offline-db";
import { canCreate } from "../../lib/permissions";

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 8)}01`;

type ArchiveFormState = {
  archiveType: LabourArchiveType;
  archiveReason: string;
  attendanceFrom: string;
  attendanceTo: string;
  labourWorkFrom: string;
  labourWorkTo: string;
  advancesFrom: string;
  advancesTo: string;
  settlementFrom: string;
  settlementTo: string;
};

const defaultForm: ArchiveFormState = {
  archiveType: "labour_period",
  archiveReason: "",
  attendanceFrom: monthStart(),
  attendanceTo: today(),
  labourWorkFrom: monthStart(),
  labourWorkTo: today(),
  advancesFrom: monthStart(),
  advancesTo: today(),
  settlementFrom: monthStart(),
  settlementTo: today(),
};

export function ArchiveCenter() {
  const { t } = useTranslation();
  const { token, user } = useAuth();
  const sync = useSyncState();
  const workspaceId = user?.workspaceId ?? "";
  const activeFarmId = getActiveFarmId();
  const activeSeasonId = getActiveSeasonId();
  const canManage = Boolean(user && workspaceId && (canCreate(user, "wages", workspaceId) || canCreate(user, "workforce", workspaceId)));
  const [form, setForm] = useState<ArchiveFormState>(defaultForm);
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<LabourArchivePreview | null>(null);
  const [validation, setValidation] = useState<LabourArchiveValidation | null>(null);
  const [batches, setBatches] = useState<LabourArchiveBatch[]>([]);
  const [validatedBatch, setValidatedBatch] = useState<LabourArchiveBatch | null>(null);
  const [loadingBatches, setLoadingBatches] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const updateRange = (key: "attendance" | "labourWork" | "advances" | "settlement", field: "From" | "To", value: string) => {
    const target = `${key}${field}` as keyof ArchiveFormState;
    setForm((current) => ({ ...current, [target]: value }));
  };

  const refreshBatches = useCallback(async () => {
    if (!token || !workspaceId || !activeFarmId || !activeSeasonId) return;
    setLoadingBatches(true);
    try {
      const response = await fetchLabourArchiveBatches(token, workspaceId, { farmId: activeFarmId, seasonId: activeSeasonId });
      setBatches(response.batches);
    } catch {
      // keep local cache if the network is unavailable
    } finally {
      setLoadingBatches(false);
    }
  }, [activeFarmId, activeSeasonId, token, workspaceId]);

  useEffect(() => {
    void refreshBatches();
    const handle = () => void refreshBatches();
    window.addEventListener("muzare-data-refresh", handle);
    window.addEventListener("muzare-local-data-change", handle);
    return () => {
      window.removeEventListener("muzare-data-refresh", handle);
      window.removeEventListener("muzare-local-data-change", handle);
    };
  }, [refreshBatches]);

  const syncStatus = sync.status === "offline"
    ? t("layout.workingOffline")
    : sync.status === "syncing"
      ? t("layout.syncing")
      : sync.status === "error"
        ? t("layout.syncFailed")
        : sync.pendingCount
          ? t("layout.changesWaiting", { count: sync.pendingCount })
          : t("layout.synced");

  const visibleBatches = useMemo(() => batches.filter((batch) => {
    const term = query.trim().toLowerCase();
    if (!term) return true;
    return [
      batch.archiveReason,
      batch.archiveType,
      batch.status,
      batch.id,
      batch.attendanceFrom,
      batch.attendanceTo,
      batch.labourWorkFrom,
      batch.labourWorkTo,
      batch.advancesFrom,
      batch.advancesTo,
      batch.settlementFrom,
      batch.settlementTo,
    ].some((value) => String(value ?? "").toLowerCase().includes(term));
  }), [batches, query]);

  const submitPreview = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setSuccess("");
    if (!canManage) {
      setError(t("common.viewOnlyAccess"));
      return;
    }
    if (!token || !workspaceId || !activeFarmId || !activeSeasonId) {
      setError(t("farmsPage.noActiveSeason"));
      return;
    }
    if (!form.archiveReason.trim()) {
      setError("Add an archive reason before previewing.");
      return;
    }
    setSubmitting(true);
    try {
      const response = await previewLabourArchive(token, workspaceId, {
        farmId: activeFarmId,
        seasonId: activeSeasonId,
        archiveType: form.archiveType,
        archiveReason: form.archiveReason.trim(),
        attendanceFrom: form.attendanceFrom || undefined,
        attendanceTo: form.attendanceTo || undefined,
        labourWorkFrom: form.labourWorkFrom || undefined,
        labourWorkTo: form.labourWorkTo || undefined,
        advancesFrom: form.advancesFrom || undefined,
        advancesTo: form.advancesTo || undefined,
        settlementFrom: form.settlementFrom || undefined,
        settlementTo: form.settlementTo || undefined,
      });
      setPreview(response.preview);
      setValidation(response.validationSummary);
      setValidatedBatch(null);
      setSuccess(response.canArchive ? "Archive preview is ready." : "Archive preview found blocking issues.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to preview archive.");
    } finally {
      setSubmitting(false);
    }
  };

  const submitValidate = async () => {
    if (!token || !workspaceId || !activeFarmId || !activeSeasonId) return;
    if (!canManage) {
      setError(t("common.viewOnlyAccess"));
      return;
    }
    if (!form.archiveReason.trim()) {
      setError("Add an archive reason before validating.");
      return;
    }
    setSubmitting(true);
    setError("");
    setSuccess("");
    try {
      const response = await validateLabourArchive(token, workspaceId, {
        farmId: activeFarmId,
        seasonId: activeSeasonId,
        archiveType: form.archiveType,
        archiveReason: form.archiveReason.trim(),
        attendanceFrom: form.attendanceFrom || undefined,
        attendanceTo: form.attendanceTo || undefined,
        labourWorkFrom: form.labourWorkFrom || undefined,
        labourWorkTo: form.labourWorkTo || undefined,
        advancesFrom: form.advancesFrom || undefined,
        advancesTo: form.advancesTo || undefined,
        settlementFrom: form.settlementFrom || undefined,
        settlementTo: form.settlementTo || undefined,
      });
      setPreview(response.preview);
      setValidation(response.validationSummary);
      setValidatedBatch(response.batch);
      setSuccess(response.validationSummary.blocking ? "Validation found issues that must be resolved." : "Archive validated successfully.");
      await refreshBatches();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to validate archive.");
    } finally {
      setSubmitting(false);
    }
  };

  const submitArchive = async () => {
    if (!token || !workspaceId || !validatedBatch) return;
    if (!canManage) {
      setError(t("common.viewOnlyAccess"));
      return;
    }
    if (validation?.blocking) {
      setError("Resolve the validation issues before archiving.");
      return;
    }
    setSubmitting(true);
    setError("");
    setSuccess("");
    try {
      const response = await archiveLabourBatch(token, workspaceId, validatedBatch.id);
      setSuccess(`Archived ${response.archivedCount} records.`);
      setValidatedBatch(null);
      await refreshBatches();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to archive the selected period.");
    } finally {
      setSubmitting(false);
    }
  };

  const restoreBatch = async (batch: LabourArchiveBatch) => {
    if (!token || !workspaceId) return;
    if (!canManage) {
      setError(t("common.viewOnlyAccess"));
      return;
    }
    setSubmitting(true);
    setError("");
    setSuccess("");
    try {
      const response = await restoreLabourArchiveBatch(token, workspaceId, batch.id);
      setSuccess(`Restored ${response.restoredCount} records.`);
      await refreshBatches();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to restore the selected archive batch.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="dashboard-page">
      <SubpageHeader title="Archive Center" />
      <main className="subpage module-workspace archive-center-page">
        <section className="workspace-intro">
          <div>
            <h2>Labour Period Close + Archive</h2>
            <p>Close a labour period, validate the data, archive the batch, and restore it later without losing accounting history.</p>
          </div>
          <div className={`archive-center__status sync-badge sync-badge--${sync.status}`}>
            {syncStatus}
          </div>
        </section>

        {error ? <section className="record-panel archive-center__notice archive-center__notice--error"><CircleAlert size={16} /> <span>{error}</span></section> : null}
        {success ? <section className="record-panel archive-center__notice archive-center__notice--success"><ShieldCheck size={16} /> <span>{success}</span></section> : null}

        <form className="archive-center__form" onSubmit={submitPreview}>
          <section className="record-panel archive-center__card">
            <div className="archive-center__card-header">
              <div>
                <h3>Archive batch</h3>
                <p>Separate date ranges keep attendance, work, advances, and settlements independent.</p>
              </div>
              <span className={`archive-center__badge archive-center__badge--${form.archiveType}`}>{form.archiveType.replaceAll("_", " ")}</span>
            </div>
            <div className="archive-center__grid">
              <label className="archive-center__field">
                <span>Archive type</span>
                <select value={form.archiveType} onChange={(event) => setForm((current) => ({ ...current, archiveType: event.target.value as LabourArchiveType }))}>
                  <option value="labour_period">Labour Period Archive</option>
                  <option value="attendance">Attendance Archive</option>
                  <option value="advances_payments">Advances / Payments Archive</option>
                  <option value="wage_settlement">Wage Settlement Archive</option>
                  <option value="full_period">Full Period Archive</option>
                </select>
              </label>
              <label className="archive-center__field archive-center__field--full">
                <span>Archive reason</span>
                <input value={form.archiveReason} onChange={(event) => setForm((current) => ({ ...current, archiveReason: event.target.value }))} placeholder="Why are we closing this period?" />
              </label>
            </div>
          </section>

          <section className="archive-center__range-grid">
            {[
              { key: "attendance" as const, title: "Attendance", from: form.attendanceFrom, to: form.attendanceTo },
              { key: "labourWork" as const, title: "Labour Work", from: form.labourWorkFrom, to: form.labourWorkTo },
              { key: "advances" as const, title: "Advances / Payments", from: form.advancesFrom, to: form.advancesTo },
              { key: "settlement" as const, title: "Wage Settlements", from: form.settlementFrom, to: form.settlementTo },
            ].map((section) => (
              <article className="record-panel archive-center__range-card" key={section.key}>
                <div className="archive-center__card-header">
                  <div>
                    <h3>{section.title}</h3>
                    <p>Use a module-specific date range. It does not have to match the other modules.</p>
                  </div>
                  <Layers3 size={16} />
                </div>
                <div className="archive-center__grid">
                  <label className="archive-center__field">
                    <span>From</span>
                    <input type="date" value={section.from} onChange={(event) => updateRange(section.key, "From", event.target.value)} />
                  </label>
                  <label className="archive-center__field">
                    <span>To</span>
                    <input type="date" value={section.to} onChange={(event) => updateRange(section.key, "To", event.target.value)} />
                  </label>
                </div>
              </article>
            ))}
          </section>

          <section className="archive-center__actions">
            <button className="secondary-action" type="submit" disabled={submitting || !canManage}>Preview Records</button>
            <button className="secondary-action" type="button" disabled={submitting || !canManage} onClick={() => void submitValidate()}>Validate Archive</button>
            <button className="primary-action" type="button" disabled={submitting || !canManage || !validatedBatch || validation?.blocking} onClick={() => void submitArchive()}>Archive Closed Period</button>
          </section>
        </form>

        {preview || validation ? (
          <section className="archive-center__summary-grid">
            <article className="record-panel archive-center__summary-card">
              <span>Attendance</span>
              <strong>{preview?.attendanceCount ?? 0}</strong>
            </article>
            <article className="record-panel archive-center__summary-card">
              <span>Labour work</span>
              <strong>{preview?.labourWorkCount ?? 0}</strong>
            </article>
            <article className="record-panel archive-center__summary-card">
              <span>Advances / payments</span>
              <strong>{preview?.advanceCount ?? 0}</strong>
            </article>
            <article className="record-panel archive-center__summary-card">
              <span>Settlements</span>
              <strong>{preview?.settlementCount ?? 0}</strong>
            </article>
            <article className="record-panel archive-center__summary-card">
              <span>Linked vouchers</span>
              <strong>{preview?.voucherCount ?? 0}</strong>
            </article>
            <article className="record-panel archive-center__summary-card">
              <span>Affected labour</span>
              <strong>{preview?.affectedLabourCount ?? 0}</strong>
            </article>
          </section>
        ) : null}

        {preview ? (
          <section className="record-panel archive-center__detail-card">
            <div className="archive-center__card-header">
              <div>
                <h3>Preview summary</h3>
                <p>Archived financial records still remain in ledgers, reconciliation, and history views.</p>
              </div>
              {validation?.blocking ? <span className="archive-center__warning"><Lock size={14} /> Blocked</span> : <span className="archive-center__ok"><SquareCheckBig size={14} /> Ready</span>}
            </div>
            <div className="archive-center__detail-grid">
              <div>
                <strong>Affected accounts</strong>
                <p>{preview.affectedAccounts.length ? preview.affectedAccounts.join(", ") : "None"}</p>
              </div>
              <div>
                <strong>Affected partners</strong>
                <p>{preview.affectedPartners.length ? preview.affectedPartners.join(", ") : "None"}</p>
              </div>
              <div>
                <strong>Date ranges</strong>
                <p>Attendance {preview.ranges.attendance?.from ?? "-"} to {preview.ranges.attendance?.to ?? "-"}</p>
                <p>Work {preview.ranges.labourWork?.from ?? "-"} to {preview.ranges.labourWork?.to ?? "-"}</p>
                <p>Advances {preview.ranges.advances?.from ?? "-"} to {preview.ranges.advances?.to ?? "-"}</p>
                <p>Settlements {preview.ranges.settlements?.from ?? "-"} to {preview.ranges.settlements?.to ?? "-"}</p>
              </div>
            </div>
          </section>
        ) : null}

        {validation?.issues.length ? (
          <section className="record-panel archive-center__issues-card">
            <div className="archive-center__card-header">
              <div>
                <h3>Validation issues</h3>
                <p>Resolve every blocking item before archiving the batch.</p>
              </div>
              <span className="archive-center__badge archive-center__badge--danger">{validation.issues.length} issues</span>
            </div>
            <div className="archive-center__issues-list">
              {validation.issues.map((issue) => (
                <article key={issue.code} className="archive-center__issue">
                  <strong>{issue.message}</strong>
                  <span>{issue.count} affected</span>
                </article>
              ))}
              <article className="archive-center__issue archive-center__issue--subtle">
                <strong>Pending sync</strong>
                <span>{validation.pendingSyncCount}</span>
              </article>
              <article className="archive-center__issue archive-center__issue--subtle">
                <strong>Locked records</strong>
                <span>{validation.lockedCount}</span>
              </article>
              <article className="archive-center__issue archive-center__issue--subtle">
                <strong>Already archived</strong>
                <span>{validation.archivedCount}</span>
              </article>
            </div>
          </section>
        ) : null}

        <section className="archive-center__history-header">
          <div>
            <h3>Archive batches</h3>
            <p>Previously validated batches stay visible here for review and restore.</p>
          </div>
          <SearchInput placeholder="Search archive batches" value={query} onChange={setQuery} />
        </section>
        <section className="archive-center__history-grid">
          {loadingBatches ? <p className="context-message">Loading archive batches...</p> : null}
          {!visibleBatches.length && !loadingBatches ? <p className="context-message">No archive batches yet.</p> : visibleBatches.map((batch) => (
            <article key={batch.id} className="record-panel archive-center__batch-card">
              <div className="archive-center__card-header">
                <div>
                  <h3>{batch.archiveType.replaceAll("_", " ")}</h3>
                  <p>{batch.archiveReason}</p>
                </div>
                <span className={`archive-center__badge archive-center__badge--${batch.status}`}>{batch.status}</span>
              </div>
              <div className="archive-center__batch-meta">
                <span>{batch.attendanceFrom ?? "-"} to {batch.attendanceTo ?? "-"}</span>
                <span>{batch.labourWorkFrom ?? "-"} to {batch.labourWorkTo ?? "-"}</span>
                <span>{batch.advancesFrom ?? "-"} to {batch.advancesTo ?? "-"}</span>
                <span>{batch.settlementFrom ?? "-"} to {batch.settlementTo ?? "-"}</span>
              </div>
              <div className="archive-center__batch-actions">
                <span>{batch.validationSummary?.blocking ? "Blocked" : "Validated"}</span>
                {(batch.status === "archived" || batch.status === "validated") ? (
                    <button className="secondary-action" type="button" onClick={() => void restoreBatch(batch)} disabled={submitting || !canManage}>
                      <RotateCcw size={14} /> Restore
                    </button>
                ) : null}
              </div>
            </article>
          ))}
        </section>
        <div className="archive-center__footer-note">
          <ArchiveRestore size={14} />
          <span>Archive hides old records from daily screens by default, but accounting and reports can still include them.</span>
        </div>
      </main>
    </div>
  );
}
