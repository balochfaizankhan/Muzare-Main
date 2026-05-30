import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { SubpageHeader } from "../components/SubpageHeader";
import { useAuth } from "../auth/AuthProvider";
import { useSyncState } from "../hooks/useSyncState";
import { confirmAttendanceImport, createExpenseSubcategory, fetchAttendanceReport, fetchExpenseCategories, previewAttendanceImport, updateExpenseSubcategory, type AttendanceImportMapping, type AttendanceImportPreview, type AttendanceImportResult, type AttendanceReportFilters, type AttendanceReportStatus } from "../lib/api";
import { hasPermission } from "../lib/permissions";
import {
  ensureLocalAccounts,
  getActiveWorkspaceId,
  getActiveFarmId,
  getActiveSeasonId,
  makeLocalRecord,
  offlineDb,
  workspaceRecords,
  type Account,
  type Advance,
  type Attendance,
  type Dispatch,
  type Labourer,
  type PartnerEntry,
  type Sale,
  type Voucher,
} from "../lib/offline-db";
import { persistOperationalRecord, refreshOperationalData } from "../services/syncService";

export type ModuleKey = "workforce" | "expenses" | "sales" | "dispatch" | "accounts" | "partnerLedger";

const today = () => new Date().toISOString().slice(0, 10);
const money = (amount: number) => new Intl.NumberFormat("en", { style: "currency", currency: "SAR" }).format(amount);

