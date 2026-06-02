import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { MoreVertical, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { SubpageHeader } from "../components/SubpageHeader";
import { SearchInput } from "../components/SearchInput";
import { LabourSelectCombobox } from "../components/LabourSelectCombobox";
import { useAuth } from "../auth/AuthProvider";
import { useSyncState } from "../hooks/useSyncState";
import { calculateAccountBalance } from "../lib/accounting";
import { confirmAttendanceImport, confirmExpenseImport, createExpenseSubcategory, deleteOrDeactivateLabour, fetchAdvanceReport, fetchAttendanceReport, fetchExpenseCategories, fetchLabourDeletionPreview, previewAttendanceImport, previewExpenseImport, searchExpenses, updateExpenseSubcategory, type AdvanceReportData, type AdvanceReportFilters, type AttendanceImportMapping, type AttendanceImportPreview, type AttendanceImportResult, type AttendanceReportFilters, type AttendanceReportStatus, type ExpenseImportPreview, type ExpenseImportResolution, type ExpenseImportResult, type LabourDeletionPreview } from "../lib/api";
import { hasPermission } from "../lib/permissions";
import { formatMoney } from "../lib/format";
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
  type LabourGroup,
  type LabourPayment,
  type PartnerEntry,
  type ProductionEntry,
  type Sale,
  type Voucher,
} from "../lib/offline-db";
import { deleteOperationalRecord, persistOperationalRecord, refreshOperationalData } from "../services/syncService";

export type ModuleKey = "workforce" | "expenses" | "sales" | "dispatch" | "accounts" | "partnerLedger";

const today = () => new Date().toISOString().slice(0, 10);
const money = formatMoney;
const readableSyncTime = (value: string | null) => value ? new Date(value).toLocaleString() : "Not synced yet";
const paymentTypes = ["daily_wage", "production_based", "contract_lump_sum", "monthly_salary", "other"] as const;
type PaymentType = typeof paymentTypes[number];
const hasEndedBefore = (labourer: Labourer, date: string) => Boolean(labourer.endedOn && labourer.endedOn < date);
const isInactiveOn = (labourer: Labourer, date: string) => labourer.active === false || hasEndedBefore(labourer, date);
const canMarkAttendanceOn = (labourer: Labourer, date: string) => !isInactiveOn(labourer, date);
const paymentTypeLabel = (paymentType: PaymentType | undefined) => ({
  daily_wage: "Daily Wage",
  production_based: "Production Based",
  contract_lump_sum: "Contract",
  monthly_salary: "Monthly Salary",
  other: "Other",
}[paymentType ?? "daily_wage"]);

const labourPaymentSummary = (labourer: Labourer) => {
  const type = labourer.paymentType ?? "daily_wage";
  if (type === "production_based") {
    const unit = labourer.productionUnit === "custom" ? labourer.customProductionUnit || "unit" : labourer.productionUnit || "unit";
    return `${money(labourer.productionUnitRate ?? 0)}/${unit}`;
  }
  if (type === "contract_lump_sum") return `${money(labourer.contractAmount ?? 0)} contract`;
  if (type === "monthly_salary") return `${money(labourer.monthlySalary ?? 0)}/month`;
  if (type === "other") return labourer.otherPaymentRate ? money(labourer.otherPaymentRate) : (labourer.otherPaymentDescription || "Other");
  return `${money(labourer.dailyWage)}/day`;
};

