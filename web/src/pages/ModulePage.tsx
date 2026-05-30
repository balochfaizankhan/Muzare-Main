import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { SubpageHeader } from "../components/SubpageHeader";
import { useAuth } from "../auth/AuthProvider";
import { useSyncState } from "../hooks/useSyncState";
import { fetchAttendanceReport, type AttendanceReportFilters, type AttendanceReportStatus } from "../lib/api";
import {
  ensureLocalAccounts,
  getActiveWorkspaceId,
  getActiveFarmId,
  getActiveSeasonId,
  makeLocalRecord,
  offlineDb,
  workspaceRecords,
  type Account,
  type Attendance,
  type Dispatch,
  type Labourer,
  type PartnerEntry,
  type Sale,
  type Voucher,
} from "../lib/offline-db";
import { persistOperationalRecord } from "../services/syncService";

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
  const [labourers, refreshLabourers] = useData(loadLabourers);
  const [attendance, , setAttendance] = useData(loadAttendance);
  const [name, setName] = useState("");
  const [group, setGroup] = useState("General");
  const [wage, setWage] = useState("");
  const [date, setDate] = useState(today());
  const [attendanceSearch, setAttendanceSearch] = useState("");
  const [attendanceFilter, setAttendanceFilter] = useState<Attendance["status"] | "all">("all");
  const [selectedLabourer, setSelectedLabourer] = useState<Labourer | null>(null);
  const [markingLabourers, setMarkingLabourers] = useState<Set<string>>(() => new Set());
  const [showReport, setShowReport] = useState(false);

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
  const advanceAmount = 0;
  const netBalance = totalEarnings - advanceAmount;

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
                <div><dt>Status</dt><dd className="positive">Active</dd></div>
                <div><dt>Labour Type</dt><dd>Daily Wage</dd></div>
                <div><dt>Join Date</dt><dd>{selectedLabourer.createdAt.slice(0, 10)}</dd></div>
                <div><dt>End Date</dt><dd>-</dd></div>
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
              <button className="worker-dialog__link worker-dialog__link--danger" type="button">Update</button>
              <button className="worker-dialog__link" type="button">Advance</button>
              <button className="worker-dialog__close" type="button" onClick={() => setSelectedLabourer(null)}>Close</button>
            </footer>
          </section>
        </div>
      )}
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
    </>
  );
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
  const load = useCallback(async () => (await workspaceRecords(offlineDb.vouchers)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), []);
  const loadAccounts = useCallback(() => workspaceRecords(offlineDb.accounts), []);
  const [vouchers, refresh] = useData(load);
  const [accounts] = useData(loadAccounts, ensureLocalAccounts);
  const [date, setDate] = useState(today());
  const [category, setCategory] = useState("Operations");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const record: Voucher = {
      ...makeLocalRecord(), voucherNumber: `V-${Date.now().toString().slice(-6)}`, date, category,
      description: description.trim(), amount: Number(amount), accountId: accountId || accounts[0]?.id || "",
    };
    await persistOperationalRecord("voucher", record);
    setDescription("");
    setAmount("");
    await refresh();
  };
  const total = vouchers.reduce((sum, item) => sum + item.amount, 0);

  return (
    <>
      <FormCard title="New expense voucher">
        <form className="module-form inline-form" onSubmit={(event) => void submit(event)}>
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          <input required value={category} placeholder="Category" onChange={(event) => setCategory(event.target.value)} />
          <input required value={description} placeholder="Description" onChange={(event) => setDescription(event.target.value)} />
          <input required min="0.01" step="0.01" type="number" value={amount} placeholder="Amount" onChange={(event) => setAmount(event.target.value)} />
          <select value={accountId || accounts[0]?.id || ""} onChange={(event) => setAccountId(event.target.value)}>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select>
          <button type="submit">Save voucher</button>
        </form>
      </FormCard>
      <Summary value={money(total)} label="Total expenses" />
      <RecordTable empty="No vouchers recorded yet." rows={vouchers.map((item) => [item.voucherNumber, item.date, item.category, item.description, money(item.amount)])} />
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