function useData<T>(load: () => Promise<T[]>, setup?: () => Promise<void>) {
  const [records, setRecords] = useState<T[]>([]);
  const refresh = useCallback(async () => {
    if (setup) await setup();
    setRecords(await load());
  }, [load, setup]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return [records, refresh, setRecords] as const;
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="empty-records">{children}</p>;
}

function FormCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="record-panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function WorkforceModule() {
  const { token, user } = useAuth();
  const sync = useSyncState();
  const loadLabourers = useCallback(async () => (await workspaceRecords(offlineDb.labourers)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), []);
  const loadAttendance = useCallback(async () => (await workspaceRecords(offlineDb.attendance)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), []);
  const loadAdvances = useCallback(async () => (await workspaceRecords(offlineDb.advances)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), []);
  const [labourers, refreshLabourers] = useData(loadLabourers);
  const [attendance, refreshAttendance, setAttendance] = useData(loadAttendance);
  const [advances, refreshAdvances, setAdvances] = useData(loadAdvances);
  const [name, setName] = useState("");
  const [group, setGroup] = useState("General");
  const [wage, setWage] = useState("");
  const [date, setDate] = useState(today());
  const [attendanceSearch, setAttendanceSearch] = useState("");
  const [attendanceFilter, setAttendanceFilter] = useState<Attendance["status"] | "all">("all");
  const [selectedLabourer, setSelectedLabourer] = useState<Labourer | null>(null);
  const [markingLabourers, setMarkingLabourers] = useState<Set<string>>(() => new Set());
  const [showReport, setShowReport] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [labourAction, setLabourAction] = useState<"update" | "advance" | null>(null);

  const addLabourer = async (event: FormEvent) => {
    event.preventDefault();
    const record: Labourer = { ...makeLocalRecord(), name: name.trim(), group: group.trim() || "General", dailyWage: Number(wage) };
    await persistOperationalRecord("labourer", record);
    setName("");
    setWage("");
    await refreshLabourers();
  };

  const markAttendance = async (targetLabourerId: string, status: Attendance["status"]) => {
    if (markingLabourers.has(targetLabourerId)) return;
    setMarkingLabourers((current) => new Set(current).add(targetLabourerId));
    const existing = attendance.find((entry) =>
      entry.labourerId === targetLabourerId && entry.workspaceId === getActiveWorkspaceId()
      && entry.farmId === getActiveFarmId() && entry.seasonId === getActiveSeasonId() && entry.date === date
    ) ?? await offlineDb.attendance
      .where("labourerId")
      .equals(targetLabourerId)
      .filter((entry) => entry.workspaceId === getActiveWorkspaceId() && entry.farmId === getActiveFarmId() && entry.seasonId === getActiveSeasonId() && entry.date === date)
      .first();
    const record: Attendance = existing ? { ...existing, status, updatedAt: new Date().toISOString() } : { ...makeLocalRecord(), labourerId: targetLabourerId, date, status };
    setAttendance((current) => [record, ...current.filter((entry) => entry.id !== record.id)]);
    try {
      await persistOperationalRecord("attendance", record);
    } finally {
      setMarkingLabourers((current) => {
        const next = new Set(current); next.delete(targetLabourerId); return next;
      });
    }
  };

  const names = new Map(labourers.map((labourer) => [labourer.id, labourer.name]));
  const attendanceByLabourer = new Map(
    attendance.filter((entry) => entry.date === date).map((entry) => [entry.labourerId, entry.status]),
  );
  const yesterday = new Date(`${date}T00:00:00`);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayDate = yesterday.toISOString().slice(0, 10);
  const yesterdayByLabourer = new Map(
    attendance.filter((entry) => entry.date === yesterdayDate).map((entry) => [entry.labourerId, entry.status]),
  );
  const filteredLabourers = labourers.filter((labourer) => {
    const status = attendanceByLabourer.get(labourer.id);
    const matchesStatus = attendanceFilter === "all" || status === attendanceFilter;
    const matchesSearch = labourer.name.toLowerCase().includes(attendanceSearch.trim().toLowerCase());
    return matchesStatus && matchesSearch;
  });
  const presentToday = [...attendanceByLabourer.values()].filter((item) => item === "present").length;
  const halfDayToday = [...attendanceByLabourer.values()].filter((item) => item === "half_day").length;
  const absentToday = [...attendanceByLabourer.values()].filter((item) => item === "absent").length;
  const selectedAttendance = selectedLabourer
    ? attendance.filter((entry) => entry.labourerId === selectedLabourer.id)
    : [];
  const presentCount = selectedAttendance.filter((entry) => entry.status === "present").length;
  const halfDayCount = selectedAttendance.filter((entry) => entry.status === "half_day").length;
  const absentCount = selectedAttendance.filter((entry) => entry.status === "absent").length;
  const totalEarnings = selectedLabourer ? (presentCount + halfDayCount * 0.5) * selectedLabourer.dailyWage : 0;
  const advanceAmount = selectedLabourer ? advances.filter((entry) => entry.labourerId === selectedLabourer.id).reduce((sum, entry) => sum + entry.amount, 0) : 0;
  const netBalance = totalEarnings - advanceAmount;
  const canManageLabour = Boolean(user?.workspaceId && hasPermission(user, "MANAGE_TEAM", user.workspaceId));
  const canAddAdvance = Boolean(user?.workspaceId && hasPermission(user, "MANAGE_RECORDS", user.workspaceId));
  const showToast = (message: string) => window.dispatchEvent(new CustomEvent("muzare-toast", { detail: message }));
  const saveLabour = async (record: Labourer) => {
    setSelectedLabourer(record);
    await persistOperationalRecord("labourer", record);
    await refreshLabourers();
    setSelectedLabourer(record);
    showToast("Labour updated successfully.");
  };
  const saveAdvance = async (record: Advance) => {
    setAdvances((current) => [record, ...current.filter((entry) => entry.id !== record.id)]);
    await persistOperationalRecord("advance", record);
    showToast("Advance added successfully.");
  };

  return (
    <>
      <div className="form-grid">
        <FormCard title="Add labourer">
          <form className="module-form" onSubmit={(event) => void addLabourer(event)}>
            <input required placeholder="Name" value={name} onChange={(event) => setName(event.target.value)} />
            <input required placeholder="Group" value={group} onChange={(event) => setGroup(event.target.value)} />
            <input required min="0" step="0.01" type="number" placeholder="Daily wage" value={wage} onChange={(event) => setWage(event.target.value)} />
            <button type="submit">Add labourer</button>
          </form>
        </FormCard>
        <section className="record-panel daily-attendance-panel">
          <div className="daily-attendance__heading">
            <div>
              <h2>Daily Attendance</h2>
              <p>Streamline your daily workforce tracking with precision.</p>
            </div>
            <strong>Date: {new Date(`${date}T00:00:00`).toLocaleDateString("en-GB").replaceAll("/", "-")}</strong>
          </div>
          <div className="attendance-tools">
            <select value={attendanceFilter} onChange={(event) => setAttendanceFilter(event.target.value as Attendance["status"] | "all")}>
              <option value="all">All labour</option>
              <option value="present">Present</option>
              <option value="half_day">1/2 Day</option>
              <option value="absent">Absent</option>
            </select>
            <input placeholder="Search labour..." value={attendanceSearch} onChange={(event) => setAttendanceSearch(event.target.value)} />
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </div>
          <div className="attendance-actions">
            <button type="button" onClick={() => setDate(today())}>Today</button>
            <button type="button" onClick={() => setShowReport(true)}>View Report</button>
            {user?.workspaceId && hasPermission(user, "IMPORT_ATTENDANCE", user.workspaceId) && <button type="button" onClick={() => {
              if (!navigator.onLine) window.dispatchEvent(new CustomEvent("muzare-toast", { detail: "CSV import requires internet connection." }));
              else setShowImport(true);
            }}>Import CSV</button>}
          </div>
          <div className="attendance-totals" aria-label="Attendance totals">
            <strong className="attendance-total--present">P: {presentToday}</strong>
            <strong className="attendance-total--half">1/2: {halfDayToday}</strong>
            <strong className="attendance-total--absent">A: {absentToday}</strong>
          </div>
          <div className="attendance-board">
            {!filteredLabourers.length ? <Empty>No labourers match this search.</Empty> : filteredLabourers.map((labourer, index) => {
              const currentStatus = attendanceByLabourer.get(labourer.id);
              const previousStatus = yesterdayByLabourer.get(labourer.id);
              return (
                <article className="attendance-card" key={labourer.id}>
                  <span className="attendance-card__index">{index + 1}</span>
                  <div className="attendance-card__body">
                    <strong>{labourer.name}</strong>
                    <span>Yesterday: {previousStatus ? previousStatus === "half_day" ? "1/2" : previousStatus === "present" ? "P" : "A" : "-"}</span>
                  </div>
                  <div className="attendance-status-buttons">
                    <button disabled={markingLabourers.has(labourer.id)} className={currentStatus === "present" ? "is-active" : ""} type="button" onClick={() => void markAttendance(labourer.id, "present")}>P</button>
                    <button disabled={markingLabourers.has(labourer.id)} className={currentStatus === "half_day" ? "is-active" : ""} type="button" onClick={() => void markAttendance(labourer.id, "half_day")}>1/2</button>
                    <button disabled={markingLabourers.has(labourer.id)} className={currentStatus === "absent" ? "is-active" : ""} type="button" onClick={() => void markAttendance(labourer.id, "absent")}>A</button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      </div>
      <section className="record-panel">
        <h2>Labour register</h2>
        {!labourers.length ? <Empty>No labourers recorded yet.</Empty> : (
          <div className="record-list workforce-list">
            {labourers.map((labourer, index) => (
              <button className="workforce-row" type="button" key={labourer.id} onClick={() => setSelectedLabourer(labourer)}>
                <span className="workforce-row__index">{index + 1}</span>
                <span className="workforce-row__body">
                  <strong>{labourer.name}</strong>
                  <span>{labourer.group} | Daily Wage | Active</span>
                </span>
                <span className="workforce-row__action">Details</span>
              </button>
            ))}
          </div>
        )}
      </section>
      <section className="record-panel">
        <h2>Recent attendance</h2>
        {!attendance.length ? <Empty>No attendance marked yet.</Empty> : (
          <div className="record-list">
            {attendance.map((entry) => <article key={entry.id}><strong>{names.get(entry.labourerId) ?? "Labourer"}</strong><span>{entry.date} | {entry.status.replace("_", " ")}</span></article>)}
          </div>
        )}
      </section>
      {selectedLabourer && (
        <div className="worker-dialog-backdrop" role="presentation" onClick={() => setSelectedLabourer(null)}>
          <section
            className="worker-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="worker-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="worker-dialog__header">
              <h2 id="worker-dialog-title">{selectedLabourer.name}</h2>
            </header>
            <div className="worker-dialog__body">
              <h3>Attendance Statistics</h3>
              <dl className="worker-stats">
                <div><dt>Status</dt><dd className={selectedLabourer.active === false ? "negative" : "positive"}>{selectedLabourer.active === false ? "Inactive" : "Active"}</dd></div>
                <div><dt>Labour Type</dt><dd>{selectedLabourer.labourType ?? "Daily Wage"}</dd></div>
                <div><dt>Join Date</dt><dd>{selectedLabourer.joinedOn ?? selectedLabourer.createdAt.slice(0, 10)}</dd></div>
                <div><dt>End Date</dt><dd>{selectedLabourer.endedOn || "-"}</dd></div>
                <div><dt>Present</dt><dd>{presentCount}</dd></div>
                <div><dt>1/2 Day</dt><dd>{halfDayCount}</dd></div>
                <div><dt>Absent</dt><dd>{absentCount}</dd></div>
              </dl>

              <h3>Financial Overview</h3>
              <dl className="worker-stats">
                <div><dt>Daily Wage (SAR)</dt><dd>{money(selectedLabourer.dailyWage)}</dd></div>
                <div><dt>Total Earnings</dt><dd className="positive">{money(totalEarnings)}</dd></div>
                <div><dt>Advance</dt><dd className={advanceAmount > 0 ? "negative" : ""}>{money(advanceAmount)}</dd></div>
                <div><dt>Net Balance</dt><dd className={netBalance < 0 ? "negative" : "positive"}>{money(netBalance)}</dd></div>
              </dl>
            </div>
            <footer className="worker-dialog__footer">
              {canManageLabour && <button className="worker-dialog__link worker-dialog__link--danger" type="button" onClick={() => setLabourAction("update")}>Update</button>}
              {canAddAdvance && <button className="worker-dialog__link" type="button" onClick={() => setLabourAction("advance")}>Advance</button>}
              <button className="worker-dialog__close" type="button" onClick={() => setSelectedLabourer(null)}>Close</button>
            </footer>
          </section>
        </div>
      )}
      {selectedLabourer && labourAction === "update" && <EditLabourPanel labourer={selectedLabourer} onClose={() => setLabourAction(null)} onSave={saveLabour} />}
      {selectedLabourer && labourAction === "advance" && <AddAdvancePanel labourer={selectedLabourer} onClose={() => setLabourAction(null)} onSave={saveAdvance} />}
      {showReport && token && user?.workspaceId && sync.farmId && sync.seasonId && (
        <AttendanceReportPanel
          token={token}
          workspaceId={user.workspaceId}
          farmId={sync.farmId}
          seasonId={sync.seasonId}
          labourers={labourers}
          onClose={() => setShowReport(false)}
        />
      )}
      {showImport && token && user?.workspaceId && sync.farmId && sync.seasonId && (
        <AttendanceImportPanel
          token={token} workspaceId={user.workspaceId} farmId={sync.farmId} seasonId={sync.seasonId}
          onClose={() => setShowImport(false)}
          onImported={() => Promise.all([refreshLabourers(), refreshAttendance(), refreshAdvances()]).then(() => undefined)}
        />
      )}
    </>
  );
}

function EditLabourPanel({ labourer, onClose, onSave }: { labourer: Labourer; onClose: () => void; onSave: (record: Labourer) => Promise<void> }) {
  const [form, setForm] = useState({
    name: labourer.name, labourType: labourer.labourType ?? "Daily Wage", dailyWage: String(labourer.dailyWage),
    active: labourer.active !== false, joinedOn: labourer.joinedOn ?? labourer.createdAt.slice(0, 10),
    endedOn: labourer.endedOn ?? "", phone: labourer.phone ?? "", notes: labourer.notes ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const dailyWage = Number(form.dailyWage);
    if (!form.name.trim() || !Number.isFinite(dailyWage) || dailyWage < 0) { setError("Labour name and a valid daily wage are required."); return; }
    if (busy) return;
    setBusy(true); setError("");
    try {
      await onSave({ ...labourer, name: form.name.trim(), labourType: form.labourType.trim() || "Daily Wage", dailyWage, active: form.active, joinedOn: form.joinedOn, endedOn: form.endedOn || undefined, phone: form.phone.trim() || undefined, notes: form.notes.trim() || undefined, updatedAt: new Date().toISOString() });
      onClose();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to update labour."); }
    finally { setBusy(false); }
  };
  return <ActionPanel title="Update Labour" onClose={onClose}>
    <form className="worker-action-form" onSubmit={(event) => void submit(event)}>
      <label><span>Labour name *</span><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
      <label><span>Labour type *</span><input required value={form.labourType} onChange={(event) => setForm({ ...form, labourType: event.target.value })} /></label>
      <label><span>Daily wage *</span><input required min="0" step="0.01" type="number" value={form.dailyWage} onChange={(event) => setForm({ ...form, dailyWage: event.target.value })} /></label>
      <label><span>Status</span><select value={form.active ? "active" : "inactive"} onChange={(event) => setForm({ ...form, active: event.target.value === "active" })}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
      <label><span>Join date</span><input type="date" value={form.joinedOn} onChange={(event) => setForm({ ...form, joinedOn: event.target.value })} /></label>
      <label><span>End date</span><input type="date" value={form.endedOn} onChange={(event) => setForm({ ...form, endedOn: event.target.value })} /></label>
      <label><span>Phone / contact</span><input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
      <label><span>Notes</span><textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
      {error && <p className="worker-action-error">{error}</p>}
      <footer><button type="button" onClick={onClose}>Cancel</button><button disabled={busy} type="submit">{busy ? "Saving..." : "Save Labour"}</button></footer>
    </form>
  </ActionPanel>;
}

function AddAdvancePanel({ labourer, onClose, onSave }: { labourer: Labourer; onClose: () => void; onSave: (record: Advance) => Promise<void> }) {
  const [form, setForm] = useState({ date: today(), amount: "", paymentMethod: "Cash", notes: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const amount = Number(form.amount);
    if (!Number.isFinite(amount) || amount <= 0) { setError("Advance amount must be greater than zero."); return; }
    if (busy) return;
    setBusy(true); setError("");
    try {
      await onSave({ ...makeLocalRecord(), labourerId: labourer.id, date: form.date, amount, paymentMethod: form.paymentMethod, notes: form.notes.trim() });
      onClose();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to add advance."); }
    finally { setBusy(false); }
  };
  return <ActionPanel title="Add Labour Advance" onClose={onClose}>
    <form className="worker-action-form" onSubmit={(event) => void submit(event)}>
      <label><span>Labour name</span><input readOnly value={labourer.name} /></label>
      <label><span>Advance date *</span><input required type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} /></label>
      <label><span>Amount *</span><input required min="0.01" step="0.01" type="number" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} /></label>
      <label><span>Payment method</span><select value={form.paymentMethod} onChange={(event) => setForm({ ...form, paymentMethod: event.target.value })}><option>Cash</option><option>Bank Transfer</option><option>Other</option></select></label>
      <label><span>Notes</span><textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
      {error && <p className="worker-action-error">{error}</p>}
      <footer><button type="button" onClick={onClose}>Cancel</button><button disabled={busy} type="submit">{busy ? "Saving..." : "Add Advance"}</button></footer>
    </form>
  </ActionPanel>;
}

function ActionPanel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <div className="worker-dialog-backdrop worker-action-backdrop" role="presentation" onClick={onClose}>
    <section className="worker-action-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
      <header><h2>{title}</h2><button type="button" aria-label={`Close ${title}`} onClick={onClose}><X size={19} /></button></header>
      {children}
    </section>
  </div>;
}

function AttendanceImportPanel({ token, workspaceId, farmId, seasonId, onClose, onImported }: {
  token: string; workspaceId: string; farmId: string; seasonId: string; onClose: () => void; onImported: () => Promise<void>;
}) {
  const [step, setStep] = useState(1);
  const [file, setFile] = useState<File | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [preview, setPreview] = useState<AttendanceImportPreview | null>(null);
  const [mappings, setMappings] = useState<AttendanceImportMapping[]>([]);
  const [duplicateMode, setDuplicateMode] = useState<"missing_only" | "skip_existing" | "update_existing">("missing_only");
  const [warningsAccepted, setWarningsAccepted] = useState(false);
  const [result, setResult] = useState<AttendanceImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mappingFor = (rowIndex: number) => mappings.find((mapping) => mapping.rowIndex === rowIndex);
  const unresolvedLabourRows = preview?.rows.filter((row) => !row.matchedLabourerId && !mappingFor(row.rowIndex)) ?? [];
  const setMapping = (mapping: AttendanceImportMapping) => setMappings((current) => [...current.filter((item) => item.rowIndex !== mapping.rowIndex), mapping]);
  const upload = async () => {
    if (!file || !navigator.onLine) {
      setError("CSV import requires internet connection."); return;
    }
    setBusy(true); setError("");
    try {
      const response = await previewAttendanceImport(token, workspaceId, {
        farmId, seasonId, originalFilename: file.name, csvText: await file.text(), from: from || undefined, to: to || undefined,
      });
      setSessionId(response.sessionId); setPreview(response.preview);
      setMappings(response.preview.rows.filter((row) => row.matchedLabourerId).map((row) => ({ rowIndex: row.rowIndex, action: "match", labourerId: row.matchedLabourerId! })));
      setStep(2);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to preview CSV."); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!preview || !navigator.onLine) { setError("CSV import requires internet connection."); return; }
    setBusy(true); setError("");
    try {
      const response = await confirmAttendanceImport(token, workspaceId, {
        importSessionId: sessionId, farmId, seasonId, duplicateHandlingMode: duplicateMode, warningsAccepted, labourMappings: mappings,
      });
      setResult(response.result); setStep(5); await refreshOperationalData(); await onImported();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to import attendance."); }
    finally { setBusy(false); }
  };
  const summary = preview?.summary;
  return <div className="worker-dialog-backdrop" role="presentation" onClick={onClose}>
    <section className="attendance-import-dialog" role="dialog" aria-modal="true" aria-labelledby="attendance-import-title" onClick={(event) => event.stopPropagation()}>
      <header className="attendance-report-header"><div><span>Workforce</span><h2 id="attendance-import-title">Attendance Register CSV Import</h2></div><button className="attendance-report-close" type="button" onClick={onClose} aria-label="Close import"><X size={19} /></button></header>
      <ol className="attendance-import-steps">{["Upload CSV", "Map Columns", "Match Labour", "Validate", "Confirm Import"].map((label, index) => <li className={step >= index + 1 ? "is-active" : ""} key={label}><b>{index + 1}</b><span>{label}</span></li>)}</ol>
      <div className="attendance-import-body">
        {step === 1 && <section className="attendance-import-card">
          <h3>Upload old Android attendance register</h3>
          <p>Import is online-only. Workspace, farm, and season are locked to your active selection.</p>
          <dl className="attendance-import-context"><div><dt>Workspace</dt><dd>{workspaceId}</dd></div><div><dt>Farm</dt><dd>{farmId}</dd></div><div><dt>Season</dt><dd>{seasonId}</dd></div></dl>
          <label><span>CSV file *</span><input accept=".csv,text/csv" required type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
          <div className="attendance-import-range"><label><span>Date From <small>(optional)</small></span><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label><span>Date To <small>(optional)</small></span><input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label></div>
          <p className="attendance-import-note">Use a date range when CSV date headings omit the year.</p>
        </section>}
        {step === 2 && preview && <section className="attendance-import-card">
          <h3>Detected columns</h3><p>Labour Name and daily date columns were detected automatically. Summary columns are validation-only.</p>
          <div className="attendance-import-tags">{preview.dateColumns.map((column) => <span key={column.column}>{column.column} → {column.date}</span>)}</div>
          <button type="button" onClick={() => setStep(3)}>Continue to labour matching</button>
        </section>}
        {step === 3 && preview && <section className="attendance-import-card">
          <h3>Match labour</h3><p>Exact matches are selected automatically. Confirm suggestions or choose how to handle unknown names.</p>
          <div className="attendance-import-match-list">{preview.rows.map((row) => {
            const mapping = mappingFor(row.rowIndex);
            return <article key={row.rowIndex}><strong>{row.labourName}</strong><select aria-label={`Match ${row.labourName}`} value={mapping?.action === "match" ? `match:${mapping.labourerId}` : mapping?.action ?? ""} onChange={(event) => {
              const [action, labourerId] = event.target.value.split(":");
              setMapping({ rowIndex: row.rowIndex, action: action as AttendanceImportMapping["action"], labourerId });
            }}>
              <option value="">Choose action</option>
              {preview.labourers.map((labourer) => <option key={labourer.id} value={`match:${labourer.id}`}>{row.suggestedLabourerId === labourer.id ? "Suggested: " : ""}{labourer.name}</option>)}
              <option value="create">Create new labour</option><option value="skip">Skip this row</option>
            </select></article>;
          })}</div>
          {unresolvedLabourRows.length > 0 && <p className="attendance-import-error">Resolve each unknown labour row by matching, creating, or skipping it before validation.</p>}
          <button disabled={unresolvedLabourRows.length > 0} type="button" onClick={() => setStep(4)}>Validate import</button>
        </section>}
        {step === 4 && preview && summary && <section className="attendance-import-card">
          <h3>Validation summary</h3>
          <div className="attendance-import-summary"><span>Labour rows<b>{summary.labourRows}</b></span><span>Date columns<b>{summary.dateColumns}</b></span><span>Attendance records<b>{summary.attendanceRecords}</b></span><span>Existing attendance<b>{summary.duplicateRecords}</b></span><span>Daily advances<b>{summary.dailyAdvances}</b></span><span>Advance total<b>{money(summary.advanceTotal)}</b></span><span>Advances to create<b>{summary.advanceRecordsToCreate}</b></span><span>Duplicate advances<b>{summary.duplicateAdvances}</b></span></div>
          {summary.errors.length > 0 && <div className="attendance-import-errors"><strong>Errors</strong>{summary.errors.map((message) => <p key={message}>{message}</p>)}</div>}
          {summary.warnings.length > 0 && <div className="attendance-import-warnings"><strong>Warnings</strong>{summary.warnings.map((message) => <p key={message}>{message}</p>)}<label><input type="checkbox" checked={warningsAccepted} onChange={(event) => setWarningsAccepted(event.target.checked)} /> I understand these warnings and want to continue.</label></div>}
          <label><span>Duplicate handling</span><select value={duplicateMode} onChange={(event) => setDuplicateMode(event.target.value as typeof duplicateMode)}><option value="missing_only">Import only missing records</option><option value="skip_existing">Skip existing records</option><option value="update_existing">Update existing records</option></select></label>
          <p className="attendance-import-note">Advance Total columns are reference-only. Daily advances found inside date cells will be imported as separate advance records.</p>
          <div className="attendance-import-table-wrap"><table><thead><tr><th>Labour</th><th>CSV Advance Total</th><th>Daily Cell Advance Total</th></tr></thead><tbody>{preview.rows.map((row) => <tr key={row.rowIndex}><th>{row.labourName}</th><td>{row.csvAdvance === null ? "-" : money(row.csvAdvance)}</td><td>{money(row.calculatedAdvance)}</td></tr>)}</tbody></table></div>
          <div className="attendance-import-table-wrap"><table><thead><tr><th>Labour</th>{preview.dateColumns.map((column) => <th key={column.column}>{column.column}</th>)}</tr></thead><tbody>{preview.rows.slice(0, 20).map((row) => <tr key={row.rowIndex}><th>{row.labourName}</th>{row.cells.map((cell) => <td key={cell.column}><b>{attendanceMark(cell.status ?? undefined)}</b>{cell.advanceAmount !== null && <small>{money(cell.advanceAmount)}</small>}</td>)}</tr>)}</tbody></table></div>
          {busy && <p className="attendance-import-progress"><span className="attendance-import-spinner" />Importing attendance records and advances. Please wait...</p>}
          <button disabled={busy || unresolvedLabourRows.length > 0 || summary.errors.length > 0 || (summary.warnings.length > 0 && !warningsAccepted)} type="button" onClick={() => void confirm()}>{busy ? "Importing..." : "Confirm Import"}</button>
        </section>}
        {step === 5 && result && <section className="attendance-import-card"><h3>Import completed</h3><div className="attendance-import-summary"><span>Labour created<b>{result.labourersCreated}</b></span><span>Attendance created<b>{result.attendanceCreated}</b></span><span>Attendance skipped<b>{result.attendanceSkipped}</b></span><span>Attendance updated<b>{result.attendanceUpdated}</b></span><span>Advances created<b>{result.advancesCreated}</b></span><span>Duplicate advances skipped<b>{result.duplicateAdvancesSkipped}</b></span><span>Total advance imported<b>{money(result.totalAdvanceImported)}</b></span><span>Errors<b>{result.errors.length}</b></span></div>{result.errors.map((message) => <p className="attendance-import-error" key={message}>{message}</p>)}<button type="button" onClick={onClose}>Close</button></section>}
        {error && <p className="attendance-import-error">{error}</p>}
      </div>
      <footer className="attendance-import-footer"><button type="button" onClick={onClose}>Cancel</button>{step === 1 && <button disabled={!file || busy} type="button" onClick={() => void upload()}>{busy ? "Parsing..." : "Preview CSV"}</button>}</footer>
    </section>
  </div>;
}

function AttendanceReportPanel({
  token, workspaceId, farmId, seasonId, labourers, onClose,
}: {
  token: string; workspaceId: string; farmId: string; seasonId: string; labourers: Labourer[]; onClose: () => void;
}) {
  const sync = useSyncState();
  const [filters, setFilters] = useState<AttendanceReportFilters>({
    farmId, seasonId, from: `${today().slice(0, 8)}01`, to: today(),
  });
  const [submitted, setSubmitted] = useState<AttendanceReportFilters | null>(null);
  const report = useQuery({
    queryKey: ["attendance-report", workspaceId, farmId, seasonId, submitted?.from, submitted?.to, submitted?.labourId, submitted?.status],
    queryFn: () => fetchAttendanceReport(token, workspaceId, submitted!),
    enabled: Boolean(submitted),
  });
  const exportCsv = () => {
    if (!report.data?.metadata) return;
    const { metadata, dates, summaries, advances } = report.data;
    const statusFor = (labourerId: string, date: string) => summaries.find((item) => item.id === labourerId)?.records.find((item) => item.date === date)?.status;
    const advanceFor = (labourerId: string, date: string) => advances.filter((item) => item.labourerId === labourerId && item.date === date).reduce((sum, item) => sum + item.amount, 0);
    const rows = [
      ["Farm Name", metadata.farmName], ["Season", metadata.seasonName], ["Date From", metadata.from], ["Date To", metadata.to],
      [], ["Labour Name", "P Total", "Half Day Total", "Absent Total", "Advance Total", ...dates],
      ...summaries.map((summary) => [
        summary.name, summary.presentDays, summary.halfDays, summary.absentDays,
        advances.filter((item) => item.labourerId === summary.id).reduce((sum, item) => sum + item.amount, 0),
        ...dates.map((date) => {
          const advance = advanceFor(summary.id, date);
          return `${attendanceMark(statusFor(summary.id, date))}${advance ? ` | Advance: ${advance}` : ""}`;
        }),
      ]),
      ["Grand Total", summaries.reduce((sum, item) => sum + item.presentDays, 0), summaries.reduce((sum, item) => sum + item.halfDays, 0),
        summaries.reduce((sum, item) => sum + item.absentDays, 0), advances.reduce((sum, item) => sum + item.amount, 0)],
      ["Daily Payable Total", "", "", "", "", ...dates.map((date) => summaries.reduce((sum, item) => sum + payableValue(statusFor(item.id, date)), 0))],
    ];
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll("\"", "\"\"")}"`).join(",")).join("\n");
    const href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = href; link.download = `attendance-report-${filters.from}-${filters.to}.csv`; link.click();
    URL.revokeObjectURL(href);
  };
  const data = report.data;
  const totalPresent = data?.summaries.reduce((sum, item) => sum + item.presentDays, 0) ?? 0;
  const totalHalf = data?.summaries.reduce((sum, item) => sum + item.halfDays, 0) ?? 0;
  const totalAbsent = data?.summaries.reduce((sum, item) => sum + item.absentDays, 0) ?? 0;
  const totalAdvance = data?.advances.reduce((sum, item) => sum + item.amount, 0) ?? 0;
  const totalWage = data?.summaries.reduce((sum, item) => sum + item.totalWage, 0) ?? 0;
  const workerAdvance = (labourerId: string) => data?.advances.filter((item) => item.labourerId === labourerId).reduce((sum, item) => sum + item.amount, 0) ?? 0;
  const dailyAdvance = (labourerId: string, date: string) => data?.advances.filter((item) => item.labourerId === labourerId && item.date === date).reduce((sum, item) => sum + item.amount, 0) ?? 0;
  const dailyStatus = (labourerId: string, date: string) => data?.records.find((item) => item.labourerId === labourerId && item.date === date)?.status;
  return (
    <div className="worker-dialog-backdrop" role="presentation" onClick={onClose}>
      <section className={`attendance-report-dialog ${data?.metadata ? "attendance-report-dialog--preview" : ""}`} role="dialog" aria-modal="true" aria-labelledby="attendance-report-title" onClick={(event) => event.stopPropagation()}>
        <header className="attendance-report-header">
          <div><span>Workforce</span><h2 id="attendance-report-title">Attendance Report</h2></div>
          <button className="attendance-report-close" type="button" onClick={onClose} aria-label="Close report"><X size={19} /></button>
        </header>
        <form className="attendance-report-filters" onSubmit={(event) => { event.preventDefault(); setSubmitted({ ...filters }); }}>
          <label><span>Date From</span><input required type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></label>
          <label><span>Date To</span><input required type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></label>
          <label><span>Labour</span><select value={filters.labourId ?? ""} onChange={(event) => setFilters({ ...filters, labourId: event.target.value || undefined })}>
            <option value="">All labour</option>{labourers.map((labourer) => <option key={labourer.id} value={labourer.id}>{labourer.name}</option>)}
          </select></label>
          <label><span>Status</span><select value={filters.status ?? ""} onChange={(event) => setFilters({ ...filters, status: (event.target.value || undefined) as AttendanceReportStatus | undefined })}>
            <option value="">All</option><option value="present">Present</option><option value="half_day">Half Day</option><option value="absent">Absent</option>
          </select></label>
          <footer className="attendance-report-form-actions">
            <button className="attendance-report-cancel" type="button" onClick={onClose}>Cancel</button>
            <button className="attendance-report-generate" type="submit">Generate Report</button>
          </footer>
        </form>
        {submitted && <div className="attendance-report-output">
          {report.isFetching && <p>Generating report...</p>}
          {report.isError && <p className="error">{report.error.message}</p>}
          {report.data && !report.data.summaries.length && <Empty>No attendance records found for this period.</Empty>}
          {data?.metadata && data.summaries.length > 0 && <AttendanceRegister
            data={data} syncStatus={sync.status} totalPresent={totalPresent} totalHalf={totalHalf} totalAbsent={totalAbsent}
            totalAdvance={totalAdvance} totalWage={totalWage} workerAdvance={workerAdvance} dailyAdvance={dailyAdvance}
            dailyStatus={dailyStatus} onClose={onClose} onCsv={exportCsv}
          />}
        </div>}
      </section>
    </div>
  );
}

const payableValue = (status?: AttendanceReportStatus) => status === "present" ? 1 : status === "half_day" ? 0.5 : 0;
const attendanceMark = (status?: AttendanceReportStatus) => status === "present" ? "P" : status === "half_day" ? "1/2" : status === "absent" ? "A" : "-";

function AttendanceRegister({ data, syncStatus, totalPresent, totalHalf, totalAbsent, totalAdvance, totalWage, workerAdvance, dailyAdvance, dailyStatus, onClose, onCsv }: {
  data: import("../lib/api").AttendanceReportData; syncStatus: string; totalPresent: number; totalHalf: number; totalAbsent: number;
  totalAdvance: number; totalWage: number; workerAdvance: (id: string) => number; dailyAdvance: (id: string, date: string) => number;
  dailyStatus: (id: string, date: string) => AttendanceReportStatus | undefined; onClose: () => void; onCsv: () => void;
}) {
  const metadata = data.metadata!;
  return <section className="attendance-register-preview">
    <div className="attendance-report-actions no-print"><button type="button" onClick={() => window.print()}>Print</button><button type="button" onClick={() => window.print()}>Export PDF</button><button type="button" onClick={onCsv}>Export CSV</button><button type="button" onClick={onClose}>Close</button></div>
    <header className="register-header">
      <div><span>Farm Labour Register</span><h2>Attendance Report</h2><strong>{metadata.farmName}</strong><p>Season: {metadata.seasonName}</p></div>
      <dl><div><dt>Date range</dt><dd>{metadata.from} to {metadata.to}</dd></div><div><dt>Generated</dt><dd>{new Date(metadata.generatedAt).toLocaleString()}</dd></div><div><dt>Generated by</dt><dd>{metadata.generatedBy}</dd></div><div><dt>Sync status</dt><dd>{syncStatus}</dd></div></dl>
    </header>
    <div className="register-summary">
      <span>Total labour<strong>{data.summaries.length}</strong></span><span>Total P<strong>{totalPresent}</strong></span><span>Total 1/2<strong>{totalHalf}</strong></span>
      <span>Total A<strong>{totalAbsent}</strong></span><span>Total advance<strong>{money(totalAdvance)}</strong></span><span>Total wages<strong>{money(totalWage)}</strong></span>
    </div>
    <div className="register-table-wrap"><table className="attendance-register-table">
      <thead><tr><th>#</th><th>Labour Name</th><th>P</th><th>1/2</th><th>A</th><th>Advance</th>{data.dates.map((date) => <th key={date}>{date.slice(5)}</th>)}</tr></thead>
      <tbody>{data.summaries.map((summary, index) => <tr key={summary.id}><td>{index + 1}</td><th>{summary.name}</th><td>{summary.presentDays}</td><td>{summary.halfDays}</td><td>{summary.absentDays}</td><td>{money(workerAdvance(summary.id))}</td>
        {data.dates.map((date) => { const status = dailyStatus(summary.id, date); const advance = dailyAdvance(summary.id, date); return <td className={`register-status register-status--${status ?? "empty"}`} key={date}><b>{attendanceMark(status)}</b>{advance > 0 && <small>Adv: {money(advance)}</small>}</td>; })}
      </tr>)}</tbody>
      <tfoot><tr><th colSpan={2}>Grand Total</th><th>{totalPresent}</th><th>{totalHalf}</th><th>{totalAbsent}</th><th>{money(totalAdvance)}</th><th colSpan={data.dates.length}></th></tr>
      <tr><th colSpan={6}>Daily payable total</th>{data.dates.map((date) => <th key={date}>{data.summaries.reduce((sum, item) => sum + payableValue(dailyStatus(item.id, date)), 0)}</th>)}</tr></tfoot>
    </table></div>
    <footer className="register-footer"><span><b>P</b> = Present</span><span><b>1/2</b> = Half Day</span><span><b>A</b> = Absent</span><span><b>-</b> = No record</span></footer>
  </section>;
}

function ExpensesModule() {
  const { token, user } = useAuth();
  const load = useCallback(async () => (await workspaceRecords(offlineDb.vouchers)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), []);
  const loadAccounts = useCallback(() => workspaceRecords(offlineDb.accounts), []);
  const [vouchers, refresh] = useData(load);
  const [accounts] = useData(loadAccounts, ensureLocalAccounts);
  const [date, setDate] = useState(today());
  const workspaceId = user?.workspaceId ?? "";
  const categories = useQuery({ queryKey: ["expense-categories", workspaceId], queryFn: () => fetchExpenseCategories(token!, workspaceId), enabled: Boolean(token && workspaceId) });
  const [categoryId, setCategoryId] = useState("");
  const [categorySearch, setCategorySearch] = useState("");
  const [subcategoryId, setSubcategoryId] = useState("");
  const [subcategorySearch, setSubcategorySearch] = useState("");
  const [customName, setCustomName] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const category = categories.data?.categories.find((item) => item.id === categoryId);
    const subcategory = category?.subcategories.find((item) => item.id === subcategoryId);
    if (!category || !subcategory) return;
    const record: Voucher = {
      ...makeLocalRecord(), voucherNumber: `V-${Date.now().toString().slice(-6)}`, date,
      categoryId: category.id, category: category.name, subcategoryId: subcategory.id, subcategory: subcategory.name,
      description: description.trim(), amount: Number(amount), accountId: accountId || accounts[0]?.id || "",
    };
    await persistOperationalRecord("voucher", record);
    setDescription("");
    setAmount("");
    await refresh();
  };
  const total = vouchers.reduce((sum, item) => sum + item.amount, 0);
  const selectedCategory = categories.data?.categories.find((item) => item.id === categoryId);
  const canManage = Boolean(user && workspaceId && hasPermission(user, "MANAGE_EXPENSE_CATEGORIES", workspaceId));
  const grouped = [...vouchers.reduce((map, item) => {
    const category = map.get(item.category) ?? new Map<string, number>();
    category.set(item.subcategory || "Miscellaneous", (category.get(item.subcategory || "Miscellaneous") ?? 0) + item.amount);
    map.set(item.category, category); return map;
  }, new Map<string, Map<string, number>>())];
  const addCustom = async (event: FormEvent) => {
    event.preventDefault();
    if (!token || !workspaceId || !categoryId || !customName.trim()) return;
    await createExpenseSubcategory(token, workspaceId, { categoryId, name: customName.trim() });
    setCustomName(""); await categories.refetch();
  };

  return (
    <>
      <FormCard title="New expense voucher">
        <form className="module-form inline-form" onSubmit={(event) => void submit(event)}>
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          <label><span>Category *</span><input required list="expense-category-options" placeholder="Select category" value={categorySearch} onChange={(event) => {
            const next = categories.data?.categories.find((item) => item.name === event.target.value); setCategorySearch(event.target.value); setCategoryId(next?.id ?? ""); setSubcategoryId(""); setSubcategorySearch("");
          }} /><datalist id="expense-category-options">{categories.data?.categories.map((item) => <option key={item.id} value={item.name} />)}</datalist></label>
          <label><span>Subcategory *</span><input required disabled={!categoryId} list="expense-subcategory-options" placeholder="Select subcategory" value={subcategorySearch} onChange={(event) => {
            const next = selectedCategory?.subcategories.find((item) => item.name === event.target.value); setSubcategorySearch(event.target.value); setSubcategoryId(next?.id ?? "");
          }} /><datalist id="expense-subcategory-options">{selectedCategory?.subcategories.map((item) => <option key={item.id} value={item.name} />)}</datalist></label>
          <input required value={description} placeholder="Description" onChange={(event) => setDescription(event.target.value)} />
          <input required min="0.01" step="0.01" type="number" value={amount} placeholder="Amount" onChange={(event) => setAmount(event.target.value)} />
          <select value={accountId || accounts[0]?.id || ""} onChange={(event) => setAccountId(event.target.value)}>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select>
          <button type="submit">Save voucher</button>
        </form>
      </FormCard>
      <Summary value={money(total)} label="Total expenses" />
      <section className="record-panel"><h2>Expenses by category</h2>{!grouped.length ? <Empty>No expense totals yet.</Empty> : <div className="expense-category-report">{grouped.map(([category, items]) => <article key={category}><h3>{category}</h3>{[...items].map(([subcategory, amount]) => <p key={subcategory}><span>{subcategory}</span><strong>{money(amount)}</strong></p>)}<b>Total {money([...items.values()].reduce((sum, amount) => sum + amount, 0))}</b></article>)}</div>}</section>
      {canManage && <section className="record-panel"><h2>Custom subcategories</h2><form className="module-form compact-form" onSubmit={(event) => void addCustom(event)}><select required value={categoryId} onChange={(event) => { setCategoryId(event.target.value); setCategorySearch(categories.data?.categories.find((item) => item.id === event.target.value)?.name ?? ""); }}><option value="">Select category</option>{categories.data?.categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><input required placeholder="New subcategory" value={customName} onChange={(event) => setCustomName(event.target.value)} /><button type="submit">Add subcategory</button></form><div className="custom-subcategory-list">{categories.data?.categories.flatMap((item) => item.subcategories.filter((subcategory) => !subcategory.isSystem).map((subcategory) => <span key={subcategory.id}>{item.name} / {subcategory.name}<button type="button" onClick={() => { const name = window.prompt("Rename custom subcategory", subcategory.name); if (token && name?.trim()) void updateExpenseSubcategory(token, workspaceId, subcategory.id, { name: name.trim() }).then(() => categories.refetch()); }}>Rename</button><button type="button" onClick={() => token && void updateExpenseSubcategory(token, workspaceId, subcategory.id, { active: false }).then(() => categories.refetch())}>Disable</button></span>))}</div></section>}
      <RecordTable empty="No vouchers recorded yet." rows={vouchers.map((item) => [item.voucherNumber, item.date, `${item.category} / ${item.subcategory || "Miscellaneous"}`, item.description, money(item.amount)])} />
    </>
  );
}

function DispatchModule() {
  const load = useCallback(async () => (await workspaceRecords(offlineDb.dispatches)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), []);
  const [records, refresh] = useData(load);
  const [date, setDate] = useState(today());
  const [vehicleNumber, setVehicleNumber] = useState("");
  const [driverName, setDriverName] = useState("");
  const [produceType, setProduceType] = useState("");
  const [cartons, setCartons] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const record: Dispatch = { ...makeLocalRecord(), date, vehicleNumber, driverName, produceType, cartons: Number(cartons) };
    await persistOperationalRecord("dispatch", record);
    setVehicleNumber(""); setDriverName(""); setProduceType(""); setCartons("");
    await refresh();
  };

  return (
    <>
      <FormCard title="New dispatch">
        <form className="module-form inline-form" onSubmit={(event) => void submit(event)}>
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          <input required placeholder="Vehicle number" value={vehicleNumber} onChange={(event) => setVehicleNumber(event.target.value)} />
          <input required placeholder="Driver name" value={driverName} onChange={(event) => setDriverName(event.target.value)} />
          <input required placeholder="Produce type" value={produceType} onChange={(event) => setProduceType(event.target.value)} />
          <input required type="number" min="1" placeholder="Cartons" value={cartons} onChange={(event) => setCartons(event.target.value)} />
          <button type="submit">Save dispatch</button>
        </form>
      </FormCard>
      <Summary label="Total dispatched cartons" value={String(records.reduce((sum, item) => sum + item.cartons, 0))} />
      <RecordTable empty="No dispatches recorded yet." rows={records.map((item) => [item.date, item.vehicleNumber, item.driverName, item.produceType, `${item.cartons} cartons`])} />
    </>
  );
}

function SalesModule() {
  const load = useCallback(async () => (await workspaceRecords(offlineDb.sales)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), []);
  const loadAccounts = useCallback(() => workspaceRecords(offlineDb.accounts), []);
  const [sales, refresh] = useData(load);
  const [accounts] = useData(loadAccounts, ensureLocalAccounts);
  const [date, setDate] = useState(today());
  const [buyerName, setBuyerName] = useState("");
  const [produceType, setProduceType] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unitPrice, setUnitPrice] = useState("");
  const [accountId, setAccountId] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const record: Sale = { ...makeLocalRecord(), date, buyerName, produceType, quantity: Number(quantity), unitPrice: Number(unitPrice), amount: Number(quantity) * Number(unitPrice), accountId: accountId || accounts[0]?.id || "" };
    await persistOperationalRecord("sale", record);
    setBuyerName(""); setProduceType(""); setQuantity(""); setUnitPrice("");
    await refresh();
  };

  return (
    <>
      <FormCard title="New sale entry">
        <form className="module-form inline-form" onSubmit={(event) => void submit(event)}>
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          <input required placeholder="Buyer name" value={buyerName} onChange={(event) => setBuyerName(event.target.value)} />
          <input required placeholder="Produce type" value={produceType} onChange={(event) => setProduceType(event.target.value)} />
          <input required type="number" min="1" placeholder="Quantity" value={quantity} onChange={(event) => setQuantity(event.target.value)} />
          <input required type="number" min="0" step="0.01" placeholder="Unit price" value={unitPrice} onChange={(event) => setUnitPrice(event.target.value)} />
          <select value={accountId || accounts[0]?.id || ""} onChange={(event) => setAccountId(event.target.value)}>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select>
          <button type="submit">Save sale</button>
        </form>
      </FormCard>
      <Summary label="Total sales" value={money(sales.reduce((sum, item) => sum + item.amount, 0))} />
      <RecordTable empty="No sales recorded yet." rows={sales.map((item) => [item.date, item.buyerName, item.produceType, `${item.quantity} x ${money(item.unitPrice)}`, money(item.amount)])} />
    </>
  );
}

function PartnerLedgerModule() {
  const load = useCallback(async () => (await workspaceRecords(offlineDb.partnerEntries)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), []);
  const loadAccounts = useCallback(() => workspaceRecords(offlineDb.accounts), []);
  const [entries, refresh] = useData(load);
  const [accounts] = useData(loadAccounts, ensureLocalAccounts);
  const [date, setDate] = useState(today());
  const [partnerName, setPartnerName] = useState("");
  const [type, setType] = useState<PartnerEntry["type"]>("contribution");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [accountId, setAccountId] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const record: PartnerEntry = { ...makeLocalRecord(), date, partnerName, type, amount: Number(amount), notes, accountId: accountId || accounts[0]?.id || "" };
    await persistOperationalRecord("partnerEntry", record);
    setPartnerName(""); setAmount(""); setNotes("");
    await refresh();
  };
  const balance = entries.reduce((sum, item) => sum + (item.type === "contribution" ? item.amount : -item.amount), 0);

  return (
    <>
      <FormCard title="Record partner entry">
        <form className="module-form inline-form" onSubmit={(event) => void submit(event)}>
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          <input required placeholder="Partner name" value={partnerName} onChange={(event) => setPartnerName(event.target.value)} />
          <select value={type} onChange={(event) => setType(event.target.value as PartnerEntry["type"])}>
            <option value="contribution">Contribution</option>
            <option value="withdrawal">Withdrawal</option>
          </select>
          <input required type="number" min="0.01" step="0.01" placeholder="Amount" value={amount} onChange={(event) => setAmount(event.target.value)} />
          <input placeholder="Notes" value={notes} onChange={(event) => setNotes(event.target.value)} />
          <select value={accountId || accounts[0]?.id || ""} onChange={(event) => setAccountId(event.target.value)}>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select>
          <button type="submit">Save entry</button>
        </form>
      </FormCard>
      <Summary label="Partner balance" value={money(balance)} />
      <RecordTable empty="No partner entries recorded yet." rows={entries.map((item) => [item.date, item.partnerName, item.type, item.notes || "-", money(item.type === "withdrawal" ? -item.amount : item.amount)])} />
    </>
  );
}

function AccountsModule() {
  const loadAccounts = useCallback(async () => (await workspaceRecords(offlineDb.accounts)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)), []);
  const loadVouchers = useCallback(() => workspaceRecords(offlineDb.vouchers), []);
  const loadSales = useCallback(() => workspaceRecords(offlineDb.sales), []);
  const loadEntries = useCallback(() => workspaceRecords(offlineDb.partnerEntries), []);
  const [accounts, refresh] = useData(loadAccounts, ensureLocalAccounts);
  const [vouchers] = useData(loadVouchers);
  const [sales] = useData(loadSales);
  const [entries] = useData(loadEntries);
  const [name, setName] = useState("");
  const [type, setType] = useState<Account["type"]>("bank");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const record: Account = { ...makeLocalRecord(), name, type };
    await persistOperationalRecord("account", record);
    setName("");
    await refresh();
  };
  const balance = (id: string) =>
    sales.filter((record) => record.accountId === id).reduce((sum, record) => sum + record.amount, 0)
    - vouchers.filter((record) => record.accountId === id).reduce((sum, record) => sum + record.amount, 0)
    + entries.filter((record) => record.accountId === id).reduce((sum, record) => sum + (record.type === "contribution" ? record.amount : -record.amount), 0);

  return (
    <>
      <FormCard title="Create account">
        <form className="module-form compact-form" onSubmit={(event) => void submit(event)}>
          <input required placeholder="Account name" value={name} onChange={(event) => setName(event.target.value)} />
          <select value={type} onChange={(event) => setType(event.target.value as Account["type"])}>
            <option value="cash">Cash</option><option value="bank">Bank</option><option value="partner">Partner</option>
          </select>
          <button type="submit">Create account</button>
        </form>
      </FormCard>
      <section className="record-panel">
        <h2>Your accounts</h2>
        <div className="account-grid">
          {accounts.map((account) => (
            <article key={account.id}>
              <span>{account.type}</span>
              <strong>{account.name}</strong>
              <b>{money(balance(account.id))}</b>
            </article>
          ))}
        </div>
      </section>
      <Summary
        label="Net operating position"
        value={money(sales.reduce((sum, item) => sum + item.amount, 0) - vouchers.reduce((sum, item) => sum + item.amount, 0))}
      />
    </>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return <section className="summary-card"><span>{label}</span><strong>{value}</strong></section>;
}

function RecordTable({ empty, rows }: { empty: string; rows: string[][] }) {
  return (
    <section className="record-panel">
      <h2>Recent records</h2>
      {!rows.length ? <Empty>{empty}</Empty> : (
        <div className="record-list">
          {rows.map((row, index) => <article key={`${row[0]}-${index}`}>{row.map((cell, item) => item === 0 ? <strong key={cell}>{cell}</strong> : <span key={`${cell}-${item}`}>{cell}</span>)}</article>)}
        </div>
      )}
    </section>
  );
}

const descriptions: Record<ModuleKey, string> = {
  workforce: "Attendance, wages, advances, and labour registers.",
  expenses: "Vouchers, invoices, categories, and expense reporting.",
  sales: "Market revenue and sales collection.",
  dispatch: "Vehicle movement and produce carton dispatch.",
  accounts: "Balances calculated from synchronized operational transactions.",
  partnerLedger: "Partner contributions, withdrawals, and running balances.",
};

export function ModulePage({ module }: { module: ModuleKey }) {
  const { t } = useTranslation();

  return (
    <div className="dashboard-page">
      <SubpageHeader title={t(module)} />
      <main className="subpage module-workspace">
        <section className="workspace-intro">
          <div>
            <h2>{t(module)}</h2>
            <p>{descriptions[module]}</p>
          </div>
          <span className="local-pill">Database synchronized</span>
        </section>
        {module === "workforce" && <WorkforceModule />}
        {module === "expenses" && <ExpensesModule />}
        {module === "dispatch" && <DispatchModule />}
        {module === "sales" && <SalesModule />}
        {module === "accounts" && <AccountsModule />}
        {module === "partnerLedger" && <PartnerLedgerModule />}
      </main>
    </div>
  );
}