function useData<T>(load: () => Promise<T[]>, setup?: () => Promise<void>) {
  const [records, setRecords] = useState<T[]>([]);
  const refresh = useCallback(async () => {
    if (setup) await setup();
    setRecords(await load());
  }, [load, setup]);

  useEffect(() => {
    void refresh();
    window.addEventListener("muzare-data-refresh", refresh);
    window.addEventListener("muzare-local-data-change", refresh);
    return () => {
      window.removeEventListener("muzare-data-refresh", refresh);
      window.removeEventListener("muzare-local-data-change", refresh);
    };
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

function LabourMultiSelect({
  options,
  selectedIds,
  onChange,
  label = "Labour",
}: {
  options: Labourer[];
  selectedIds: string[];
  onChange: (nextIds: string[]) => void;
  label?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(100);
  const filtered = options
    .filter((labourer) => labourer.name.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
  const visible = filtered.slice(0, visibleCount);
  const selectedCount = selectedIds.length;
  const summary = selectedCount === 0 || selectedCount === options.length
    ? "All Labour"
    : `${selectedCount} Labour Selected`;
  return (
    <div className="report-labour-filter">
      <span>{label}</span>
      <button className="report-labour-filter__toggle" type="button" onClick={() => setOpen((current) => !current)}>
        {summary}
      </button>
      {open && <div className="report-labour-filter__picker">
        <SearchInput
          placeholder={t("workforcePage.searchLabour")}
          value={search}
          onChange={(value) => {
            setSearch(value);
            setVisibleCount(100);
          }}
          onClear={() => setVisibleCount(100)}
        />
        <div className="report-labour-filter__actions">
          <button type="button" onClick={() => onChange(filtered.map((labourer) => labourer.id))}>Select All</button>
          <button type="button" onClick={() => onChange([])}>Clear Selection</button>
        </div>
        <div className="report-labour-filter__list">
          {!filtered.length && <p className="empty-records">No labour found.</p>}
          {visible.map((labourer) => (
            <label key={labourer.id}>
              <input
                checked={selectedIds.includes(labourer.id)}
                type="checkbox"
                onChange={() => {
                  if (selectedIds.includes(labourer.id)) onChange(selectedIds.filter((id) => id !== labourer.id));
                  else onChange([...selectedIds, labourer.id]);
                }}
              />
              <span>{labourer.name}</span>
            </label>
          ))}
          {filtered.length > visibleCount && (
            <button type="button" onClick={() => setVisibleCount((count) => count + 100)}>
              Show more ({filtered.length - visibleCount} remaining)
            </button>
          )}
        </div>
      </div>}
    </div>
  );
}

function WorkforceModule({ openAttendanceOnLoad = false, onAttendanceClose }: { openAttendanceOnLoad?: boolean; onAttendanceClose?: () => void }) {
  const { t } = useTranslation();
  const { token, user } = useAuth();
  const sync = useSyncState();
  const loadLabourers = useCallback(async () => (await workspaceRecords(offlineDb.labourers)).sort((a, b) => {
    const dateA = a.joinedOn || a.createdAt;
    const dateB = b.joinedOn || b.createdAt;
    if (dateA !== dateB) return dateA.localeCompare(dateB);
    const nameCompare = a.name.localeCompare(b.name);
    if (nameCompare !== 0) return nameCompare;
    return a.id.localeCompare(b.id);
  }), []);
  const loadGroups = useCallback(async () => (await workspaceRecords(offlineDb.labourGroups)).sort((a, b) => a.name.localeCompare(b.name)), []);
  const loadAttendance = useCallback(async () => (await workspaceRecords(offlineDb.attendance)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), []);
  const loadAdvances = useCallback(async () => (await workspaceRecords(offlineDb.advances)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), []);
  const loadAccounts = useCallback(async () => (await workspaceRecords(offlineDb.accounts)).sort((a, b) => a.name.localeCompare(b.name)), []);
  const loadProductionEntries = useCallback(async () => (await workspaceRecords(offlineDb.productionEntries)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), []);
  const loadPayments = useCallback(async () => (await workspaceRecords(offlineDb.labourPayments)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), []);
  const [labourers, refreshLabourers] = useData(loadLabourers);
  const [groups, refreshGroups] = useData(loadGroups);
  const [attendance, refreshAttendance, setAttendance] = useData(loadAttendance);
  const [advances, refreshAdvances, setAdvances] = useData(loadAdvances);
  const [accounts] = useData(loadAccounts, ensureLocalAccounts);
  const [productionEntries, refreshProductionEntries, setProductionEntries] = useData(loadProductionEntries);
  const [payments, refreshPayments, setPayments] = useData(loadPayments);
  const [date, setDate] = useState(today());
  const [attendanceSearch, setAttendanceSearch] = useState("");
  const [labourSearch, setLabourSearch] = useState("");
  const [groupFilterId, setGroupFilterId] = useState<string>("all");
  const [paymentTypeFilter, setPaymentTypeFilter] = useState<PaymentType | "all">("all");
  const [attendanceFilter, setAttendanceFilter] = useState<Attendance["status"] | "all">("all");
  const [showInactiveLabour, setShowInactiveLabour] = useState(false);
  const [selectedLabourer, setSelectedLabourer] = useState<Labourer | null>(null);
  const [markingLabourers, setMarkingLabourers] = useState<Set<string>>(() => new Set());
  const [showReport, setShowReport] = useState(false);
  const [showAdvanceReport, setShowAdvanceReport] = useState(false);
  const [showReportsMenu, setShowReportsMenu] = useState(false);
  const [showAdvanceEntry, setShowAdvanceEntry] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showAddLabour, setShowAddLabour] = useState(false);
  const [showAddGroup, setShowAddGroup] = useState(false);
  const [showAttendanceEntry, setShowAttendanceEntry] = useState(false);
  const [showRegisterFilters, setShowRegisterFilters] = useState(false);
  const [labourAction, setLabourAction] = useState<"update" | "advance" | "production" | "payment" | "deactivate" | null>(null);
  const [newAttendanceLabourId, setNewAttendanceLabourId] = useState<string | null>(null);
  const [attendanceSaveState, setAttendanceSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const attendanceRowRefs = useRef<Record<string, HTMLElement | null>>({});

  const markAttendance = async (targetLabourerId: string, status: Attendance["status"]) => {
    const labourer = labourers.find((item) => item.id === targetLabourerId);
    if (!labourer || !canMarkAttendanceOn(labourer, date)) return;
    if (markingLabourers.has(targetLabourerId)) return;
    setAttendanceSaveState("saving");
    setMarkingLabourers((current) => new Set(current).add(targetLabourerId));
    const existing = attendance.find((entry) =>
      entry.labourerId === targetLabourerId && entry.workspaceId === getActiveWorkspaceId()
      && entry.farmId === getActiveFarmId() && entry.seasonId === getActiveSeasonId() && entry.date === date
    ) ?? await offlineDb.attendance
      .where("labourerId")
      .equals(targetLabourerId)
      .filter((entry) => entry.workspaceId === getActiveWorkspaceId() && entry.farmId === getActiveFarmId() && entry.seasonId === getActiveSeasonId() && entry.date === date)
      .first();
    try {
      if (existing?.status === status) {
        setAttendance((current) => current.filter((entry) => entry.id !== existing.id));
        await deleteOperationalRecord("attendance", existing);
        setAttendanceSaveState("saved");
        return;
      }
      const record: Attendance = existing ? { ...existing, status, updatedAt: new Date().toISOString() } : { ...makeLocalRecord(), labourerId: targetLabourerId, date, status };
      setAttendance((current) => [record, ...current.filter((entry) => entry.id !== record.id)]);
      await persistOperationalRecord("attendance", record);
      setAttendanceSaveState("saved");
    } catch {
      setAttendanceSaveState("error");
      showToast("Unable to save attendance locally. Please try again.");
    } finally {
      setMarkingLabourers((current) => {
        const next = new Set(current); next.delete(targetLabourerId); return next;
      });
    }
  };

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
    const matchesActive = showInactiveLabour || canMarkAttendanceOn(labourer, date);
    const matchesStatus = attendanceFilter === "all" || status === attendanceFilter;
    const matchesSearch = labourer.name.toLowerCase().includes(attendanceSearch.trim().toLowerCase());
    const matchesGroup = groupFilterId === "all" || labourer.groupId === groupFilterId;
    return matchesActive && matchesStatus && matchesSearch && matchesGroup;
  });
  const filteredLabourerIds = useMemo(() => filteredLabourers.map((item) => item.id), [filteredLabourers]);
  const presentToday = [...attendanceByLabourer.values()].filter((item) => item === "present").length;
  const halfDayToday = [...attendanceByLabourer.values()].filter((item) => item === "half_day").length;
  const absentToday = [...attendanceByLabourer.values()].filter((item) => item === "absent").length;
  const filteredRegister = labourers.filter((labourer) => {
    const term = labourSearch.trim().toLowerCase();
    if (!term) return true;
    const status = labourer.active === false ? "inactive" : "active";
    return labourer.name.toLowerCase().includes(term)
      || (labourer.phone ?? "").toLowerCase().includes(term)
      || (labourer.group ?? "").toLowerCase().includes(term)
      || status.includes(term);
  }).filter((labourer) => (groupFilterId === "all" || labourer.groupId === groupFilterId)
    && (paymentTypeFilter === "all" || (labourer.paymentType ?? "daily_wage") === paymentTypeFilter));
  const selectedAttendance = selectedLabourer
    ? attendance.filter((entry) => entry.labourerId === selectedLabourer.id)
    : [];
  const presentCount = selectedAttendance.filter((entry) => entry.status === "present").length;
  const halfDayCount = selectedAttendance.filter((entry) => entry.status === "half_day").length;
  const absentCount = selectedAttendance.filter((entry) => entry.status === "absent").length;
  const productionEarnings = selectedLabourer
    ? productionEntries.filter((entry) => entry.labourerId === selectedLabourer.id).reduce((sum, entry) => sum + entry.amount, 0)
    : 0;
  const monthlyEarnings = selectedLabourer?.paymentType === "monthly_salary" ? (selectedLabourer.monthlySalary ?? 0) : 0;
  const contractEarnings = selectedLabourer?.paymentType === "contract_lump_sum" ? (selectedLabourer.contractAmount ?? 0) : 0;
  const attendanceEarnings = selectedLabourer ? (presentCount + halfDayCount * 0.5) * selectedLabourer.dailyWage : 0;
  const totalEarnings = selectedLabourer?.paymentType === "production_based"
    ? productionEarnings
    : selectedLabourer?.paymentType === "monthly_salary"
      ? monthlyEarnings
      : selectedLabourer?.paymentType === "contract_lump_sum"
        ? contractEarnings
        : attendanceEarnings;
  const advanceAmount = selectedLabourer ? advances.filter((entry) => entry.labourerId === selectedLabourer.id).reduce((sum, entry) => sum + entry.amount, 0) : 0;
  const paidAmount = selectedLabourer ? payments.filter((entry) => entry.labourerId === selectedLabourer.id).reduce((sum, entry) => sum + entry.amount, 0) : 0;
  const netBalance = totalEarnings - advanceAmount - paidAmount;
  const canManageLabour = Boolean(user?.workspaceId && hasPermission(user, "MANAGE_TEAM", user.workspaceId));
  const canAddAdvance = Boolean(user?.workspaceId && hasPermission(user, "MANAGE_RECORDS", user.workspaceId));
  const showToast = (message: string) => window.dispatchEvent(new CustomEvent("muzare-toast", { detail: message }));
  const saveLabour = async (record: Labourer) => {
    setSelectedLabourer(record);
    await persistOperationalRecord("labourer", record);
    await refreshLabourers();
    setSelectedLabourer(record);
    showToast(t("workforcePage.labourUpdated"));
  };
  const saveAdvance = async (record: Advance) => {
    setAdvances((current) => [record, ...current.filter((entry) => entry.id !== record.id)]);
    await persistOperationalRecord("advance", record);
    showToast(t("workforcePage.advanceAdded"));
  };
  const saveGroup = async (record: LabourGroup) => {
    await persistOperationalRecord("labourGroup", record);
    await refreshGroups();
  };
  const saveProduction = async (record: ProductionEntry) => {
    setProductionEntries((current) => [record, ...current.filter((entry) => entry.id !== record.id)]);
    await persistOperationalRecord("productionEntry", record);
  };
  const savePayment = async (record: LabourPayment) => {
    setPayments((current) => [record, ...current.filter((entry) => entry.id !== record.id)]);
    await persistOperationalRecord("labourPayment", record);
  };
  const attendanceSaveLabel = attendanceSaveState === "saving" || markingLabourers.size > 0
    ? "Saving..."
    : attendanceSaveState === "error"
      ? "Save failed"
      : sync.status === "syncing"
        ? "Syncing..."
        : sync.status === "offline"
          ? sync.pendingCount > 0 ? "Saved locally" : "Offline"
          : sync.pendingCount > 0
            ? "Saved locally. Syncing..."
            : attendanceSaveState === "saved" ? "Saved" : "Synced";
  useEffect(() => {
    if (openAttendanceOnLoad) setShowAttendanceEntry(true);
  }, [openAttendanceOnLoad]);
  useEffect(() => {
    if (attendanceSaveState !== "saved" || sync.pendingCount > 0 || sync.status === "syncing") return;
    const handle = window.setTimeout(() => setAttendanceSaveState("idle"), 1400);
    return () => window.clearTimeout(handle);
  }, [attendanceSaveState, sync.pendingCount, sync.status]);
  useEffect(() => {
    if (!showAttendanceEntry || !newAttendanceLabourId) return;
    if (!filteredLabourerIds.includes(newAttendanceLabourId)) return;
    const handle = window.setTimeout(() => {
      const node = attendanceRowRefs.current[newAttendanceLabourId];
      node?.scrollIntoView({ behavior: "smooth", block: "center" });
      if (node) {
        node.classList.add("attendance-card--new");
        window.setTimeout(() => node.classList.remove("attendance-card--new"), 2200);
      }
      setNewAttendanceLabourId(null);
    }, 80);
    return () => window.clearTimeout(handle);
  }, [showAttendanceEntry, newAttendanceLabourId, filteredLabourerIds]);

  return (
    <>
      <section className="record-panel">
        <header className="workforce-page-header">
          <h2>Workforce</h2>
          <p>Manage labour, attendance, advances, and groups.</p>
        </header>
        <div className="workforce-top-actions">
          <button className="workforce-mark-attendance" type="button" onClick={() => setShowAttendanceEntry(true)}>Mark Attendance</button>
          <div className="workforce-toolbar">
            {canManageLabour && <button type="button" onClick={() => setShowAddLabour(true)}>{t("workforcePage.addLabour")}</button>}
            {canAddAdvance && <button type="button" onClick={() => setShowAdvanceEntry(true)}>Advance</button>}
            {canManageLabour && <button type="button" onClick={() => setShowAddGroup(true)}>Groups</button>}
            <button type="button" onClick={() => setShowReportsMenu(true)}>Reports</button>
          </div>
          {user?.workspaceId && hasPermission(user, "IMPORT_ATTENDANCE", user.workspaceId) && <button className="workforce-inline-link" type="button" onClick={() => {
            if (!navigator.onLine) window.dispatchEvent(new CustomEvent("muzare-toast", { detail: t("errors.csvImportOnlineOnly") }));
            else setShowImport(true);
          }}>{t("workforcePage.importCsv")}</button>}
        </div>
        <div className="workforce-list-header">
          <h2>Labour List</h2>
          <div className="workforce-list-header__controls">
            <SearchInput placeholder={t("workforcePage.searchRegister")} value={labourSearch} onChange={setLabourSearch} />
            <button type="button" aria-label="More workforce filters" onClick={() => setShowRegisterFilters((current) => !current)}>
              <MoreVertical size={18} />
            </button>
          </div>
        </div>
        {showRegisterFilters && <div className="attendance-tools workforce-filters">
          <select value={groupFilterId} onChange={(event) => setGroupFilterId(event.target.value)}>
            <option value="all">All groups</option>
            {groups.filter((group) => group.active !== false).map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
          <select value={paymentTypeFilter} onChange={(event) => setPaymentTypeFilter(event.target.value as PaymentType | "all")}>
            <option value="all">All payment types</option>
            <option value="daily_wage">Daily Wage</option>
            <option value="production_based">Production Based</option>
            <option value="contract_lump_sum">Contract / Lump Sum</option>
            <option value="monthly_salary">Monthly Salary</option>
            <option value="other">Other</option>
          </select>
          <button type="button" onClick={() => {
            setLabourSearch("");
            setGroupFilterId("all");
            setPaymentTypeFilter("all");
          }}>{t("common.clear")}</button>
        </div>}
        {!labourers.length ? <Empty>{t("workforcePage.noLabourRecorded")}</Empty> : !filteredRegister.length ? <Empty>{t("workforcePage.noLabourFound")}</Empty> : (
          <div className="record-list workforce-list">
            {filteredRegister.map((labourer, index) => (
              <article className="workforce-row" key={labourer.id} role="button" tabIndex={0} onClick={() => setSelectedLabourer(labourer)} onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") setSelectedLabourer(labourer);
              }}>
                <span className="workforce-row__index">{index + 1}</span>
                <span className="workforce-row__body">
                  <strong>{labourer.name}</strong>
                  <span>{labourer.group} • {paymentTypeLabel(labourer.paymentType)}</span>
                  <em className={isInactiveOn(labourer, today()) ? "status-inactive" : "status-active"}>{isInactiveOn(labourer, today()) ? "Inactive" : "Active"}</em>
                  {labourer.endedOn && <small>End date: {labourer.endedOn}</small>}
                </span>
                <button className="workforce-row__action" type="button" onClick={(event) => {
                  event.stopPropagation();
                  setSelectedLabourer(labourer);
                  setLabourAction("update");
                }}>Update</button>
              </article>
            ))}
          </div>
        )}
      </section>
      {showAttendanceEntry && <div className="worker-dialog-backdrop" role="presentation" onClick={() => {
        if (onAttendanceClose) onAttendanceClose();
        else setShowAttendanceEntry(false);
      }}>
        <section className="attendance-report-dialog attendance-report-dialog--preview" role="dialog" aria-modal="true" aria-labelledby="mark-attendance-title" onClick={(event) => event.stopPropagation()}>
          <header className="attendance-report-header">
            <div>
              <span>{t("workforcePage.dailyAttendance")}</span>
              <h2 id="mark-attendance-title">Mark Attendance</h2>
            </div>
            <div className="attendance-header-actions">
              <span className={`attendance-auto-save attendance-auto-save--${sync.status}`} role="status" aria-live="polite">{attendanceSaveLabel}</span>
              <button className="attendance-report-close" type="button" onClick={() => {
                if (onAttendanceClose) onAttendanceClose();
                else setShowAttendanceEntry(false);
              }} aria-label="Close mark attendance"><X size={19} /></button>
            </div>
          </header>
          <section className="record-panel daily-attendance-panel attendance-entry-modal-body">
            {(sync.status === "offline" || sync.dataSource === "cache") && <div className="attendance-cache-banner" role="status">
              <strong>{sync.status === "offline" ? "Offline mode: showing cached labour. Attendance will sync later." : "Showing cached labour while the latest records load."}</strong>
              <small>Last synced: {readableSyncTime(sync.lastSyncTime)}</small>
            </div>}
            {sync.pendingCount > 0 && <div className="attendance-cache-banner attendance-cache-banner--pending" role="status">
              <strong>Pending sync: {sync.pendingCount} change{sync.pendingCount === 1 ? "" : "s"} waiting.</strong>
            </div>}
            <div className="attendance-entry-controls">
              <select value={groupFilterId} onChange={(event) => setGroupFilterId(event.target.value)}>
                <option value="all">All groups</option>
                {groups.filter((group) => group.active !== false).map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
              </select>
              <label className="attendance-date-control">
                <span>Date</span>
                <input aria-label="Attendance date" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
              </label>
              <SearchInput className="attendance-entry-search" placeholder={t("workforcePage.searchLabour")} value={attendanceSearch} onChange={setAttendanceSearch} />
            </div>
            <div className="attendance-actions">
              {canManageLabour && <button type="button" onClick={() => setShowAddLabour(true)}>{t("workforcePage.addLabour")}</button>}
            </div>
            <div className="attendance-entry-meta">
              <label className="attendance-inactive-toggle"><input type="checkbox" checked={showInactiveLabour} onChange={(event) => setShowInactiveLabour(event.target.checked)} /> {t("workforcePage.showInactive")}</label>
            </div>
            <div className="attendance-totals" aria-label={t("workforcePage.attendanceTotals")}>
              <button
                type="button"
                className={`attendance-total--present ${attendanceFilter === "present" ? "is-active" : ""}`}
                onClick={() => setAttendanceFilter((current) => (current === "present" ? "all" : "present"))}
              >
                P: {presentToday}
              </button>
              <button
                type="button"
                className={`attendance-total--half ${attendanceFilter === "half_day" ? "is-active" : ""}`}
                onClick={() => setAttendanceFilter((current) => (current === "half_day" ? "all" : "half_day"))}
              >
                1/2: {halfDayToday}
              </button>
              <button
                type="button"
                className={`attendance-total--absent ${attendanceFilter === "absent" ? "is-active" : ""}`}
                onClick={() => setAttendanceFilter((current) => (current === "absent" ? "all" : "absent"))}
              >
                A: {absentToday}
              </button>
            </div>
            <div className="attendance-board">
              {!labourers.length && sync.dataSource === "cache"
                ? <Empty>No labour list is saved on this device. Connect once to sync labour.</Empty>
                : !filteredLabourers.length ? <Empty>{t("workforcePage.noLabourSearch")}</Empty> : filteredLabourers.map((labourer, index) => {
                const currentStatus = attendanceByLabourer.get(labourer.id);
                const previousStatus = yesterdayByLabourer.get(labourer.id);
                const markable = canMarkAttendanceOn(labourer, date);
                return (
                  <article className="attendance-card" key={labourer.id} ref={(node) => { attendanceRowRefs.current[labourer.id] = node; }}>
                    <span className="attendance-card__index">{index + 1}</span>
                    <div className="attendance-card__body">
                      <strong>{labourer.name}</strong>
                      <span>{t("workforcePage.yesterday")}: {previousStatus ? previousStatus === "half_day" ? "1/2" : previousStatus === "present" ? "P" : "A" : "-"}</span>
                      {!markable && <span className="status-inactive">Not available for attendance</span>}
                    </div>
                    <div className="attendance-status-buttons">
                      <button disabled={!markable || markingLabourers.has(labourer.id)} className={currentStatus === "present" ? "is-active" : ""} type="button" onClick={() => void markAttendance(labourer.id, "present")}>P</button>
                      <button disabled={!markable || markingLabourers.has(labourer.id)} className={currentStatus === "half_day" ? "is-active" : ""} type="button" onClick={() => void markAttendance(labourer.id, "half_day")}>1/2</button>
                      <button disabled={!markable || markingLabourers.has(labourer.id)} className={currentStatus === "absent" ? "is-active" : ""} type="button" onClick={() => void markAttendance(labourer.id, "absent")}>A</button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        </section>
      </div>}
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
                <div><dt>Payment Type</dt><dd>{(selectedLabourer.paymentType ?? "daily_wage").replaceAll("_", " ")}</dd></div>
                <div><dt>Payment Summary</dt><dd>{labourPaymentSummary(selectedLabourer)}</dd></div>
                <div><dt>Group</dt><dd>{selectedLabourer.group}</dd></div>
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
                <div><dt>Payments</dt><dd className={paidAmount > 0 ? "negative" : ""}>{money(paidAmount)}</dd></div>
                <div><dt>Net Balance</dt><dd className={netBalance < 0 ? "negative" : "positive"}>{money(netBalance)}</dd></div>
              </dl>
            </div>
            <footer className="worker-dialog__footer">
              {canManageLabour && <button className="worker-dialog__link" type="button" onClick={() => setLabourAction("update")}>Update</button>}
              {canAddAdvance && <button className="worker-dialog__link" type="button" onClick={() => setLabourAction("advance")}>Advance</button>}
              {canAddAdvance && selectedLabourer.paymentType === "production_based" && <button className="worker-dialog__link" type="button" onClick={() => setLabourAction("production")}>Production</button>}
              {canAddAdvance && <button className="worker-dialog__link" type="button" onClick={() => setLabourAction("payment")}>Payment</button>}
              {canManageLabour && <button className="worker-dialog__link worker-dialog__link--danger" type="button" onClick={() => {
                if (!navigator.onLine || sync.pendingCount > 0) showToast(t("errors.syncPendingBeforeDeactivate"));
                else setLabourAction("deactivate");
              }}>{selectedLabourer.active === false ? "Delete" : "Deactivate / Delete"}</button>}
              <button className="worker-dialog__close" type="button" onClick={() => setSelectedLabourer(null)}>Close</button>
            </footer>
          </section>
        </div>
      )}
      {selectedLabourer && labourAction === "update" && <EditLabourPanel labourer={selectedLabourer} onClose={() => setLabourAction(null)} onSave={saveLabour} />}
      {selectedLabourer && labourAction === "advance" && <AddAdvancePanel labourer={selectedLabourer} accounts={accounts} onClose={() => setLabourAction(null)} onSave={saveAdvance} />}
      {showAdvanceEntry && <AdvanceEntryPanel
        labourers={labourers}
        groups={groups}
        accounts={accounts}
        onClose={() => setShowAdvanceEntry(false)}
        onSave={async (record) => {
          await saveAdvance(record);
          await refreshAdvances();
          setShowAdvanceEntry(false);
        }}
      />}
      {showReportsMenu && <ReportsMenuPanel
        onClose={() => setShowReportsMenu(false)}
        onAttendanceReport={() => {
          setShowReportsMenu(false);
          setShowReport(true);
        }}
        onAdvanceReport={() => {
          setShowReportsMenu(false);
          setShowAdvanceReport(true);
        }}
      />}
      {selectedLabourer && labourAction === "production" && <AddProductionPanel labourer={selectedLabourer} onClose={() => setLabourAction(null)} onSave={saveProduction} />}
      {selectedLabourer && labourAction === "payment" && <AddPaymentPanel labourer={selectedLabourer} onClose={() => setLabourAction(null)} onSave={savePayment} />}
      {showAddGroup && <AddGroupPanel onClose={() => setShowAddGroup(false)} onSave={async (record) => {
        await saveGroup(record);
        setShowAddGroup(false);
      }} />}
      {showAddLabour && <AddLabourPanel groups={groups} onCreateGroup={saveGroup} onClose={() => setShowAddLabour(false)} onSave={async (record) => {
        await persistOperationalRecord("labourer", record);
        await refreshLabourers();
        await refreshGroups();
        if (showAttendanceEntry) {
          setAttendanceSearch("");
          setAttendanceFilter("all");
          setGroupFilterId("all");
          setShowInactiveLabour(true);
          setNewAttendanceLabourId(record.id);
        }
        setShowAddLabour(false);
        showToast(t("workforcePage.labourAdded"));
      }} />}
      {selectedLabourer && labourAction === "deactivate" && token && user?.workspaceId && (
        <DeactivateLabourPanel
          token={token} workspaceId={user.workspaceId} labourer={selectedLabourer}
          onClose={() => setLabourAction(null)}
          onComplete={async (action) => {
            await refreshOperationalData(); await Promise.all([refreshLabourers(), refreshAttendance(), refreshAdvances(), refreshPayments(), refreshProductionEntries()]);
            setLabourAction(null); setSelectedLabourer(null);
            showToast(action === "deleted" ? t("workforcePage.labourDeleted") : t("workforcePage.labourDeactivated"));
          }}
        />
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
      {showAdvanceReport && token && user?.workspaceId && sync.farmId && sync.seasonId && (
        <AdvanceReportPanel
          token={token}
          workspaceId={user.workspaceId}
          farmId={sync.farmId}
          seasonId={sync.seasonId}
          labourers={labourers}
          onClose={() => setShowAdvanceReport(false)}
        />
      )}
      {showImport && token && user?.workspaceId && sync.farmId && sync.seasonId && (
        <AttendanceImportPanel
          token={token} workspaceId={user.workspaceId} farmId={sync.farmId} seasonId={sync.seasonId}
          onClose={() => setShowImport(false)}
          onImported={() => Promise.all([refreshLabourers(), refreshAttendance(), refreshAdvances(), refreshPayments(), refreshProductionEntries()]).then(() => undefined)}
        />
      )}
    </>
  );
}

type LabourEditorForm = {
  name: string;
  paymentType: PaymentType;
  group: string;
  groupId: string;
  dailyWage: string;
  productionUnit: string;
  customProductionUnit: string;
  productionUnitRate: string;
  minimumGuarantee: string;
  contractTitle: string;
  contractAmount: string;
  contractStartDate: string;
  contractExpectedEndDate: string;
  contractTerms: string;
  monthlySalary: string;
  paymentDay: string;
  otherPaymentDescription: string;
  otherPaymentRate: string;
  active: boolean;
  joinedOn: string;
  endedOn: string;
  phone: string;
  notes: string;
};

function LabourPaymentFields({ form, setForm }: { form: LabourEditorForm; setForm: (next: LabourEditorForm) => void }) {
  return <>
    <label><span>Payment type *</span><select required value={form.paymentType} onChange={(event) => setForm({ ...form, paymentType: event.target.value as PaymentType })}>
      <option value="daily_wage">Daily Wage</option>
      <option value="production_based">Production Based</option>
      <option value="contract_lump_sum">Contract / Lump Sum</option>
      <option value="monthly_salary">Monthly Salary</option>
      <option value="other">Other</option>
    </select></label>
    {form.paymentType === "daily_wage" && <label><span>Daily wage rate *</span><input required min="0" step="0.01" type="number" value={form.dailyWage} onChange={(event) => setForm({ ...form, dailyWage: event.target.value })} /></label>}
    {form.paymentType === "production_based" && <>
      <label><span>Production unit *</span><select value={form.productionUnit} onChange={(event) => setForm({ ...form, productionUnit: event.target.value })}>
        <option value="carton">Carton</option><option value="crate">Crate</option><option value="tree">Tree</option><option value="task">Task</option><option value="custom">Custom</option>
      </select></label>
      {form.productionUnit === "custom" && <label><span>Custom unit name *</span><input required value={form.customProductionUnit} onChange={(event) => setForm({ ...form, customProductionUnit: event.target.value })} /></label>}
      <label><span>Unit rate *</span><input required min="0" step="0.01" type="number" value={form.productionUnitRate} onChange={(event) => setForm({ ...form, productionUnitRate: event.target.value })} /></label>
      <label><span>Minimum guarantee</span><input min="0" step="0.01" type="number" value={form.minimumGuarantee} onChange={(event) => setForm({ ...form, minimumGuarantee: event.target.value })} /></label>
    </>}
    {form.paymentType === "contract_lump_sum" && <>
      <label><span>Contract title/name</span><input value={form.contractTitle} onChange={(event) => setForm({ ...form, contractTitle: event.target.value })} /></label>
      <label><span>Total contract amount *</span><input required min="0" step="0.01" type="number" value={form.contractAmount} onChange={(event) => setForm({ ...form, contractAmount: event.target.value })} /></label>
      <label><span>Contract start date</span><input type="date" value={form.contractStartDate} onChange={(event) => setForm({ ...form, contractStartDate: event.target.value })} /></label>
      <label><span>Expected end date</span><input type="date" value={form.contractExpectedEndDate} onChange={(event) => setForm({ ...form, contractExpectedEndDate: event.target.value })} /></label>
      <label><span>Payment terms/notes</span><textarea value={form.contractTerms} onChange={(event) => setForm({ ...form, contractTerms: event.target.value })} /></label>
    </>}
    {form.paymentType === "monthly_salary" && <>
      <label><span>Monthly salary amount *</span><input required min="0" step="0.01" type="number" value={form.monthlySalary} onChange={(event) => setForm({ ...form, monthlySalary: event.target.value })} /></label>
      <label><span>Payment day</span><input min="1" max="31" step="1" type="number" value={form.paymentDay} onChange={(event) => setForm({ ...form, paymentDay: event.target.value })} /></label>
    </>}
    {form.paymentType === "other" && <>
      <label><span>Description</span><input value={form.otherPaymentDescription} onChange={(event) => setForm({ ...form, otherPaymentDescription: event.target.value })} /></label>
      <label><span>Amount/rate</span><input min="0" step="0.01" type="number" value={form.otherPaymentRate} onChange={(event) => setForm({ ...form, otherPaymentRate: event.target.value })} /></label>
    </>}
  </>;
}

function EditLabourPanel({ labourer, onClose, onSave }: { labourer: Labourer; onClose: () => void; onSave: (record: Labourer) => Promise<void> }) {
  const [form, setForm] = useState<LabourEditorForm>({
    name: labourer.name,
    paymentType: labourer.paymentType ?? "daily_wage",
    group: labourer.group,
    groupId: labourer.groupId ?? "",
    dailyWage: String(labourer.dailyWage),
    productionUnit: labourer.productionUnit ?? "carton",
    customProductionUnit: labourer.customProductionUnit ?? "",
    productionUnitRate: String(labourer.productionUnitRate ?? ""),
    minimumGuarantee: String(labourer.minimumGuarantee ?? ""),
    contractTitle: labourer.contractTitle ?? "",
    contractAmount: String(labourer.contractAmount ?? ""),
    contractStartDate: labourer.contractStartDate ?? "",
    contractExpectedEndDate: labourer.contractExpectedEndDate ?? "",
    contractTerms: labourer.contractTerms ?? "",
    monthlySalary: String(labourer.monthlySalary ?? ""),
    paymentDay: String(labourer.paymentDay ?? ""),
    otherPaymentDescription: labourer.otherPaymentDescription ?? "",
    otherPaymentRate: String(labourer.otherPaymentRate ?? ""),
    active: labourer.active !== false,
    joinedOn: labourer.joinedOn ?? labourer.createdAt.slice(0, 10),
    endedOn: labourer.endedOn ?? "",
    phone: labourer.phone ?? "",
    notes: labourer.notes ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim()) { setError("Labour name is required."); return; }
    if (busy) return;
    setBusy(true); setError("");
    try {
      await onSave({
        ...labourer,
        name: form.name.trim(),
        paymentType: form.paymentType,
        group: form.group.trim() || "General",
        groupId: form.groupId || undefined,
        dailyWage: Number(form.dailyWage || 0),
        productionUnit: form.paymentType === "production_based" ? form.productionUnit as Labourer["productionUnit"] : undefined,
        customProductionUnit: form.paymentType === "production_based" && form.productionUnit === "custom" ? form.customProductionUnit.trim() || undefined : undefined,
        productionUnitRate: form.paymentType === "production_based" ? Number(form.productionUnitRate || 0) : undefined,
        minimumGuarantee: form.paymentType === "production_based" ? Number(form.minimumGuarantee || 0) : undefined,
        contractTitle: form.paymentType === "contract_lump_sum" ? form.contractTitle.trim() || undefined : undefined,
        contractAmount: form.paymentType === "contract_lump_sum" ? Number(form.contractAmount || 0) : undefined,
        contractStartDate: form.paymentType === "contract_lump_sum" ? form.contractStartDate || undefined : undefined,
        contractExpectedEndDate: form.paymentType === "contract_lump_sum" ? form.contractExpectedEndDate || undefined : undefined,
        contractTerms: form.paymentType === "contract_lump_sum" ? form.contractTerms.trim() || undefined : undefined,
        monthlySalary: form.paymentType === "monthly_salary" ? Number(form.monthlySalary || 0) : undefined,
        paymentDay: form.paymentType === "monthly_salary" ? Number(form.paymentDay || 1) : undefined,
        otherPaymentDescription: form.paymentType === "other" ? form.otherPaymentDescription.trim() || undefined : undefined,
        otherPaymentRate: form.paymentType === "other" ? Number(form.otherPaymentRate || 0) : undefined,
        active: form.active,
        joinedOn: form.joinedOn,
        endedOn: form.endedOn || undefined,
        phone: form.phone.trim() || undefined,
        notes: form.notes.trim() || undefined,
        updatedAt: new Date().toISOString(),
      });
      onClose();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to update labour."); }
    finally { setBusy(false); }
  };
  return <ActionPanel title="Update Labour" onClose={onClose}>
    <form className="worker-action-form" onSubmit={(event) => void submit(event)}>
      <label><span>Labour name *</span><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
      <label><span>Group</span><input value={form.group} onChange={(event) => setForm({ ...form, group: event.target.value })} /></label>
      <LabourPaymentFields form={form} setForm={setForm} />
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

function AddLabourPanel({
  groups,
  onCreateGroup,
  onClose,
  onSave,
}: {
  groups: LabourGroup[];
  onCreateGroup: (record: LabourGroup) => Promise<void>;
  onClose: () => void;
  onSave: (record: Labourer) => Promise<void>;
}) {
  const [form, setForm] = useState<LabourEditorForm>({
    name: "",
    paymentType: "daily_wage",
    group: "General",
    groupId: "",
    dailyWage: "90",
    productionUnit: "carton",
    customProductionUnit: "",
    productionUnitRate: "",
    minimumGuarantee: "",
    contractTitle: "",
    contractAmount: "",
    contractStartDate: "",
    contractExpectedEndDate: "",
    contractTerms: "",
    monthlySalary: "",
    paymentDay: "",
    otherPaymentDescription: "",
    otherPaymentRate: "",
    active: true,
    joinedOn: today(),
    endedOn: "",
    phone: "",
    notes: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim()) { setError("Labour name is required."); return; }
    setBusy(true);
    setError("");
    try {
      let nextGroupId = form.groupId;
      if (form.groupId === "__new_group__" && form.group.trim()) {
        const record: LabourGroup = { ...makeLocalRecord(), name: form.group.trim(), active: true };
        await onCreateGroup(record);
        nextGroupId = record.id;
      }
      await onSave({
        ...makeLocalRecord(),
        name: form.name.trim(),
        group: form.group.trim() || "General",
        groupId: nextGroupId || undefined,
        paymentType: form.paymentType,
        dailyWage: Number(form.dailyWage || 0),
        productionUnit: form.paymentType === "production_based" ? form.productionUnit as Labourer["productionUnit"] : undefined,
        customProductionUnit: form.paymentType === "production_based" && form.productionUnit === "custom" ? form.customProductionUnit.trim() || undefined : undefined,
        productionUnitRate: form.paymentType === "production_based" ? Number(form.productionUnitRate || 0) : undefined,
        minimumGuarantee: form.paymentType === "production_based" ? Number(form.minimumGuarantee || 0) : undefined,
        contractTitle: form.paymentType === "contract_lump_sum" ? form.contractTitle.trim() || undefined : undefined,
        contractAmount: form.paymentType === "contract_lump_sum" ? Number(form.contractAmount || 0) : undefined,
        contractStartDate: form.paymentType === "contract_lump_sum" ? form.contractStartDate || undefined : undefined,
        contractExpectedEndDate: form.paymentType === "contract_lump_sum" ? form.contractExpectedEndDate || undefined : undefined,
        contractTerms: form.paymentType === "contract_lump_sum" ? form.contractTerms.trim() || undefined : undefined,
        monthlySalary: form.paymentType === "monthly_salary" ? Number(form.monthlySalary || 0) : undefined,
        paymentDay: form.paymentType === "monthly_salary" ? Number(form.paymentDay || 1) : undefined,
        otherPaymentDescription: form.paymentType === "other" ? form.otherPaymentDescription.trim() || undefined : undefined,
        otherPaymentRate: form.paymentType === "other" ? Number(form.otherPaymentRate || 0) : undefined,
        joinedOn: form.joinedOn,
        phone: form.phone.trim() || undefined,
        active: form.active,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to add labour.");
    } finally {
      setBusy(false);
    }
  };
  return <ActionPanel title="Add Labour" onClose={onClose}>
    <form className="worker-action-form" onSubmit={(event) => void submit(event)}>
      <label><span>Labour name *</span><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
      <label><span>Date of joining *</span><input required type="date" value={form.joinedOn} onChange={(event) => setForm({ ...form, joinedOn: event.target.value })} /></label>
      <label><span>Group</span><select value={form.groupId} onChange={(event) => {
        const next = event.target.value;
        const group = groups.find((item) => item.id === next);
        setForm({ ...form, groupId: next, group: group?.name ?? form.group });
      }}>
        <option value="">None</option>
        {groups.filter((group) => group.active !== false).map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
        <option value="__new_group__">Create new group</option>
      </select></label>
      {form.groupId === "__new_group__" && <label><span>New group name *</span><input required value={form.group} onChange={(event) => setForm({ ...form, group: event.target.value })} /></label>}
      <LabourPaymentFields form={form} setForm={setForm} />
      <label><span>Phone / contact</span><input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
      <label><span>Status</span><select value={form.active ? "active" : "inactive"} onChange={(event) => setForm({ ...form, active: event.target.value === "active" })}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
      {error && <p className="worker-action-error">{error}</p>}
      <footer><button type="button" onClick={onClose}>Cancel</button><button disabled={busy} type="submit">{busy ? "Saving..." : "Save Labour"}</button></footer>
    </form>
  </ActionPanel>;
}

function AddAdvancePanel({ labourer, accounts, onClose, onSave }: { labourer: Labourer; accounts: Account[]; onClose: () => void; onSave: (record: Advance) => Promise<void> }) {
  const [form, setForm] = useState({ date: today(), amount: "", accountId: "", paymentMethod: "Cash", notes: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const amount = Number(form.amount);
    if (!Number.isFinite(amount) || amount <= 0) { setError("Advance amount must be greater than zero."); return; }
    if (!form.accountId) { setError("Select the payment account."); return; }
    if (busy) return;
    setBusy(true); setError("");
    try {
      await onSave({ ...makeLocalRecord(), labourerId: labourer.id, date: form.date, amount, accountId: form.accountId, paymentMethod: form.paymentMethod, notes: form.notes.trim() });
      onClose();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to add advance."); }
    finally { setBusy(false); }
  };
  return <ActionPanel title="Add Labour Advance" onClose={onClose}>
    <form className="worker-action-form" onSubmit={(event) => void submit(event)}>
      <label><span>Labour name</span><input readOnly value={labourer.name} /></label>
      <label><span>Advance date *</span><input required type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} /></label>
      <label><span>Amount *</span><input required min="0.01" step="0.01" type="number" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} /></label>
      <label><span>Payment account *</span><select required value={form.accountId} onChange={(event) => setForm({ ...form, accountId: event.target.value })}><option value="">Select account</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
      <label><span>Payment method</span><select value={form.paymentMethod} onChange={(event) => setForm({ ...form, paymentMethod: event.target.value })}><option>Cash</option><option>Bank Transfer</option><option>Other</option></select></label>
      <label><span>Notes</span><textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
      {error && <p className="worker-action-error">{error}</p>}
      <footer><button type="button" onClick={onClose}>Cancel</button><button disabled={busy} type="submit">{busy ? "Saving..." : "Add Advance"}</button></footer>
    </form>
  </ActionPanel>;
}

function AdvanceReportPanel({
  token, workspaceId, farmId, seasonId, labourers, onClose,
}: {
  token: string; workspaceId: string; farmId: string; seasonId: string; labourers: Labourer[]; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [filters, setFilters] = useState<AdvanceReportFilters>({ farmId, seasonId, from: `${today().slice(0, 8)}01`, to: today(), labourIds: [] });
  const [groupFilterId, setGroupFilterId] = useState("all");
  const [paymentTypeFilter, setPaymentTypeFilter] = useState<PaymentType | "all">("all");
  const [submitted, setSubmitted] = useState<AdvanceReportFilters | null>(null);
  const activeGroups = labourers.reduce<Map<string, string>>((map, labourer) => {
    if (labourer.groupId && labourer.group) map.set(labourer.groupId, labourer.group);
    return map;
  }, new Map());
  const labourOptions = labourers
    .filter((labourer) => groupFilterId === "all" || labourer.groupId === groupFilterId)
    .filter((labourer) => paymentTypeFilter === "all" || (labourer.paymentType ?? "daily_wage") === paymentTypeFilter)
    .sort((a, b) => a.name.localeCompare(b.name));
  const report = useQuery({
    queryKey: [
      "advance-report",
      workspaceId,
      farmId,
      seasonId,
      submitted?.from,
      submitted?.to,
      submitted?.labourIds?.join(","),
      submitted?.labourIds?.length ?? 0,
    ],
    queryFn: () => fetchAdvanceReport(token, workspaceId, submitted!),
    enabled: Boolean(submitted),
  });
  const exportCsv = (data: AdvanceReportData) => {
    if (!data.metadata) return;
    const rows = [
      ["Farm Name", data.metadata.farmName],
      ["Season", data.metadata.seasonName],
      ["Date From", data.metadata.from],
      ["Date To", data.metadata.to],
      [],
      ["Labour Name", "Date", "Advance Amount", "Paid From", "Notes"],
      ...data.records.map((item) => [item.labourName, item.date, item.amount, item.accountName || "-", item.notes || "-"]),
      [],
      ["Labour", "Records", "Total"],
      ...data.summaries.map((item) => [item.labourName, item.count, item.total]),
      ["Grand Total", "", data.grandTotal],
    ];
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll("\"", "\"\"")}"`).join(",")).join("\n");
    const href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = href;
    link.download = `labour-advance-report-${filters.from}-${filters.to}.csv`;
    link.click();
    URL.revokeObjectURL(href);
  };

  return <div className="worker-dialog-backdrop" role="presentation" onClick={onClose}>
    <section className="attendance-report-dialog" role="dialog" aria-modal="true" aria-labelledby="advance-report-title" onClick={(event) => event.stopPropagation()}>
      <header className="attendance-report-header">
        <div><span>{t("workforcePage.labourRegister")}</span><h2 id="advance-report-title">{t("reports.advanceReportTitle")}</h2></div>
        <button className="attendance-report-close" type="button" onClick={onClose} aria-label={t("reports.closeAdvanceReport")}><X size={19} /></button>
      </header>
      <form className="attendance-report-filters" onSubmit={(event) => {
        event.preventDefault();
        const effectiveLabourIds = filters.labourIds && filters.labourIds.length > 0 ? filters.labourIds : labourOptions.map((labourer) => labourer.id);
        setSubmitted({ ...filters, labourIds: effectiveLabourIds });
      }}>
        <label><span>{t("reports.dateFrom")}</span><input required type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></label>
        <label><span>{t("reports.dateTo")}</span><input required type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></label>
        <label><span>Group</span><select value={groupFilterId} onChange={(event) => {
          setGroupFilterId(event.target.value);
          setFilters((current) => ({ ...current, labourIds: [] }));
        }}>
          <option value="all">All Groups</option>
          {[...activeGroups.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => (
            <option key={id} value={id}>{name}</option>
          ))}
        </select></label>
        <label><span>Payment Type</span><select value={paymentTypeFilter} onChange={(event) => {
          setPaymentTypeFilter(event.target.value as PaymentType | "all");
          setFilters((current) => ({ ...current, labourIds: [] }));
        }}>
          <option value="all">All Types</option>
          <option value="daily_wage">Daily Wage</option>
          <option value="production_based">Production Based</option>
          <option value="contract_lump_sum">Contract</option>
          <option value="monthly_salary">Monthly Salary</option>
          <option value="other">Other</option>
        </select></label>
        <LabourMultiSelect
          label={t("reports.labourFilter")}
          options={labourOptions}
          selectedIds={filters.labourIds ?? []}
          onChange={(nextIds) => setFilters((current) => ({ ...current, labourIds: nextIds }))}
        />
        <footer className="attendance-report-form-actions">
          <button className="attendance-report-cancel" type="button" onClick={onClose}>{t("common.close")}</button>
          <button className="attendance-report-generate" type="submit">{t("reports.generateReport")}</button>
        </footer>
      </form>
      {submitted && <div className="attendance-report-output">
        {report.isFetching && <p>{t("reports.generatingReport")}</p>}
        {report.isError && <p className="error">{report.error.message}</p>}
        {report.data && !report.data.records.length && <Empty>{t("reports.noAdvancesForPeriod")}</Empty>}
        {report.data && report.data.records.length > 0 && <>
          <div className="attendance-report-actions">
            <button type="button" onClick={() => window.print()}>{t("reports.print")}</button>
            <button type="button" onClick={() => exportCsv(report.data!)}>{t("reports.exportCsv")}</button>
          </div>
          <section className="attendance-report-card">
            <strong>{t("reports.grandTotal")}</strong>
            <p>{money(report.data.grandTotal)}</p>
            <div className="attendance-import-table-wrap">
              <table>
                <thead><tr><th>{t("reports.labour")}</th><th>{t("workforcePage.date")}</th><th>{t("reports.advanceSar")}</th><th>Paid From</th><th>{t("reports.notes")}</th></tr></thead>
                <tbody>{report.data.records.map((item) => <tr key={item.id}><td>{item.labourName}</td><td>{item.date}</td><td>{money(item.amount)}</td><td>{item.accountName || "-"}</td><td>{item.notes || "-"}</td></tr>)}</tbody>
              </table>
            </div>
          </section>
          <section className="attendance-report-card">
            <strong>{t("reports.totalsByLabour")}</strong>
            <div className="attendance-import-table-wrap">
              <table>
                <thead><tr><th>{t("reports.labour")}</th><th>{t("reports.transactions")}</th><th>{t("reports.total")}</th></tr></thead>
                <tbody>{report.data.summaries.map((item) => <tr key={item.labourerId}><td>{item.labourName}</td><td>{item.count}</td><td>{money(item.total)}</td></tr>)}</tbody>
              </table>
            </div>
          </section>
        </>}
      </div>}
    </section>
  </div>;
}

function DeactivateLabourPanel({ token, workspaceId, labourer, onClose, onComplete }: {
  token: string; workspaceId: string; labourer: Labourer; onClose: () => void; onComplete: (action: "deleted" | "deactivated") => Promise<void>;
}) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<LabourDeletionPreview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [endDate, setEndDate] = useState(today());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void fetchLabourDeletionPreview(token, workspaceId, labourer.id)
      .then((result) => { if (active) setPreview(result); })
      .catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : t("reports.unableInspectLinkedRecords")); });
    return () => { active = false; };
  }, [token, workspaceId, labourer.id]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (confirmation !== "DELETE" || busy) return;
    setBusy(true); setError("");
    try {
      const result = await deleteOrDeactivateLabour(token, workspaceId, labourer.id, { confirmation: "DELETE", endDate });
      await onComplete(result.action);
    } catch (caught) { setError(caught instanceof Error ? caught.message : t("reports.unableUpdateLabourStatus")); }
    finally { setBusy(false); }
  };
  return <ActionPanel title={t("reports.deactivateOrDeleteLabour")} onClose={onClose}>
    <form className="worker-action-form" onSubmit={(event) => void submit(event)}>
      <p><strong>{labourer.name}</strong></p>
      {!preview && !error && <p>{t("reports.checkingLinkedRecords")}</p>}
      {preview && <p>{t("reports.existingLinkedRecords")}: <strong>{preview.linkedRecordCount}</strong></p>}
      {preview?.action === "deactivate" && <p className="worker-action-warning">{t("reports.deactivatePreserveRecords")}</p>}
      {preview?.action === "delete" && <p className="worker-action-warning">{t("reports.deleteNoLinkedRecords")}</p>}
      {preview?.action === "deactivate" && <label><span>{t("reports.endDateRequired")}</span><input required type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label>}
      <label><span>{t("reports.typeDeleteConfirm")}</span><input required autoComplete="off" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
      {error && <p className="worker-action-error">{error}</p>}
      <footer><button type="button" onClick={onClose}>{t("common.close")}</button><button className="danger-button" disabled={!preview || confirmation !== "DELETE" || busy} type="submit">{busy ? t("reports.processing") : preview?.action === "delete" ? t("reports.deletePermanently") : t("reports.deactivateLabour")}</button></footer>
    </form>
  </ActionPanel>;
}

function AdvanceEntryPanel({
  labourers,
  groups,
  accounts,
  onClose,
  onSave,
}: {
  labourers: Labourer[];
  groups: LabourGroup[];
  accounts: Account[];
  onClose: () => void;
  onSave: (record: Advance) => Promise<void>;
}) {
  const [groupId, setGroupId] = useState("all");
  const [labourerId, setLabourerId] = useState("");
  const [form, setForm] = useState({ date: today(), amount: "", accountId: "", notes: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const filteredLabourers = labourers.filter((labourer) => labourer.active !== false && (groupId === "all" || labourer.groupId === groupId));
  const selectedLabourer = filteredLabourers.find((labourer) => labourer.id === labourerId);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const amount = Number(form.amount);
    if (!selectedLabourer) { setError("Select labour."); return; }
    if (!Number.isFinite(amount) || amount <= 0 || busy) { setError("Advance amount must be greater than zero."); return; }
    if (!form.accountId) { setError("Select the payment account."); return; }
    setBusy(true); setError("");
    try {
      await onSave({ ...makeLocalRecord(), labourerId: selectedLabourer.id, date: form.date, amount, accountId: form.accountId, notes: form.notes.trim() });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to add advance.");
    } finally {
      setBusy(false);
    }
  };
  return <ActionPanel title="Record Advance" onClose={onClose}>
    <form className="worker-action-form" onSubmit={(event) => void submit(event)}>
      <label><span>Date *</span><input required type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} /></label>
      <label><span>Group (optional)</span><select value={groupId} onChange={(event) => {
        setGroupId(event.target.value);
        setLabourerId("");
      }}><option value="all">All groups</option>{groups.filter((group) => group.active !== false).map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
      <label>
        <span>Labour *</span>
        <LabourSelectCombobox
          ariaLabel="Labour"
          options={filteredLabourers}
          placeholder="Search labour"
          value={labourerId}
          onChange={setLabourerId}
        />
      </label>
      <label><span>Advance amount *</span><input required min="0.01" step="0.01" type="number" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} /></label>
      <label><span>Payment account *</span><select required value={form.accountId} onChange={(event) => setForm({ ...form, accountId: event.target.value })}><option value="">Select account</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
      <label><span>Notes / reference</span><textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
      {error && <p className="worker-action-error">{error}</p>}
      <footer><button type="button" onClick={onClose}>Cancel</button><button disabled={busy} type="submit">{busy ? "Saving..." : "Save"}</button></footer>
    </form>
  </ActionPanel>;
}

function ReportsMenuPanel({
  onClose,
  onAttendanceReport,
  onAdvanceReport,
}: {
  onClose: () => void;
  onAttendanceReport: () => void;
  onAdvanceReport: () => void;
}) {
  const showToast = (message: string) => window.dispatchEvent(new CustomEvent("muzare-toast", { detail: message }));
  return <ActionPanel title="Reports" onClose={onClose}>
    <div className="worker-action-form workforce-reports-menu">
      <button type="button" onClick={onAttendanceReport}>Attendance Report</button>
      <button type="button" onClick={onAdvanceReport}>Advance Report</button>
      <button type="button" onClick={() => showToast("Production report will be available in Reports shortly.")}>Production Report</button>
      <button type="button" onClick={() => showToast("Labour ledger report will be available in Reports shortly.")}>Labour Ledger</button>
      <button type="button" onClick={() => showToast("Settlement report will be available in Reports shortly.")}>Settlement Report</button>
      <footer><button type="button" onClick={onClose}>Close</button></footer>
    </div>
  </ActionPanel>;
}

function AddGroupPanel({ onClose, onSave }: { onClose: () => void; onSave: (record: LabourGroup) => Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true); setError("");
    try {
      await onSave({ ...makeLocalRecord(), name: name.trim(), active: true });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save group.");
    } finally {
      setBusy(false);
    }
  };
  return <ActionPanel title="Add Labour Group" onClose={onClose}>
    <form className="worker-action-form" onSubmit={(event) => void submit(event)}>
      <label><span>Group name *</span><input required value={name} onChange={(event) => setName(event.target.value)} /></label>
      {error && <p className="worker-action-error">{error}</p>}
      <footer><button type="button" onClick={onClose}>Cancel</button><button disabled={busy} type="submit">{busy ? "Saving..." : "Save Group"}</button></footer>
    </form>
  </ActionPanel>;
}

function AddProductionPanel({ labourer, onClose, onSave }: { labourer: Labourer; onClose: () => void; onSave: (record: ProductionEntry) => Promise<void> }) {
  const [form, setForm] = useState({
    date: today(),
    units: "",
    productionUnit: labourer.productionUnit === "custom" ? (labourer.customProductionUnit || "Custom") : (labourer.productionUnit || "carton"),
    unitRate: String(labourer.productionUnitRate ?? 0),
    notes: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const units = Number(form.units);
    const unitRate = Number(form.unitRate);
    if (!Number.isFinite(units) || units <= 0 || !Number.isFinite(unitRate) || unitRate < 0 || busy) {
      setError("Valid units and rate are required.");
      return;
    }
    setBusy(true); setError("");
    try {
      await onSave({
        ...makeLocalRecord(),
        labourerId: labourer.id,
        date: form.date,
        units,
        productionUnit: form.productionUnit,
        unitRate,
        amount: units * unitRate,
        notes: form.notes.trim() || undefined,
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to add production entry.");
    } finally {
      setBusy(false);
    }
  };
  return <ActionPanel title="Record Production" onClose={onClose}>
    <form className="worker-action-form" onSubmit={(event) => void submit(event)}>
      <label><span>Labour</span><input readOnly value={labourer.name} /></label>
      <label><span>Date</span><input required type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} /></label>
      <label><span>Units produced *</span><input required min="0" step="0.01" type="number" value={form.units} onChange={(event) => setForm({ ...form, units: event.target.value })} /></label>
      <label><span>Production unit</span><input readOnly value={form.productionUnit} /></label>
      <label><span>Unit rate</span><input required min="0" step="0.01" type="number" value={form.unitRate} onChange={(event) => setForm({ ...form, unitRate: event.target.value })} /></label>
      <label><span>Notes</span><textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
      <p>Earnings: {money((Number(form.units) || 0) * (Number(form.unitRate) || 0))}</p>
      {error && <p className="worker-action-error">{error}</p>}
      <footer><button type="button" onClick={onClose}>Cancel</button><button disabled={busy} type="submit">{busy ? "Saving..." : "Save Production"}</button></footer>
    </form>
  </ActionPanel>;
}

function AddPaymentPanel({ labourer, onClose, onSave }: { labourer: Labourer; onClose: () => void; onSave: (record: LabourPayment) => Promise<void> }) {
  const [form, setForm] = useState({ date: today(), amount: "", paymentMethod: "Cash", notes: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const amount = Number(form.amount);
    if (!Number.isFinite(amount) || amount <= 0 || busy) {
      setError("Payment amount must be greater than zero.");
      return;
    }
    setBusy(true); setError("");
    try {
      await onSave({ ...makeLocalRecord(), labourerId: labourer.id, date: form.date, amount, paymentMethod: form.paymentMethod, notes: form.notes.trim() || undefined });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save payment.");
    } finally {
      setBusy(false);
    }
  };
  return <ActionPanel title="Add Labour Payment" onClose={onClose}>
    <form className="worker-action-form" onSubmit={(event) => void submit(event)}>
      <label><span>Labour</span><input readOnly value={labourer.name} /></label>
      <label><span>Date</span><input required type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} /></label>
      <label><span>Amount *</span><input required min="0.01" step="0.01" type="number" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} /></label>
      <label><span>Payment method</span><select value={form.paymentMethod} onChange={(event) => setForm({ ...form, paymentMethod: event.target.value })}><option>Cash</option><option>Bank Transfer</option><option>Other</option></select></label>
      <label><span>Notes</span><textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
      {error && <p className="worker-action-error">{error}</p>}
      <footer><button type="button" onClick={onClose}>Cancel</button><button disabled={busy} type="submit">{busy ? "Saving..." : "Save Payment"}</button></footer>
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
  const [accountId, setAccountId] = useState("");
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
        importSessionId: sessionId, farmId, seasonId, duplicateHandlingMode: duplicateMode, warningsAccepted, labourMappings: mappings, accountId: accountId || undefined,
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
          {summary.dailyAdvances > 0 && <label><span>Payment account for imported advances *</span><select required value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">Select payment account</option>{preview.accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>}
          {summary.dailyAdvances > 0 && !accountId && <p className="attendance-import-error">Payment account is required for imported advances.</p>}
          <p className="attendance-import-note">Advance Total columns are reference-only. Daily advances found inside date cells will be imported as separate advance records.</p>
          <div className="attendance-import-table-wrap"><table><thead><tr><th>Labour</th><th>CSV Advance Total</th><th>Daily Cell Advance Total</th></tr></thead><tbody>{preview.rows.map((row) => <tr key={row.rowIndex}><th>{row.labourName}</th><td>{row.csvAdvance === null ? "-" : money(row.csvAdvance)}</td><td>{money(row.calculatedAdvance)}</td></tr>)}</tbody></table></div>
          <div className="attendance-import-table-wrap"><table><thead><tr><th>Labour</th>{preview.dateColumns.map((column) => <th key={column.column}>{column.column}</th>)}</tr></thead><tbody>{preview.rows.slice(0, 20).map((row) => <tr key={row.rowIndex}><th>{row.labourName}</th>{row.cells.map((cell) => <td key={cell.column}><b>{attendanceMark(cell.status ?? undefined)}</b>{cell.advanceAmount !== null && <small>{money(cell.advanceAmount)}</small>}</td>)}</tr>)}</tbody></table></div>
          {busy && <p className="attendance-import-progress"><span className="attendance-import-spinner" />Importing attendance records and advances. Please wait...</p>}
          <button disabled={busy || unresolvedLabourRows.length > 0 || summary.errors.length > 0 || (summary.dailyAdvances > 0 && !accountId) || (summary.warnings.length > 0 && !warningsAccepted)} type="button" onClick={() => void confirm()}>{busy ? "Importing..." : "Confirm Import"}</button>
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
  const { t } = useTranslation();
  const sync = useSyncState();
  const [filters, setFilters] = useState<AttendanceReportFilters>({
    farmId, seasonId, from: `${today().slice(0, 8)}01`, to: today(), labourIds: [],
  });
  const [submitted, setSubmitted] = useState<AttendanceReportFilters | null>(null);
  const report = useQuery({
    queryKey: ["attendance-report", workspaceId, farmId, seasonId, submitted?.from, submitted?.to, submitted?.labourIds?.join(","), submitted?.status],
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
          <div><span>{t("workforcePage.labourRegister")}</span><h2 id="attendance-report-title">{t("reports.attendanceReportTitle")}</h2></div>
          <button className="attendance-report-close" type="button" onClick={onClose} aria-label={t("reports.closeReport")}><X size={19} /></button>
        </header>
        <form className="attendance-report-filters" onSubmit={(event) => { event.preventDefault(); setSubmitted({ ...filters }); }}>
          <label><span>{t("reports.dateFrom")}</span><input required type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></label>
          <label><span>{t("reports.dateTo")}</span><input required type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></label>
          <LabourMultiSelect
            label={t("reports.labour")}
            options={labourers}
            selectedIds={filters.labourIds ?? []}
            onChange={(nextIds) => setFilters({ ...filters, labourIds: nextIds, labourId: undefined })}
          />
          <label><span>{t("reports.status")}</span><select value={filters.status ?? ""} onChange={(event) => setFilters({ ...filters, status: (event.target.value || undefined) as AttendanceReportStatus | undefined })}>
            <option value="">{t("workforcePage.allLabour")}</option><option value="present">{t("workforcePage.present")}</option><option value="half_day">{t("workforcePage.halfDay")}</option><option value="absent">{t("workforcePage.absent")}</option>
          </select></label>
          <footer className="attendance-report-form-actions">
            <button className="attendance-report-cancel" type="button" onClick={onClose}>{t("common.close")}</button>
            <button className="attendance-report-generate" type="submit">{t("reports.generateReport")}</button>
          </footer>
        </form>
        {submitted && <div className="attendance-report-output">
          {report.isFetching && <p>{t("reports.generatingReport")}</p>}
          {report.isError && <p className="error">{report.error.message}</p>}
          {report.data && !report.data.summaries.length && <Empty>{t("reports.noAttendanceForPeriod")}</Empty>}
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
const compactAdvance = (amount: number) => new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(amount);
const compactDate = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
const compactFullDate = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;

function AttendanceRegister({ data, syncStatus, totalPresent, totalHalf, totalAbsent, totalAdvance, totalWage, workerAdvance, dailyAdvance, dailyStatus, onClose, onCsv }: {
  data: import("../lib/api").AttendanceReportData; syncStatus: string; totalPresent: number; totalHalf: number; totalAbsent: number;
  totalAdvance: number; totalWage: number; workerAdvance: (id: string) => number; dailyAdvance: (id: string, date: string) => number;
  dailyStatus: (id: string, date: string) => AttendanceReportStatus | undefined; onClose: () => void; onCsv: () => void;
}) {
  const { t } = useTranslation();
  const metadata = data.metadata!;
  const print = () => {
    if (data.dates.length > 50 && !window.confirm(t("reports.printRangeWarning"))) return;
    window.print();
  };
  return <section className="attendance-register-preview">
    <div className="attendance-report-actions no-print"><button type="button" onClick={print}>{t("reports.print")}</button><button type="button" onClick={print}>{t("reports.exportPdf")}</button><button type="button" onClick={onCsv}>{t("reports.exportCsv")}</button><button type="button" onClick={onClose}>{t("common.close")}</button></div>
    <header className="register-header screen-only">
      <div><span>{t("reports.farmLabourRegister")}</span><h2>{t("reports.attendanceReportTitle")}</h2><strong>{metadata.farmName}</strong><p>{t("currentSeason")}: {metadata.seasonName}</p></div>
      <dl><div><dt>{t("reports.dateRange")}</dt><dd>{metadata.from} {t("reports.to")} {metadata.to}</dd></div><div><dt>{t("reports.generated")}</dt><dd>{new Date(metadata.generatedAt).toLocaleString()}</dd></div><div><dt>{t("reports.generatedBy")}</dt><dd>{metadata.generatedBy}</dd></div><div><dt>{t("reports.syncStatus")}</dt><dd>{syncStatus}</dd></div></dl>
    </header>
    <div className="register-summary screen-only">
      <span>Total labour<strong>{data.summaries.length}</strong></span><span>Total P<strong>{totalPresent}</strong></span><span>Total 1/2<strong>{totalHalf}</strong></span>
      <span>Total A<strong>{totalAbsent}</strong></span><span>Total advance<strong>{money(totalAdvance)}</strong></span><span>Total wages<strong>{money(totalWage)}</strong></span>
    </div>
    <header className="print-summary">
      <b>FARM LABOUR REGISTER</b><strong>Attendance Report</strong>
      <span>Farm: {metadata.farmName} | Season: {metadata.seasonName}</span>
      <span>Period: {compactFullDate(metadata.from)} - {compactFullDate(metadata.to)} | Generated: {compactFullDate(metadata.generatedAt.slice(0, 10))}</span>
      <span>Total Labour: {data.summaries.length} | P: {totalPresent} | 1/2: {totalHalf} | A: {totalAbsent} | Wages (SAR): {compactAdvance(totalWage)} | Advances (SAR): {compactAdvance(totalAdvance)} | Net (SAR): {compactAdvance(totalWage - totalAdvance)}</span>
    </header>
    <div className="register-table-wrap"><table className="attendance-register-table">
      <thead><tr><th>#</th><th>Labour Name</th><th>P</th><th>1/2</th><th>A</th><th>Wages (SAR)</th><th>Adv (SAR)</th><th>Net (SAR)</th>{data.dates.map((date) => <th key={date}>{compactDate(date)}</th>)}</tr></thead>
      <tbody>{data.summaries.map((summary, index) => { const advance = workerAdvance(summary.id); return <tr key={summary.id}><td>{index + 1}</td><th>{summary.name}</th><td>{summary.presentDays}</td><td>{summary.halfDays}</td><td>{summary.absentDays}</td><td>{compactAdvance(summary.totalWage)}</td><td>{compactAdvance(advance)}</td><td>{compactAdvance(summary.totalWage - advance)}</td>
        {data.dates.map((date) => { const status = dailyStatus(summary.id, date); const advance = dailyAdvance(summary.id, date); return <td className={`register-status register-status--${status ?? "empty"}`} key={date}><b>{attendanceMark(status)}</b>{advance > 0 && <small>{compactAdvance(advance)}</small>}</td>; })}
      </tr>; })}</tbody>
      <tfoot><tr><th colSpan={2}>Grand Total</th><th>{totalPresent}</th><th>{totalHalf}</th><th>{totalAbsent}</th><th>{compactAdvance(totalWage)}</th><th>{compactAdvance(totalAdvance)}</th><th>{compactAdvance(totalWage - totalAdvance)}</th><th colSpan={data.dates.length}></th></tr>
      <tr><th colSpan={8}>Daily payable total</th>{data.dates.map((date) => <th key={date}>{data.summaries.reduce((sum, item) => sum + payableValue(dailyStatus(item.id, date)), 0)}</th>)}</tr></tfoot>
    </table></div>
    <footer className="register-footer"><span><b>P</b> = {t("workforcePage.present")}</span><span><b>1/2</b> = {t("workforcePage.halfDay")}</span><span><b>A</b> = {t("workforcePage.absent")}</span><span><b>-</b> = {t("reports.noRecord")}</span></footer>
  </section>;
}

function ExpenseImportPanel({ token, workspaceId, farmId, seasonId, onClose, onImported }: {
  token: string; workspaceId: string; farmId: string; seasonId: string; onClose: () => void; onImported: () => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [preview, setPreview] = useState<ExpenseImportPreview | null>(null);
  const [categoryMappings, setCategoryMappings] = useState<Record<string, ExpenseImportResolution>>({});
  const [accountMappings, setAccountMappings] = useState<Record<string, ExpenseImportResolution>>({});
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ExpenseImportResult | null>(null);
  const setResolution = (type: "category" | "account", sourceName: string, value: string) => {
    const resolution: ExpenseImportResolution = value === "create" ? { sourceName, action: "create" } : { sourceName, action: "map", targetId: value };
    if (type === "category") setCategoryMappings((current) => ({ ...current, [sourceName]: resolution }));
    else setAccountMappings((current) => ({ ...current, [sourceName]: resolution }));
  };
  const previewFile = async (event: FormEvent) => {
    event.preventDefault();
    if (!file || !navigator.onLine) { setError("Expense CSV import requires internet connection."); return; }
    setBusy(true); setError("");
    try {
      const response = await previewExpenseImport(token, workspaceId, { farmId, seasonId, originalFilename: file.name, csvText: await file.text() });
      setSessionId(response.sessionId); setPreview(response.preview);
      setCategoryMappings({});
      setAccountMappings({});
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : "Unable to preview expense CSV."); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!preview || !sessionId) return;
    setBusy(true); setError("");
    try {
      const response = await confirmExpenseImport(token, workspaceId, {
        importSessionId: sessionId, farmId, seasonId, skipDuplicates,
        categoryMappings: Object.values(categoryMappings), accountMappings: Object.values(accountMappings),
      });
      setResult(response.result); await refreshOperationalData(); await onImported();
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : "Unable to import expenses."); }
    finally { setBusy(false); }
  };
  const unresolved = !preview || preview.summary.missingCategories.some((name) => !categoryMappings[name]) || preview.summary.missingAccounts.some((name) => !accountMappings[name]);
  const readyRows = preview ? Math.max(0, preview.rows.filter((row) => !row.error
    && (row.accountId || accountMappings[row.accountName])
    && (row.subcategoryId || categoryMappings[row.categoryName])).length - preview.summary.duplicateRows) : 0;
  return <div className="worker-dialog-backdrop" role="presentation" onClick={onClose}><section className="attendance-import-dialog expense-import-dialog" role="dialog" aria-modal="true" aria-label="Expense CSV Import" onClick={(event) => event.stopPropagation()}>
    <header className="attendance-report-header"><div><h2>Expense CSV Import</h2><p>Recommended: CSV import. PDF import is best-effort for legacy reports.</p></div><button type="button" onClick={onClose}><X size={19} /></button></header>
    <div className="attendance-import-body">
      {!preview && <form className="worker-action-form" onSubmit={(event) => void previewFile(event)}><label><span>CSV expense report *</span><input accept=".csv,text/csv" required type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label><small>Expected: Voucher, Date, Deduction Account, Category, Description, Amount. Blank legacy descriptions are filled automatically.</small><p className="expense-import-note">PDF extraction can be unreliable. Upload CSV to receive a validated preview before import.</p><footer><button type="button" onClick={onClose}>Cancel</button><button disabled={busy || !file} type="submit">{busy ? "Reading CSV..." : "Preview Import"}</button></footer></form>}
      {preview && !result && <>
        <div className="expense-import-summary"><span>Total rows <b>{preview.summary.totalRows}</b></span><span>Ready <b>{readyRows}</b></span><span>Duplicates <b>{preview.summary.duplicateRows}</b></span><span>Grand total <b>{money(preview.summary.grandTotal)}</b></span></div>
        {!!preview.summary.errors.length && <div className="worker-action-error">{preview.summary.errors.map((item) => <p key={item}>{item}</p>)}</div>}
        {!!preview.summary.missingCategories.length && <section className="expense-import-resolution"><header><h3>Missing Categories</h3><button type="button" onClick={() => setCategoryMappings(Object.fromEntries(preview.summary.missingCategories.map((sourceName) => [sourceName, { sourceName, action: "create" as const }])))}>Create all</button></header>{preview.summary.missingCategories.map((name) => <label key={name}><span>{name}</span><select value={categoryMappings[name]?.action === "create" ? "create" : categoryMappings[name]?.targetId ?? ""} onChange={(event) => setResolution("category", name, event.target.value)}><option value="">Resolve category</option><option value="create">Create category</option>{preview.categories.map((item) => <option key={item.id} value={item.id}>Map to {item.label}</option>)}</select></label>)}</section>}
        {!!preview.summary.missingAccounts.length && <section className="expense-import-resolution"><header><h3>Missing Accounts</h3><button type="button" onClick={() => setAccountMappings(Object.fromEntries(preview.summary.missingAccounts.map((sourceName) => [sourceName, { sourceName, action: "create" as const }])))}>Create all</button></header>{preview.summary.missingAccounts.map((name) => <label key={name}><span>{name}</span><select value={accountMappings[name]?.action === "create" ? "create" : accountMappings[name]?.targetId ?? ""} onChange={(event) => setResolution("account", name, event.target.value)}><option value="">Resolve account</option><option value="create">Create account</option>{preview.accounts.map((item) => <option key={item.id} value={item.id}>Map to {item.name}</option>)}</select></label>)}</section>}
        <label className="attendance-import-warning-confirm"><input checked={skipDuplicates} type="checkbox" onChange={(event) => setSkipDuplicates(event.target.checked)} /> Skip duplicate rows</label>
        <div className="attendance-import-table-wrap"><table><thead><tr><th>Voucher</th><th>Date</th><th>Deduction Account</th><th>Category</th><th>Description</th><th>Amount</th><th>Status</th></tr></thead><tbody>{preview.rows.slice(0, 50).map((row) => {
          const accountResolved = row.accountId || accountMappings[row.accountName];
          const categoryResolved = row.subcategoryId || categoryMappings[row.categoryName];
          const status = row.error ? `Row ${row.rowIndex}: ${row.error}`
            : !accountResolved ? `Row ${row.rowIndex}: Missing account "${row.accountName}"`
              : !categoryResolved ? `Row ${row.rowIndex}: Missing category "${row.categoryName}"`
                : "Ready";
          return <tr key={row.rowIndex}><td>{row.voucherNumber}</td><td>{row.date}</td><td>{row.accountName}</td><td>{row.categoryName}</td><td>{row.description}</td><td>{money(row.amount)}</td><td>{status}</td></tr>;
        })}</tbody></table></div>
        <div className="expense-import-totals"><section><h3>Totals by account</h3>{preview.summary.totalsByAccount.map((item) => <p key={item.name}><span>{item.name}</span><b>{money(item.total)}</b></p>)}</section><section><h3>Totals by category</h3>{preview.summary.totalsByCategory.map((item) => <p key={item.name}><span>{item.name}</span><b>{money(item.total)}</b></p>)}</section></div>
        <footer className="attendance-import-footer"><button type="button" onClick={onClose}>Cancel</button><button disabled={busy || unresolved || preview.summary.errors.length > 0} type="button" onClick={() => void confirm()}>{busy ? "Importing..." : "Import Expenses"}</button></footer>
      </>}
      {result && <section className="expense-import-result"><h3>Expense import completed</h3><p>Expenses imported: <b>{result.recordsCreated}</b></p><p>Duplicates skipped: <b>{result.duplicatesSkipped}</b></p><p>Imported total: <b>{money(result.grandTotal)}</b></p><button type="button" onClick={onClose}>Close</button></section>}
      {error && <p className="worker-action-error">{error}</p>}
    </div>
  </section></div>;
}

function ExpensesModule() {
  const { token, user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const load = useCallback(async () => (await workspaceRecords(offlineDb.vouchers, { includeGeneralFarmRecords: true })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), []);
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
  const [vendor, setVendor] = useState("");
  const [notes, setNotes] = useState("");
  const [selectedVoucher, setSelectedVoucher] = useState<Voucher | null>(null);
  const [editingVoucher, setEditingVoucher] = useState<Voucher | null>(null);
  const [showExpenseImport, setShowExpenseImport] = useState(false);
  const [voucherSearch, setVoucherSearch] = useState("");
  const [debouncedVoucherSearch, setDebouncedVoucherSearch] = useState("");
  const [voucherFrom, setVoucherFrom] = useState("");
  const [voucherTo, setVoucherTo] = useState("");
  const [voucherCategory, setVoucherCategory] = useState("");
  const [voucherSubcategory, setVoucherSubcategory] = useState("");
  const [voucherAccountId, setVoucherAccountId] = useState("");
  const [voucherVendor, setVoucherVendor] = useState("");
  const showToast = (message: string) => window.dispatchEvent(new CustomEvent("muzare-toast", { detail: message }));
  const resetForm = () => {
    setDate(today()); setCategoryId(""); setCategorySearch(""); setSubcategoryId(""); setSubcategorySearch("");
    setDescription(""); setAmount(""); setAccountId(""); setVendor(""); setNotes("");
  };
  const openEdit = (voucher: Voucher) => {
    setSelectedVoucher(null); setEditingVoucher(voucher); setDate(voucher.date); setCategoryId(voucher.categoryId);
    setCategorySearch(voucher.category); setSubcategoryId(voucher.subcategoryId); setSubcategorySearch(voucher.subcategory);
    setDescription(voucher.description); setAmount(String(voucher.amount)); setAccountId(voucher.accountId);
    setVendor(voucher.vendor ?? ""); setNotes(voucher.notes ?? "");
  };
  const nextLocalVoucherNumber = () => {
    const highest = vouchers.reduce((max, item) => {
      const match = /^V-(\d+)$/.exec(item.voucherNumber);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
    return `V-${String(highest + 1).padStart(4, "0")}`;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const category = categories.data?.categories.find((item) => item.id === categoryId);
    const subcategory = category?.subcategories.find((item) => item.id === subcategoryId);
    if (!category || !subcategory) return;
    const record: Voucher = {
      ...(editingVoucher ?? makeLocalRecord()), voucherNumber: editingVoucher?.voucherNumber ?? nextLocalVoucherNumber(), date,
      categoryId: category.id, category: category.name, subcategoryId: subcategory.id, subcategory: subcategory.name,
      description: description.trim(), amount: Number(amount), accountId: accountId || accounts[0]?.id || "",
      vendor: vendor.trim() || undefined, notes: notes.trim() || undefined,
    };
    await persistOperationalRecord("voucher", record);
    showToast(editingVoucher ? "Expense voucher updated successfully." : "Expense voucher saved successfully.");
    setEditingVoucher(null);
    resetForm();
    await refresh();
  };
  const selectedCategory = categories.data?.categories.find((item) => item.id === categoryId);
  const canManage = Boolean(user && workspaceId && hasPermission(user, "MANAGE_EXPENSE_CATEGORIES", workspaceId));
  const canEditVouchers = Boolean(user && workspaceId && hasPermission(user, "MANAGE_RECORDS", workspaceId));
  const farmId = getActiveFarmId();
  const seasonId = getActiveSeasonId();
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedVoucherSearch(voucherSearch.trim()), 275);
    return () => window.clearTimeout(timer);
  }, [voucherSearch]);
  const voucherSearchQuery = useQuery({
    queryKey: ["expense-search", workspaceId, farmId, seasonId, debouncedVoucherSearch, voucherFrom, voucherTo, voucherCategory, voucherSubcategory, voucherAccountId, voucherVendor],
    queryFn: () => searchExpenses(token!, workspaceId, {
      farmId: farmId!, seasonId: seasonId!, search: debouncedVoucherSearch || undefined, from: voucherFrom || undefined, to: voucherTo || undefined,
      category: voucherCategory || undefined, subcategory: voucherSubcategory || undefined, accountId: voucherAccountId || undefined, vendor: voucherVendor.trim() || undefined,
    }),
    enabled: Boolean(token && workspaceId && farmId && seasonId && navigator.onLine),
  });
  const accountById = useMemo(() => new Map(accounts.map((account) => [account.id, account.name])), [accounts]);
  const voucherSubcategories = useMemo(() => categories.data?.categories
    .filter((category) => !voucherCategory || category.name === voucherCategory)
    .flatMap((category) => category.subcategories.map((subcategory) => subcategory.name)) ?? [], [categories.data, voucherCategory]);
  const matchesVoucher = useCallback((item: Voucher) => {
    const accountName = accountById.get(item.accountId)
      ?? ("accountName" in item && typeof item.accountName === "string" ? item.accountName : "");
    const normalizedSearch = voucherSearch.trim().toLowerCase();
    const shortDate = item.date.length >= 10 ? `${item.date.slice(5, 7)}/${item.date.slice(8, 10)}` : item.date;
    return (!voucherFrom || item.date >= voucherFrom)
      && (!voucherTo || item.date <= voucherTo)
      && (!voucherCategory || item.category === voucherCategory)
      && (!voucherSubcategory || item.subcategory === voucherSubcategory)
      && (!voucherAccountId || item.accountId === voucherAccountId)
      && (!voucherVendor.trim() || (item.vendor ?? "").toLowerCase().includes(voucherVendor.trim().toLowerCase()))
      && (!normalizedSearch || [
        item.voucherNumber, item.description, item.notes ?? "", item.category, item.subcategory, accountName,
        item.vendor ?? "", String(item.amount), item.date, shortDate,
      ].some((value) => value.toLowerCase().includes(normalizedSearch)));
  }, [accountById, voucherAccountId, voucherCategory, voucherFrom, voucherSearch, voucherSubcategory, voucherTo, voucherVendor]);
  const filteredVouchers = useMemo(() => {
    const serverRecords = voucherSearchQuery.data?.records ?? [];
    const merged = navigator.onLine && voucherSearchQuery.data
      ? [...serverRecords, ...vouchers.filter((item) => item.pendingSync && !serverRecords.some((server) => server.id === item.id))]
      : vouchers;
    return merged.filter((item) => matchesVoucher(item as Voucher)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) as Voucher[];
  }, [matchesVoucher, voucherSearchQuery.data, vouchers]);
  const total = filteredVouchers.reduce((sum, item) => sum + item.amount, 0);
  const grouped = [...filteredVouchers.reduce((map, item) => {
    const category = map.get(item.category) ?? new Map<string, number>();
    category.set(item.subcategory || "Miscellaneous", (category.get(item.subcategory || "Miscellaneous") ?? 0) + item.amount);
    map.set(item.category, category); return map;
  }, new Map<string, Map<string, number>>())];
  const hasActiveFilters = Boolean(
    voucherSearch.trim()
    || voucherFrom
    || voucherTo
    || voucherCategory
    || voucherSubcategory
    || voucherAccountId
    || voucherVendor.trim(),
  );
  const clearFilters = () => {
    setVoucherSearch("");
    setDebouncedVoucherSearch("");
    setVoucherFrom("");
    setVoucherTo("");
    setVoucherCategory("");
    setVoucherSubcategory("");
    setVoucherAccountId("");
    setVoucherVendor("");
  };
  useEffect(() => {
    const recordId = searchParams.get("recordId");
    if (!recordId) return;
    const voucher = vouchers.find((item) => item.id === recordId);
    if (voucher) setSelectedVoucher(voucher);
  }, [searchParams, vouchers]);
  const removeVoucher = async (voucher: Voucher) => {
    if (!canEditVouchers || !window.confirm(`Delete voucher ${voucher.voucherNumber}? This preserves an audit record and reverses its accounting effect.`)) return;
    await deleteOperationalRecord("voucher", voucher);
    setSelectedVoucher(null);
    setSearchParams((current) => { current.delete("recordId"); return current; });
    showToast("Expense voucher deleted successfully.");
    await refresh();
  };
  const addCustom = async (event: FormEvent) => {
    event.preventDefault();
    if (!token || !workspaceId || !categoryId || !customName.trim()) return;
    await createExpenseSubcategory(token, workspaceId, { categoryId, name: customName.trim() });
    setCustomName(""); await categories.refetch();
  };

  return (
    <>
      <FormCard title={editingVoucher ? `Edit voucher ${editingVoucher.voucherNumber}` : "New expense voucher"}>
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
          <input value={vendor} placeholder="Vendor / person (optional)" onChange={(event) => setVendor(event.target.value)} />
          <input value={notes} placeholder="Notes / reference (optional)" onChange={(event) => setNotes(event.target.value)} />
          <button type="submit">{editingVoucher ? "Update voucher" : "Save voucher"}</button>
          {editingVoucher && <button type="button" onClick={() => { setEditingVoucher(null); resetForm(); }}>Cancel edit</button>}
        </form>
      </FormCard>
      {canEditVouchers && <section className="record-panel expense-import-card"><div><h2>Historical expense import</h2><p>Import validated CSV reports with account and category mapping.</p></div><button type="button" onClick={() => navigator.onLine ? setShowExpenseImport(true) : showToast("Expense CSV import requires internet connection.")}>Import expenses CSV</button></section>}
      <section className="record-panel expense-search-panel">
        <h2>Search vouchers</h2>
        <div className="expense-search-filters">
          <SearchInput placeholder="Search voucher, account, category, amount, or date" value={voucherSearch} onChange={setVoucherSearch} />
          <input aria-label="Expense date from" type="date" value={voucherFrom} onChange={(event) => setVoucherFrom(event.target.value)} />
          <input aria-label="Expense date to" type="date" value={voucherTo} onChange={(event) => setVoucherTo(event.target.value)} />
          <select aria-label="Expense category" value={voucherCategory} onChange={(event) => { setVoucherCategory(event.target.value); setVoucherSubcategory(""); }}>
            <option value="">All categories</option>{categories.data?.categories.map((item) => <option key={item.id}>{item.name}</option>)}
          </select>
          <select aria-label="Expense subcategory" value={voucherSubcategory} onChange={(event) => setVoucherSubcategory(event.target.value)}>
            <option value="">All subcategories</option>{[...new Set(voucherSubcategories)].map((name) => <option key={name}>{name}</option>)}
          </select>
          <select aria-label="Expense payment account" value={voucherAccountId} onChange={(event) => setVoucherAccountId(event.target.value)}>
            <option value="">All accounts</option>{accounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <input aria-label="Expense vendor or person" placeholder="Vendor / person" value={voucherVendor} onChange={(event) => setVoucherVendor(event.target.value)} />
        </div>
        <div className="expense-search-meta">
          <small>{hasActiveFilters ? "Showing totals for current filters" : "Showing totals for current season scope"}</small>
          {hasActiveFilters && <button type="button" onClick={clearFilters}>Clear filters</button>}
        </div>
        {voucherSearchQuery.isFetching && <small>Refreshing matching expenses...</small>}
        {!navigator.onLine && <small>Offline mode: showing cached expenses.</small>}
        {voucherSearchQuery.isError && <small>Unable to refresh expenses from the API. Showing cached expenses.</small>}
      </section>
      <Summary value={money(total)} label={hasActiveFilters ? "Total expenses - current filters" : "Total expenses - current season"} />
      <section className="record-panel"><h2>Expenses by category</h2>{!grouped.length ? <Empty>No expense totals yet.</Empty> : <div className="expense-category-report">{grouped.map(([category, items]) => { const categoryTotal = [...items.values()].reduce((sum, amount) => sum + amount, 0); return <article key={category}><header><h3>{category}</h3><strong>{money(categoryTotal)}</strong></header>{[...items].map(([subcategory, amount]) => <p key={subcategory}><span>{subcategory}</span><strong>{money(amount)}</strong></p>)}<b>Category total <span>{money(categoryTotal)}</span></b></article>; })}</div>}</section>
      {canManage && <section className="record-panel"><h2>Custom subcategories</h2><form className="module-form compact-form" onSubmit={(event) => void addCustom(event)}><select required value={categoryId} onChange={(event) => { setCategoryId(event.target.value); setCategorySearch(categories.data?.categories.find((item) => item.id === event.target.value)?.name ?? ""); }}><option value="">Select category</option>{categories.data?.categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><input required placeholder="New subcategory" value={customName} onChange={(event) => setCustomName(event.target.value)} /><button type="submit">Add subcategory</button></form><div className="custom-subcategory-list">{categories.data?.categories.flatMap((item) => item.subcategories.filter((subcategory) => !subcategory.isSystem).map((subcategory) => <span key={subcategory.id}>{item.name} / {subcategory.name}<button type="button" onClick={() => { const name = window.prompt("Rename custom subcategory", subcategory.name); if (token && name?.trim()) void updateExpenseSubcategory(token, workspaceId, subcategory.id, { name: name.trim() }).then(() => categories.refetch()); }}>Rename</button><button type="button" onClick={() => token && void updateExpenseSubcategory(token, workspaceId, subcategory.id, { active: false }).then(() => categories.refetch())}>Disable</button></span>))}</div></section>}
      <RecordTable
        empty="No expenses found for this search."
        rows={filteredVouchers.map((item) => [item.voucherNumber, item.date, `${item.category} / ${item.subcategory || "Miscellaneous"}`, item.description, accountById.get(item.accountId) ?? "Unknown account", money(item.amount)])}
        actions={filteredVouchers.map((item) => <div className="record-list__actions" key={item.id}><button type="button" onClick={() => setSelectedVoucher(item)}>View details</button>{canEditVouchers && <button type="button" onClick={() => openEdit(item)}>Edit</button>}</div>)}
      />
      {selectedVoucher && <div className="worker-dialog-backdrop" role="presentation" onClick={() => setSelectedVoucher(null)}>
        <section className="worker-dialog" role="dialog" aria-modal="true" aria-label="Expense voucher details" onClick={(event) => event.stopPropagation()}>
          <header className="worker-dialog__header"><h2>Voucher {selectedVoucher.voucherNumber}</h2><button type="button" onClick={() => setSelectedVoucher(null)}><X size={18} /></button></header>
          <div className="worker-dialog__body"><dl className="worker-stats">
            <div><dt>Date</dt><dd>{selectedVoucher.date}</dd></div><div><dt>Category</dt><dd>{selectedVoucher.category} / {selectedVoucher.subcategory}</dd></div>
            <div><dt>Description</dt><dd>{selectedVoucher.description}</dd></div><div><dt>Amount</dt><dd>{money(selectedVoucher.amount)}</dd></div>
            <div><dt>Payment source</dt><dd>{accounts.find((item) => item.id === selectedVoucher.accountId)?.name ?? "Unknown account"}</dd></div>
            {selectedVoucher.vendor && <div><dt>Vendor / person</dt><dd>{selectedVoucher.vendor}</dd></div>}
            {selectedVoucher.notes && <div><dt>Notes / reference</dt><dd>{selectedVoucher.notes}</dd></div>}
          </dl></div>
          <footer className="worker-dialog__footer">{canEditVouchers && <button className="worker-dialog__link" type="button" onClick={() => openEdit(selectedVoucher)}>Edit voucher</button>}{canEditVouchers && <button className="worker-dialog__link worker-dialog__link--danger" type="button" onClick={() => void removeVoucher(selectedVoucher)}>Delete voucher</button>}<button className="worker-dialog__close" type="button" onClick={() => setSelectedVoucher(null)}>Close</button></footer>
        </section>
      </div>}
      {showExpenseImport && token && farmId && seasonId && <ExpenseImportPanel token={token} workspaceId={workspaceId} farmId={farmId} seasonId={seasonId} onClose={() => setShowExpenseImport(false)} onImported={async () => { await refresh(); await categories.refetch(); }} />}
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
  const [searchParams] = useSearchParams();
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
  const [selectedSale, setSelectedSale] = useState<Sale | null>(null);
  useEffect(() => {
    const recordId = searchParams.get("recordId");
    if (recordId) setSelectedSale(sales.find((sale) => sale.id === recordId) ?? null);
  }, [sales, searchParams]);

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
      <RecordTable empty="No sales recorded yet." rows={sales.map((item) => [item.date, item.buyerName, item.produceType, `${item.quantity} x ${money(item.unitPrice)}`, money(item.amount)])} actions={sales.map((item) => <button key={item.id} type="button" onClick={() => setSelectedSale(item)}>View</button>)} />
      {selectedSale && <div className="worker-dialog-backdrop" role="presentation" onClick={() => setSelectedSale(null)}><section className="worker-dialog" role="dialog" aria-modal="true" aria-label="Sale details" onClick={(event) => event.stopPropagation()}><header className="worker-dialog__header"><h2>Sale Details</h2><button type="button" onClick={() => setSelectedSale(null)}><X size={18} /></button></header><div className="worker-dialog__body"><dl className="worker-stats"><div><dt>Date</dt><dd>{selectedSale.date}</dd></div><div><dt>Buyer</dt><dd>{selectedSale.buyerName}</dd></div><div><dt>Produce</dt><dd>{selectedSale.produceType}</dd></div><div><dt>Amount</dt><dd>{money(selectedSale.amount)}</dd></div></dl></div></section></div>}
    </>
  );
}

const partnerEntryLabel = (entry: PartnerEntry) => entry.type === "contribution" ? "Capital Contribution" : entry.type === "withdrawal" ? "Partner Withdrawal" : "Partner Settlement";
const partnerEntryName = (entry: PartnerEntry) => entry.type === "settlement" ? `${entry.fromPartner} to ${entry.toPartner}` : entry.partnerName ?? "-";
const partnerEntryBalanceEffect = (entry: PartnerEntry) => entry.type === "contribution" ? entry.amount : entry.type === "withdrawal" ? -entry.amount : 0;

function PartnerLedgerModule() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const canManage = Boolean(user?.workspaceId && hasPermission(user, "MANAGE_RECORDS", user.workspaceId));
  const [showDeleted, setShowDeleted] = useState(false);
  const load = useCallback(async () => (await workspaceRecords(offlineDb.partnerEntries, { includeDeleted: showDeleted })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [showDeleted]);
  const loadAccounts = useCallback(() => workspaceRecords(offlineDb.accounts), []);
  const loadAdvances = useCallback(() => workspaceRecords(offlineDb.advances), []);
  const loadVouchers = useCallback(() => workspaceRecords(offlineDb.vouchers, { includeGeneralFarmRecords: true }), []);
  const [entries, refresh] = useData(load);
  const [accounts] = useData(loadAccounts, ensureLocalAccounts);
  const [advances] = useData(loadAdvances);
  const [vouchers] = useData(loadVouchers);
  const [date, setDate] = useState(today());
  const [partnerName, setPartnerName] = useState("");
  const [fromPartner, setFromPartner] = useState("");
  const [toPartner, setToPartner] = useState("");
  const [fromAccountId, setFromAccountId] = useState("");
  const [toAccountId, setToAccountId] = useState("");
  const [type, setType] = useState<PartnerEntry["type"]>("contribution");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [accountId, setAccountId] = useState("");
  const [editing, setEditing] = useState<PartnerEntry | null>(null);
  const [viewing, setViewing] = useState<PartnerEntry | null>(null);
  const [deleting, setDeleting] = useState<PartnerEntry | null>(null);
  const [deletionReason, setDeletionReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [entryFilter, setEntryFilter] = useState<"all" | PartnerEntry["type"]>("all");
  useEffect(() => {
    const recordId = searchParams.get("recordId");
    if (recordId) setViewing(entries.find((entry) => entry.id === recordId) ?? null);
  }, [entries, searchParams]);

  const resetForm = () => {
    setEditing(null); setDate(today()); setPartnerName(""); setFromPartner(""); setToPartner(""); setFromAccountId(""); setToAccountId(""); setType("contribution"); setAmount(""); setNotes(""); setAccountId(""); setError("");
  };

  const edit = (entry: PartnerEntry) => {
    setEditing(entry); setDate(entry.date); setPartnerName(entry.partnerName ?? ""); setType(entry.type);
    setFromPartner(entry.fromPartner ?? ""); setToPartner(entry.toPartner ?? "");
    setFromAccountId(entry.fromAccountId ?? ""); setToAccountId(entry.toAccountId ?? "");
    setAmount(String(entry.amount)); setNotes(entry.notes); setAccountId(entry.accountId ?? ""); setError("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const settlement = type === "settlement";
    if (!date || Number(amount) <= 0 || (!settlement && (!accountId || !partnerName.trim()))
      || (settlement && (!fromAccountId || !toAccountId || fromAccountId === toAccountId))) {
      return setError(settlement ? "Date, different payer and receiver accounts, and a positive amount are required." : "Date, partner, type, positive amount, and account are required.");
    }
    setSaving(true); setError("");
    try {
      const fields = settlement
        ? {
            date, type, amount: Number(amount), notes, fromAccountId, toAccountId,
            fromPartner: accounts.find((account) => account.id === fromAccountId)?.name ?? fromPartner.trim(),
            toPartner: accounts.find((account) => account.id === toAccountId)?.name ?? toPartner.trim(),
            partnerName: undefined, accountId: undefined,
          }
        : { date, type, amount: Number(amount), notes, partnerName: partnerName.trim(), accountId, fromPartner: undefined, toPartner: undefined };
      const record: PartnerEntry = editing
        ? { ...editing, ...fields }
        : { ...makeLocalRecord(), ...fields };
      await persistOperationalRecord("partnerEntry", record);
      resetForm();
      window.dispatchEvent(new CustomEvent("muzare-toast", { detail: editing ? "Partner ledger entry updated successfully." : "Partner ledger entry saved successfully." }));
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to save partner ledger entry.");
    } finally {
      setSaving(false);
    }
  };
  const confirmDelete = async () => {
    if (!deleting) return;
    setSaving(true); setError("");
    try {
      await deleteOperationalRecord("partnerEntry", { ...deleting, deletionReason });
      window.dispatchEvent(new CustomEvent("muzare-toast", { detail: "Partner ledger entry deleted successfully." }));
      setDeleting(null); setDeletionReason("");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to delete partner ledger entry.");
    } finally {
      setSaving(false);
    }
  };
  const visibleEntries = entries.filter((item) => (showDeleted || !item.deletedAt) && (entryFilter === "all" || item.type === entryFilter));
  const activeEntries = entries.filter((item) => !item.deletedAt);
  const balance = activeEntries.reduce((sum, item) => sum + partnerEntryBalanceEffect(item), 0);
  const accountName = (id?: string) => id ? accounts.find((account) => account.id === id)?.name ?? "Unknown account" : "-";
  const partnerPositions = (() => {
    const positions = new Map<string, {
      name: string;
      voucherExpensesPaid: number;
      labourAdvancesPaid: number;
      contributions: number;
      withdrawals: number;
      settlementsSent: number;
      settlementsReceived: number;
    }>();
    const position = (name: string) => {
      const key = name.trim().toLowerCase();
      const current = positions.get(key) ?? {
        name: name.trim(),
        voucherExpensesPaid: 0,
        labourAdvancesPaid: 0,
        contributions: 0,
        withdrawals: 0,
        settlementsSent: 0,
        settlementsReceived: 0,
      };
      positions.set(key, current);
      return current;
    };
    for (const entry of activeEntries) {
      if (entry.type === "settlement") {
        if (!entry.fromAccountId || !entry.toAccountId) continue;
        const fromName = accounts.find((account) => account.id === entry.fromAccountId)?.name ?? entry.fromPartner!;
        const toName = accounts.find((account) => account.id === entry.toAccountId)?.name ?? entry.toPartner!;
        position(fromName).settlementsSent += entry.amount;
        position(toName).settlementsReceived += entry.amount;
      } else if (entry.type === "contribution") position(entry.partnerName!).contributions += entry.amount;
      else position(entry.partnerName!).withdrawals += entry.amount;
    }
    for (const voucher of vouchers) {
      const account = accounts.find((item) => item.id === voucher.accountId);
      if (account?.name) position(account.name).voucherExpensesPaid += voucher.amount;
    }
    for (const advance of advances) {
      const accountName = accounts.find((item) => item.id === advance.accountId)?.name ?? advance.sourceAccountName;
      if (accountName?.trim()) position(accountName).labourAdvancesPaid += advance.amount;
    }
    return [...positions.values()].map((item) => ({
      ...item,
      totalPaid: item.voucherExpensesPaid + item.labourAdvancesPaid,
      netPosition: -item.voucherExpensesPaid
        - item.labourAdvancesPaid
        + item.contributions
        - item.withdrawals
        - item.settlementsSent
        + item.settlementsReceived,
    })).sort((a, b) => a.name.localeCompare(b.name));
  })();
  const runningBalances = (() => {
    const balances = new Map<string, { name: string; amount: number }>();
    const labels = new Map<string, string>();
    const adjust = (name: string, amount: number) => {
      const key = name.trim().toLowerCase();
      const current = balances.get(key) ?? { name: name.trim(), amount: 0 };
      balances.set(key, { ...current, amount: current.amount + amount });
    };
    for (const entry of [...activeEntries].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt))) {
      if (entry.type === "settlement") {
        if (!entry.fromAccountId || !entry.toAccountId) {
          labels.set(entry.id, "Unresolved settlement account mapping"); continue;
        }
        adjust(entry.fromPartner!, -entry.amount); adjust(entry.toPartner!, entry.amount);
        labels.set(entry.id, `${entry.fromPartner}: ${money(balances.get(entry.fromPartner!.trim().toLowerCase())!.amount)} | ${entry.toPartner}: ${money(balances.get(entry.toPartner!.trim().toLowerCase())!.amount)}`);
      } else {
        adjust(entry.partnerName!, partnerEntryBalanceEffect(entry));
        labels.set(entry.id, `${entry.partnerName}: ${money(balances.get(entry.partnerName!.trim().toLowerCase())!.amount)}`);
      }
    }
    return labels;
  })();

  return (
    <>
      <FormCard title={editing ? "Edit partner entry" : "Record partner entry"}>
        <form className="module-form inline-form" onSubmit={(event) => void submit(event)}>
          <input required type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          <select value={type} onChange={(event) => setType(event.target.value as PartnerEntry["type"])}>
            <option value="contribution">Capital Contribution</option>
            <option value="withdrawal">Partner Withdrawal</option>
            <option value="settlement">Partner Settlement</option>
          </select>
          {type === "settlement" ? <>
            <select required value={fromAccountId} onChange={(event) => setFromAccountId(event.target.value)}><option value="">From partner account</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select>
            <select required value={toAccountId} onChange={(event) => setToAccountId(event.target.value)}><option value="">To partner account</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select>
          </> : <input required placeholder="Partner name" value={partnerName} onChange={(event) => setPartnerName(event.target.value)} />}
          <input required type="number" min="0.01" step="0.01" placeholder="Amount" value={amount} onChange={(event) => setAmount(event.target.value)} />
          <input placeholder="Notes" value={notes} onChange={(event) => setNotes(event.target.value)} />
          {type !== "settlement" && <select required value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            <option value="">Select cash/bank account</option>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select>}
          <button className="partner-ledger-submit" disabled={saving} type="submit">{saving ? "Saving..." : editing ? "Update entry" : "Save entry"}</button>
          {editing && <button className="secondary-button" disabled={saving} type="button" onClick={resetForm}>Cancel edit</button>}
        </form>
        {error && <p className="worker-action-error">{error}</p>}
      </FormCard>
      <Summary label="Partner balance" value={money(balance)} />
      {activeEntries.some((entry) => entry.type === "settlement" && (!entry.fromAccountId || !entry.toAccountId)) && <p className="worker-action-error">Some historical settlements need account mapping repair. Edit each unresolved settlement and select its payer and receiver accounts.</p>}
      <section className="record-panel">
        <h2>Partner Position</h2>
        {!partnerPositions.length ? <Empty>No partner positions recorded yet.</Empty> : <div className="partner-position-table">
          <div className="partner-position-row partner-position-row--header"><span>Partner</span><span>Voucher expenses paid</span><span>Labour advances paid</span><span>Total paid</span><span>Contributions</span><span>Withdrawals</span><span>Sent</span><span>Received</span><span>Net position</span></div>
          {partnerPositions.map((item) => <div className="partner-position-row" key={item.name}>
            <strong>{item.name}</strong><span>{money(item.voucherExpensesPaid)}</span><span>{money(item.labourAdvancesPaid)}</span><span>{money(item.totalPaid)}</span><span>{money(item.contributions)}</span><span>{money(item.withdrawals)}</span><span>{money(item.settlementsSent)}</span><span>{money(item.settlementsReceived)}</span><b>{money(item.netPosition)}</b>
          </div>)}
        </div>}
        {!!partnerPositions.length && <div className="partner-position-cards">
          {partnerPositions.map((item) => <article key={`mobile-${item.name}`}>
            <header><strong>{item.name}</strong><b>{money(item.netPosition)}</b></header>
            <div><span>Voucher expenses</span><strong>{money(item.voucherExpensesPaid)}</strong></div>
            <div><span>Labour advances</span><strong>{money(item.labourAdvancesPaid)}</strong></div>
            <div><span>Total paid</span><strong>{money(item.totalPaid)}</strong></div>
            <div><span>Contributions</span><strong>{money(item.contributions)}</strong></div>
            <div><span>Withdrawals</span><strong>{money(item.withdrawals)}</strong></div>
            <div><span>Settlements sent</span><strong>{money(item.settlementsSent)}</strong></div>
            <div><span>Settlements received</span><strong>{money(item.settlementsReceived)}</strong></div>
          </article>)}
        </div>}
      </section>
      <label className="partner-ledger-filter"><span>Ledger filter</span><select value={entryFilter} onChange={(event) => setEntryFilter(event.target.value as typeof entryFilter)}>
        <option value="all">All</option><option value="contribution">Contributions</option><option value="withdrawal">Withdrawals</option><option value="settlement">Settlements</option>
      </select></label>
      {canManage && <label className="partner-ledger-show-deleted"><input checked={showDeleted} type="checkbox" onChange={(event) => setShowDeleted(event.target.checked)} /> Show deleted</label>}
      <RecordTable
        empty="No partner entries recorded yet."
        rows={visibleEntries.map((item) => [item.date, partnerEntryName(item), partnerEntryLabel(item), accountName(item.accountId), item.notes || "-", money(item.type === "withdrawal" ? -item.amount : item.amount), item.deletedAt ? "Deleted" : runningBalances.get(item.id) ?? "-"])}
        actions={visibleEntries.map((item) => (
          <div className="record-list__actions" key={`actions-${item.id}`}>
            <button type="button" onClick={() => setViewing(item)}>View</button>
            {canManage && !item.deletedAt && <button type="button" onClick={() => edit(item)}>Edit</button>}
            {canManage && !item.deletedAt && <button className="danger-button" type="button" onClick={() => { setDeleting(item); setDeletionReason(""); }}>Delete</button>}
          </div>
        ))}
      />
      {viewing && (
        <div className="worker-dialog-backdrop worker-action-backdrop">
          <section className="worker-action-dialog">
            <header><h2>Partner ledger entry</h2><button aria-label="Close" type="button" onClick={() => setViewing(null)}><X size={19} /></button></header>
            <div className="worker-action-form partner-ledger-details">
              <p><strong>Date</strong><span>{viewing.date}</span></p><p><strong>Partner</strong><span>{partnerEntryName(viewing)}</span></p>
              <p><strong>Type</strong><span>{partnerEntryLabel(viewing)}</span></p>{viewing.type !== "settlement" && <p><strong>Account</strong><span>{accountName(viewing.accountId)}</span></p>}
              <p><strong>Amount</strong><span>{money(viewing.amount)}</span></p><p><strong>Notes</strong><span>{viewing.notes || "-"}</span></p>
              {viewing.deletedAt && <p><strong>Deleted</strong><span>{new Date(viewing.deletedAt).toLocaleString()}</span></p>}
              <footer><button type="button" onClick={() => setViewing(null)}>Close</button></footer>
            </div>
          </section>
        </div>
      )}
      {deleting && (
        <div className="worker-dialog-backdrop worker-action-backdrop">
          <section className="worker-action-dialog">
            <header><h2>Delete partner ledger entry</h2><button aria-label="Close" type="button" onClick={() => setDeleting(null)}><X size={19} /></button></header>
            <div className="worker-action-form">
              <p className="worker-action-warning">This soft delete reverses the ledger effect while preserving the audit history.</p>
              <p>{deleting.date} | {partnerEntryName(deleting)} | {partnerEntryLabel(deleting)} | {accountName(deleting.accountId)} | {money(deleting.amount)}</p>
              <label><span>Deletion reason</span><textarea value={deletionReason} onChange={(event) => setDeletionReason(event.target.value)} /></label>
              {error && <p className="worker-action-error">{error}</p>}
              <footer><button disabled={saving} type="button" onClick={() => setDeleting(null)}>Cancel</button><button className="danger-button" disabled={saving} type="button" onClick={() => void confirmDelete()}>{saving ? "Deleting..." : "Delete entry"}</button></footer>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function AccountsModule() {
  const navigate = useNavigate();
  const loadAccounts = useCallback(async () => (await workspaceRecords(offlineDb.accounts)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)), []);
  const loadVouchers = useCallback(() => workspaceRecords(offlineDb.vouchers, { includeGeneralFarmRecords: true }), []);
  const loadSales = useCallback(() => workspaceRecords(offlineDb.sales), []);
  const loadEntries = useCallback(() => workspaceRecords(offlineDb.partnerEntries), []);
  const loadAdvances = useCallback(() => workspaceRecords(offlineDb.advances), []);
  const [accounts, refresh] = useData(loadAccounts, ensureLocalAccounts);
  const [vouchers] = useData(loadVouchers);
  const [sales] = useData(loadSales);
  const [entries] = useData(loadEntries);
  const [advances] = useData(loadAdvances);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [ledgerSearch, setLedgerSearch] = useState("");
  const [ledgerType, setLedgerType] = useState<"all" | "sale" | "voucher" | "advance" | "settlement_sent" | "settlement_received" | "contribution" | "withdrawal">("all");
  const [ledgerFrom, setLedgerFrom] = useState("");
  const [ledgerTo, setLedgerTo] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<Account["type"]>("bank");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const record: Account = { ...makeLocalRecord(), name, type };
    await persistOperationalRecord("account", record);
    setName("");
    await refresh();
  };
  const balance = (account: Account) => calculateAccountBalance(account, sales, vouchers, advances, entries);
  const totalAdvances = advances.reduce((sum, item) => sum + item.amount, 0);
  const totalVoucherExpenses = vouchers.reduce((sum, item) => sum + item.amount, 0);
  const selectedAccount = selectedAccountId ? accounts.find((item) => item.id === selectedAccountId) ?? null : null;
  const ledgerRows = useMemo(() => {
    if (!selectedAccount) return [];
    type LedgerRow = {
      id: string;
      date: string;
      type: "sale" | "voucher" | "advance" | "settlement_sent" | "settlement_received" | "contribution" | "withdrawal";
      reference: string;
      description: string;
      debit: number;
      credit: number;
      source: "sales" | "expenses" | "labour_advances" | "partner_ledger";
      sourceId: string;
      counterparty?: string;
      runningBalance?: number;
    };
    const rows: LedgerRow[] = [];
    for (const sale of sales.filter((item) => item.accountId === selectedAccount.id)) {
      rows.push({
        id: `sale:${sale.id}`,
        date: sale.date,
        type: "sale",
        reference: sale.id.slice(0, 8),
        description: `${sale.buyerName} - ${sale.produceType}`,
        debit: 0,
        credit: sale.amount,
        source: "sales",
        sourceId: sale.id,
      });
    }
    for (const voucher of vouchers.filter((item) => item.accountId === selectedAccount.id)) {
      rows.push({
        id: `voucher:${voucher.id}`,
        date: voucher.date,
        type: "voucher",
        reference: voucher.voucherNumber,
        description: `${voucher.category} / ${voucher.subcategory} - ${voucher.description}`,
        debit: voucher.amount,
        credit: 0,
        source: "expenses",
        sourceId: voucher.id,
      });
    }
    for (const advance of advances.filter((item) => item.accountId === selectedAccount.id)) {
      rows.push({
        id: `advance:${advance.id}`,
        date: advance.date,
        type: "advance",
        reference: advance.id.slice(0, 8),
        description: `Labour advance${advance.notes ? ` - ${advance.notes}` : ""}`,
        debit: advance.amount,
        credit: 0,
        source: "labour_advances",
        sourceId: advance.id,
      });
    }
    for (const entry of entries.filter((item) => !item.deletedAt)) {
      if (entry.type === "contribution" && entry.accountId === selectedAccount.id) {
        rows.push({
          id: `partner:${entry.id}`,
          date: entry.date,
          type: "contribution",
          reference: entry.id.slice(0, 8),
          description: entry.notes || "Capital contribution",
          debit: 0,
          credit: entry.amount,
          source: "partner_ledger",
          sourceId: entry.id,
          counterparty: entry.partnerName,
        });
      }
      if (entry.type === "withdrawal" && entry.accountId === selectedAccount.id) {
        rows.push({
          id: `partner:${entry.id}`,
          date: entry.date,
          type: "withdrawal",
          reference: entry.id.slice(0, 8),
          description: entry.notes || "Partner withdrawal",
          debit: entry.amount,
          credit: 0,
          source: "partner_ledger",
          sourceId: entry.id,
          counterparty: entry.partnerName,
        });
      }
      if (entry.type === "settlement") {
        if (entry.fromAccountId === selectedAccount.id) {
          rows.push({
            id: `partner:${entry.id}:sent`,
            date: entry.date,
            type: "settlement_sent",
            reference: entry.id.slice(0, 8),
            description: entry.notes || "Partner settlement sent",
            debit: entry.amount,
            credit: 0,
            source: "partner_ledger",
            sourceId: entry.id,
            counterparty: entry.toPartner,
          });
        }
        if (entry.toAccountId === selectedAccount.id) {
          rows.push({
            id: `partner:${entry.id}:received`,
            date: entry.date,
            type: "settlement_received",
            reference: entry.id.slice(0, 8),
            description: entry.notes || "Partner settlement received",
            debit: 0,
            credit: entry.amount,
            source: "partner_ledger",
            sourceId: entry.id,
            counterparty: entry.fromPartner,
          });
        }
      }
    }
    rows.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    let running = 0;
    return rows.map((row) => {
      running += row.credit - row.debit;
      return { ...row, runningBalance: running };
    });
  }, [advances, entries, sales, selectedAccount, vouchers]);
  const filteredLedgerRows = useMemo(() => {
    const term = ledgerSearch.trim().toLowerCase();
    return ledgerRows.filter((row) => (ledgerType === "all" || row.type === ledgerType)
      && (!ledgerFrom || row.date >= ledgerFrom)
      && (!ledgerTo || row.date <= ledgerTo)
      && (!term || [
        row.reference,
        row.description,
        row.counterparty ?? "",
        row.date,
        String(row.debit),
        String(row.credit),
      ].some((value) => value.toLowerCase().includes(term))));
  }, [ledgerFrom, ledgerRows, ledgerSearch, ledgerTo, ledgerType]);
  const ledgerBreakdown = useMemo(() => {
    const byType = {
      salesReceived: 0, voucherExpensesPaid: 0, labourAdvancesPaid: 0,
      settlementsSent: 0, settlementsReceived: 0, contributions: 0, withdrawals: 0,
    };
    for (const row of filteredLedgerRows) {
      if (row.type === "sale") byType.salesReceived += row.credit;
      if (row.type === "voucher") byType.voucherExpensesPaid += row.debit;
      if (row.type === "advance") byType.labourAdvancesPaid += row.debit;
      if (row.type === "settlement_sent") byType.settlementsSent += row.debit;
      if (row.type === "settlement_received") byType.settlementsReceived += row.credit;
      if (row.type === "contribution") byType.contributions += row.credit;
      if (row.type === "withdrawal") byType.withdrawals += row.debit;
    }
    return {
      ...byType,
      netBalance: byType.salesReceived - byType.voucherExpensesPaid - byType.labourAdvancesPaid + byType.contributions - byType.withdrawals - byType.settlementsSent + byType.settlementsReceived,
    };
  }, [filteredLedgerRows]);
  const openSource = (row: (typeof filteredLedgerRows)[number]) => {
    const farmId = getActiveFarmId();
    const seasonId = getActiveSeasonId();
    const query = new URLSearchParams();
    if (farmId) query.set("farmId", farmId);
    if (seasonId) query.set("seasonId", seasonId);
    if (row.sourceId) query.set("recordId", row.sourceId);
    if (row.source === "expenses") navigate(`/workspace/expenses?${query.toString()}`);
    if (row.source === "sales") navigate(`/workspace/sales?${query.toString()}`);
    if (row.source === "labour_advances") navigate(`/workspace/labour-advances?${query.toString()}`);
    if (row.source === "partner_ledger") navigate(`/workspace/partner-ledger?${query.toString()}`);
  };
  const openExpenseVisibility = (scope: "voucher" | "advance" | "combined") => {
    const farmId = getActiveFarmId();
    const seasonId = getActiveSeasonId();
    const query = new URLSearchParams();
    if (farmId) query.set("farmId", farmId);
    if (seasonId) query.set("seasonId", seasonId);
    if (scope === "voucher") {
      query.set("expenseScope", "vouchers");
      navigate(`/workspace/expenses?${query.toString()}`);
      return;
    }
    if (scope === "advance") {
      query.set("expenseScope", "advances");
      navigate(`/workspace/labour-advances?${query.toString()}`);
      return;
    }
    query.set("report", "combined-expenses");
    navigate(`/workspace/reports?${query.toString()}`);
  };

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
            <article key={account.id} className="account-card-clickable" role="button" tabIndex={0} onClick={() => setSelectedAccountId(account.id)} onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setSelectedAccountId(account.id);
              }
            }}>
              <span>{account.type}</span>
              <strong>{account.name}</strong>
              <b>{money(balance(account))}</b>
              <small>View details</small>
            </article>
          ))}
        </div>
      </section>
      <section className="record-panel">
        <h2>Expense visibility</h2>
        <div className="record-list">
          <article className="account-card-clickable" role="button" tabIndex={0} onClick={() => openExpenseVisibility("voucher")}><strong>Voucher expenses</strong><span>{money(totalVoucherExpenses)}</span><small>View details</small></article>
          <article className="account-card-clickable" role="button" tabIndex={0} onClick={() => openExpenseVisibility("advance")}><strong>Labour advances</strong><span>{money(totalAdvances)}</span><small>View details</small></article>
          <article className="account-card-clickable" role="button" tabIndex={0} onClick={() => openExpenseVisibility("combined")}><strong>Total business expenses</strong><span>{money(totalVoucherExpenses + totalAdvances)}</span><small>View details</small></article>
        </div>
      </section>
      <Summary
        label="Net operating position"
        value={money(sales.reduce((sum, item) => sum + item.amount, 0) - totalVoucherExpenses - totalAdvances)}
      />
      {selectedAccount && <div className="worker-dialog-backdrop worker-action-backdrop" role="presentation" onClick={() => setSelectedAccountId(null)}>
        <section className="worker-action-dialog account-ledger-dialog" role="dialog" aria-modal="true" aria-label="Account ledger details" onClick={(event) => event.stopPropagation()}>
          <header><h2>{selectedAccount.name} Ledger</h2><button aria-label="Close" type="button" onClick={() => setSelectedAccountId(null)}><X size={19} /></button></header>
          <div className="worker-action-form">
            <div className="account-ledger-breakdown">
              <article><strong>Voucher expenses paid</strong><span>{money(ledgerBreakdown.voucherExpensesPaid)}</span></article>
              <article><strong>Sales received</strong><span>{money(ledgerBreakdown.salesReceived)}</span></article>
              <article><strong>Labour advances paid</strong><span>{money(ledgerBreakdown.labourAdvancesPaid)}</span></article>
              <article><strong>Partner settlements sent</strong><span>{money(ledgerBreakdown.settlementsSent)}</span></article>
              <article><strong>Partner settlements received</strong><span>{money(ledgerBreakdown.settlementsReceived)}</span></article>
              <article><strong>Contributions</strong><span>{money(ledgerBreakdown.contributions)}</span></article>
              <article><strong>Withdrawals</strong><span>{money(ledgerBreakdown.withdrawals)}</span></article>
              <article><strong>Net balance</strong><b>{money(ledgerBreakdown.netBalance)}</b></article>
            </div>
            <div className="account-ledger-filters">
              <SearchInput placeholder="Search voucher/reference, description, amount, or counterparty" value={ledgerSearch} onChange={setLedgerSearch} />
              <select value={ledgerType} onChange={(event) => setLedgerType(event.target.value as typeof ledgerType)}>
                <option value="all">All types</option>
                <option value="sale">Sale credit</option>
                <option value="voucher">Voucher expense</option>
                <option value="advance">Labour advance</option>
                <option value="settlement_sent">Settlement sent</option>
                <option value="settlement_received">Settlement received</option>
                <option value="contribution">Contribution</option>
                <option value="withdrawal">Withdrawal</option>
              </select>
              <input aria-label="Ledger from date" type="date" value={ledgerFrom} onChange={(event) => setLedgerFrom(event.target.value)} />
              <input aria-label="Ledger to date" type="date" value={ledgerTo} onChange={(event) => setLedgerTo(event.target.value)} />
            </div>
            <div className="attendance-import-table-wrap">
              <table>
                <thead><tr><th>Date</th><th>Type</th><th>Reference</th><th>Description</th><th>Debit</th><th>Credit</th><th>Running Balance</th><th>Source</th></tr></thead>
                <tbody>
                  {filteredLedgerRows.map((row) => <tr key={row.id}>
                    <td>{row.date}</td>
                    <td>{row.type.replace("_", " ")}</td>
                    <td>{row.reference}</td>
                    <td>{row.description}{row.counterparty ? ` (${row.counterparty})` : ""}</td>
                    <td>{row.debit ? money(row.debit) : "-"}</td>
                    <td>{row.credit ? money(row.credit) : "-"}</td>
                    <td>{money(row.runningBalance ?? 0)}</td>
                    <td><button type="button" onClick={() => openSource(row)}>Open</button></td>
                  </tr>)}
                </tbody>
              </table>
            </div>
            <footer><button type="button" onClick={() => setSelectedAccountId(null)}>Back</button></footer>
          </div>
        </section>
      </div>}
    </>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return <section className="summary-card"><span>{label}</span><strong>{value}</strong></section>;
}

function RecordTable({ empty, rows, actions }: { empty: string; rows: string[][]; actions?: ReactNode[] }) {
  return (
    <section className="record-panel">
      <h2>Recent records</h2>
      {!rows.length ? <Empty>{empty}</Empty> : (
        <div className="record-list">
          {rows.map((row, index) => <article key={`${row[0]}-${index}`}>{row.map((cell, item) => item === 0 ? <strong key={cell}>{cell}</strong> : <span key={`${cell}-${item}`}>{cell}</span>)}{actions?.[index]}</article>)}
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
  partnerLedger: "Partner contributions, withdrawals, settlements, and running balances.",
};

export function ModulePage({
  module,
  workforceMode = "register",
  onAttendanceClose,
}: {
  module: ModuleKey;
  workforceMode?: "register" | "attendance";
  onAttendanceClose?: () => void;
}) {
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
        {module === "workforce" && <WorkforceModule openAttendanceOnLoad={workforceMode === "attendance"} onAttendanceClose={onAttendanceClose} />}
        {module === "expenses" && <ExpensesModule />}
        {module === "dispatch" && <DispatchModule />}
        {module === "sales" && <SalesModule />}
        {module === "accounts" && <AccountsModule />}
        {module === "partnerLedger" && <PartnerLedgerModule />}
      </main>
    </div>
  );
}
