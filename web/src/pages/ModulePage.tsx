import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { CalendarDays, Camera, ChevronDown, ChevronRight, Eye, FileText, ImageIcon, MoreVertical, Paperclip, Pencil, RotateCw, Search, Trash2, UploadCloud, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { SubpageHeader } from "../components/SubpageHeader";
import { SearchInput } from "../components/SearchInput";
import { LabourSelectCombobox } from "../components/LabourSelectCombobox";
import { ClearableSelect } from "../components/ClearableSelect";
import { useAuth } from "../auth/AuthProvider";
import { useSyncState } from "../hooks/useSyncState";
import { calculateAccountBalance } from "../lib/accounting";
import { defaultTransactionGroupExpansion, groupAccountTransactions, type AccountTransactionGroupKey } from "../lib/accountTransactionGroups";
import { attendanceStatusKey, buildAttendanceStatusMap, previousLocalDateKey, todayLocalDateKey } from "../lib/attendanceStatus";
import { ApiError, confirmAttendanceImport, confirmExpenseImport, createExpenseSubcategory, deleteExpenseAttachment, deleteOrDeactivateLabour, extractExpenseReceipt, fetchExpenseAttachments, fetchExpenseCategories, fetchLabourDeletionPreview, openExpenseAttachment, previewAttendanceImport, previewExpenseImport, searchExpenses, updateExpenseSubcategory, uploadExpenseAttachment, validateVoucherNumber, type AttendanceImportMapping, type AttendanceImportPreview, type AttendanceImportResult, type ExpenseAttachment, type ExpenseImportPreview, type ExpenseImportResolution, type ExpenseImportResult, type ExpenseOcrSuggestion, type ExpenseSearchRecord, type LabourDeletionPreview } from "../lib/api";
import { buildDispatchAvailability, dispatchCartons, dispatchItemKey, resolveSaleType, saleProduceLabel, soldQuantityByDispatchItem } from "../lib/dispatch-sales";
import { canCreate, canDelete, canEdit, hasPermission } from "../lib/permissions";
import { translateExpenseCategory, translateExpenseSubcategory, translatePaymentType, translateSaleType, translateSalesStatus } from "../lib/systemTranslations";
import {
  buildPartnerLiabilityPositions,
  calculatePartnerLiabilityBalance,
  getPartnerBalanceState,
  partnerLiabilityGroupDisplayTotal,
  defaultPartnerLiabilityGroupExpansion,
  groupPartnerLiabilityTransactions,
  partnerAdjustmentEffect,
  resolvePartnerAccountId,
  type PartnerLiabilityLedgerGroupKey,
} from "../lib/partnerAccounting";
import { formatDate, formatMoney } from "../lib/format";
import { isActiveOperationalRecord } from "../lib/operationalRecords";
import { getVoucherDisplayNumber, normalizeVoucherNumber, parseVoucherSequenceNumber } from "../lib/vouchers";
import { getActiveVouchers, getAllVouchers, loadWorkspaceVouchers } from "../lib/voucherCollections";
import { compareWageRates, getWageRateStatus, normalizeHalfDayRate } from "../lib/wageRates";
import {
  compareLabourers,
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
  type DateType,
  type Dispatch,
  type DispatchItem,
  type Labourer,
  type LabourGroup,
  type LabourPayment,
  type PartnerEntry,
  type ProductionEntry,
  type Sale,
  type Vehicle,
  type Voucher,
  type VoucherItem,
} from "../lib/offline-db";
import { deleteOperationalRecord, persistOperationalRecord, refreshOperationalData } from "../services/syncService";

export type ModuleKey = "workforce" | "expenses" | "sales" | "dispatch" | "accounts" | "partnerLedger";

const today = todayLocalDateKey;
const money = formatMoney;
const shortDate = (value: string) => formatDate(value, { day: "numeric", month: "short", year: "numeric" });
const readableSyncTime = (value: string | null) => value ? new Date(value).toLocaleString() : "Not synced yet";
const paymentTypes = ["daily_wage", "production_based", "contract_lump_sum", "monthly_salary", "other"] as const;
type PaymentType = typeof paymentTypes[number];
const hasEndedBefore = (labourer: Labourer, date: string) => Boolean(labourer.endedOn && labourer.endedOn < date);
const isInactiveOn = (labourer: Labourer, date: string) => labourer.active === false || hasEndedBefore(labourer, date);
const canMarkAttendanceOn = (labourer: Labourer, date: string) => !isInactiveOn(labourer, date);
type AccountLedgerRow = {
  id: string;
  date: string;
  type: "sale" | "voucher" | "advance" | "settlement_sent" | "settlement_received" | "contribution" | "withdrawal" | "adjustment";
  reference: string;
  description: string;
  debit: number;
  credit: number;
  source: "sales" | "expenses" | "labour_advances" | "partner_ledger";
  sourceId: string;
  counterparty?: string;
  runningBalance?: number;
  classification?: string;
  partnerLiabilityGroup?: PartnerLiabilityLedgerGroupKey;
};
const paymentTypeLabel = (paymentType: PaymentType | undefined) => translatePaymentType(paymentType ?? "daily_wage");

const labourPaymentSummary = (labourer: Labourer) => {
  const type = labourer.paymentType ?? "daily_wage";
  if (type === "production_based") {
    const unit = labourer.productionUnit === "custom" ? labourer.customProductionUnit || "unit" : labourer.productionUnit || "unit";
    return `${money(labourer.productionUnitRate ?? 0)}/${unit}`;
  }
  if (type === "contract_lump_sum") return `${money(labourer.contractAmount ?? 0)} contract`;
  if (type === "monthly_salary") return `${money(labourer.monthlySalary ?? 0)}/month`;
  if (type === "other") return labourer.otherPaymentRate ? money(labourer.otherPaymentRate) : (labourer.otherPaymentDescription || translatePaymentType("other"));
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

function FormCard({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="record-panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

const attendanceMark = (status?: "present" | "half_day" | "absent" | null) => status === "present" ? "P" : status === "half_day" ? "1/2" : status === "absent" ? "A" : "-";

function WorkforceModule({
  openAttendanceOnLoad = false,
  openAdvanceOnLoad = false,
  onAttendanceClose,
  onAdvanceClose,
}: {
  openAttendanceOnLoad?: boolean;
  openAdvanceOnLoad?: boolean;
  onAttendanceClose?: () => void;
  onAdvanceClose?: () => void;
}) {
  const { t } = useTranslation();
  const { token, user, sessionRefreshing } = useAuth();
  const sync = useSyncState();
  const loadLabourers = useCallback(async () => (await workspaceRecords(offlineDb.labourers)).sort(compareLabourers), []);
  const loadGroups = useCallback(async () => (await workspaceRecords(offlineDb.labourGroups)).sort((a, b) => a.name.localeCompare(b.name)), []);
  const loadAttendance = useCallback(async () => (await workspaceRecords(offlineDb.attendance)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), []);
  const loadAdvances = useCallback(async () => (await workspaceRecords(offlineDb.advances)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), []);
  const loadAccounts = useCallback(async () => (await workspaceRecords(offlineDb.accounts, { includeImportedAcrossSeasons: true })).sort((a, b) => a.name.localeCompare(b.name)), []);
  const loadWageRates = useCallback(async () => (await workspaceRecords(offlineDb.wageRates, { includeDeleted: true })).sort(compareWageRates), []);
  const loadProductionEntries = useCallback(async () => (await workspaceRecords(offlineDb.productionEntries)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), []);
  const loadPayments = useCallback(async () => (await workspaceRecords(offlineDb.labourPayments)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), []);
  const [labourers, refreshLabourers] = useData(loadLabourers);
  const [groups, refreshGroups] = useData(loadGroups);
  const [attendance, refreshAttendance, setAttendance] = useData(loadAttendance);
  const [advances, refreshAdvances, setAdvances] = useData(loadAdvances);
  const [accounts] = useData(loadAccounts, ensureLocalAccounts);
  const [wageRates] = useData(loadWageRates);
  const [productionEntries, refreshProductionEntries, setProductionEntries] = useData(loadProductionEntries);
  const [payments, refreshPayments, setPayments] = useData(loadPayments);
  const nextLabourSortOrder = useMemo(
    () => labourers.reduce((max, labourer) => Math.max(
      max,
      typeof labourer.sortOrder === "number" ? labourer.sortOrder
        : typeof labourer.androidSortOrder === "number" ? labourer.androidSortOrder
          : typeof labourer.originalIndex === "number" ? labourer.originalIndex
            : -1,
    ), -1) + 1,
    [labourers],
  );
  const [date, setDate] = useState(today());
  const [attendanceSearch, setAttendanceSearch] = useState("");
  const [labourSearch, setLabourSearch] = useState("");
  const [groupFilterId, setGroupFilterId] = useState<string>("all");
  const [paymentTypeFilter, setPaymentTypeFilter] = useState<PaymentType | "all">("all");
  const [attendanceFilter, setAttendanceFilter] = useState<Attendance["status"] | "all">("all");
  const [showInactiveLabour, setShowInactiveLabour] = useState(false);
  const [selectedLabourer, setSelectedLabourer] = useState<Labourer | null>(null);
  const [actionLabourer, setActionLabourer] = useState<Labourer | null>(null);
  const [markingLabourers, setMarkingLabourers] = useState<Set<string>>(() => new Set());
  const [showAdvanceEntry, setShowAdvanceEntry] = useState(false);
  const [showAddLabour, setShowAddLabour] = useState(false);
  const [showAddGroup, setShowAddGroup] = useState(false);
  const [showAttendanceEntry, setShowAttendanceEntry] = useState(false);
  const [showRegisterFilters, setShowRegisterFilters] = useState(false);
  const [labourAction, setLabourAction] = useState<"update" | "advance" | "production" | "payment" | "deactivate" | null>(null);
  const [newAttendanceLabourId, setNewAttendanceLabourId] = useState<string | null>(null);
  const [attendanceSaveState, setAttendanceSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const attendanceRowRefs = useRef<Record<string, HTMLElement | null>>({});

  const markAttendance = async (targetLabourerId: string, status: Attendance["status"]) => {
    if (!canWriteAttendance) {
      showToast(t("common.viewOnlyAccess"));
      return;
    }
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

  const attendanceLookup = useMemo(() => buildAttendanceStatusMap(attendance, date), [attendance, date]);
  const yesterdayDate = useMemo(() => previousLocalDateKey(date), [date]);
  const yesterdayLookup = useMemo(() => buildAttendanceStatusMap(attendance, yesterdayDate), [attendance, yesterdayDate]);
  const attendanceByLabourer = attendanceLookup.statuses;
  const yesterdayByLabourer = yesterdayLookup.statuses;
  useEffect(() => {
    const duplicates = [...attendanceLookup.duplicates, ...yesterdayLookup.duplicates];
    if (duplicates.length) {
      console.warn("Duplicate attendance records detected for labour/date. Showing the newest record deterministically.", duplicates);
    }
  }, [attendanceLookup.duplicates, yesterdayLookup.duplicates]);
  const filteredLabourers = labourers.filter((labourer) => {
    const status = attendanceByLabourer.get(attendanceStatusKey(labourer.id, date));
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
  const selectedLabourRates = selectedLabourer
    ? wageRates.filter((rate) => rate.labourerId === selectedLabourer.id)
    : [];
  const currentWageRate = selectedLabourRates.find((rate) => getWageRateStatus(rate, today()) === "active") ?? null;
  const upcomingWageRate = selectedLabourRates.find((rate) => getWageRateStatus(rate, today()) === "upcoming") ?? null;
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
  const canWriteAttendance = Boolean(!sessionRefreshing && user?.workspaceId && canCreate(user, "attendance", user.workspaceId));
  const canManageLabour = Boolean(!sessionRefreshing && user?.workspaceId && canCreate(user, "workforce", user.workspaceId));
  const canAddAdvance = Boolean(!sessionRefreshing && user?.workspaceId && canCreate(user, "advances", user.workspaceId));
  const canCreateGroups = Boolean(!sessionRefreshing && user?.workspaceId && canCreate(user, "workforce", user.workspaceId));
  const canCreateProduction = Boolean(!sessionRefreshing && user?.workspaceId && canCreate(user, "workforce", user.workspaceId));
  const canCreatePayments = Boolean(!sessionRefreshing && user?.workspaceId && canCreate(user, "workforce", user.workspaceId));
  const showToast = (message: string) => window.dispatchEvent(new CustomEvent("muzare-toast", { detail: message }));
  const closeLabourAction = () => {
    setLabourAction(null);
    setActionLabourer(null);
  };
  const saveLabour = async (record: Labourer) => {
    if (selectedLabourer?.id === record.id) setSelectedLabourer(record);
    if (actionLabourer?.id === record.id) setActionLabourer(record);
    if (!canManageLabour) throw new Error(t("common.viewOnlyAccess"));
    await persistOperationalRecord("labourer", record);
    await refreshLabourers();
    if (selectedLabourer?.id === record.id) setSelectedLabourer(record);
    if (actionLabourer?.id === record.id) setActionLabourer(record);
    showToast(t("workforcePage.labourUpdated"));
  };
  const saveAdvance = async (record: Advance) => {
    if (!canAddAdvance) throw new Error(t("common.viewOnlyAccess"));
    setAdvances((current) => [record, ...current.filter((entry) => entry.id !== record.id)]);
    await persistOperationalRecord("advance", record);
    showToast(t("workforcePage.advanceAdded"));
  };
  const saveGroup = async (record: LabourGroup) => {
    if (!canCreateGroups) throw new Error(t("common.viewOnlyAccess"));
    await persistOperationalRecord("labourGroup", record);
    await refreshGroups();
  };
  const saveProduction = async (record: ProductionEntry) => {
    if (!canCreateProduction) throw new Error(t("common.viewOnlyAccess"));
    setProductionEntries((current) => [record, ...current.filter((entry) => entry.id !== record.id)]);
    await persistOperationalRecord("productionEntry", record);
  };
  const savePayment = async (record: LabourPayment) => {
    if (!canCreatePayments) throw new Error(t("common.viewOnlyAccess"));
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
    if (openAttendanceOnLoad && canWriteAttendance) setShowAttendanceEntry(true);
  }, [canWriteAttendance, openAttendanceOnLoad]);
  useEffect(() => {
    if (openAdvanceOnLoad && canAddAdvance) setShowAdvanceEntry(true);
  }, [canAddAdvance, openAdvanceOnLoad]);
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
          <h2>{t("moduleTitles.workforce")}</h2>
          <p>{t("moduleDescriptions.workforce")}</p>
        </header>
        <div className="workforce-top-actions">
            {canWriteAttendance && <button className="workforce-mark-attendance" type="button" onClick={() => setShowAttendanceEntry(true)}>{t("workforcePage.markAttendance")}</button>}
          <div className="workforce-toolbar">
            {canManageLabour && <button type="button" onClick={() => setShowAddLabour(true)}>{t("workforcePage.addLabour")}</button>}
            {canAddAdvance && <button type="button" onClick={() => setShowAdvanceEntry(true)}>{t("layout.advances")}</button>}
            {canManageLabour && <button type="button" onClick={() => setShowAddGroup(true)}>{t("workforcePage.groups")}</button>}
          </div>
        </div>
        <div className="workforce-list-header">
          <h2>{t("workforcePage.labourList")}</h2>
          <div className="workforce-list-header__controls">
            <SearchInput placeholder={t("workforcePage.searchRegister")} value={labourSearch} onChange={setLabourSearch} />
            <button type="button" aria-label={t("workforcePage.moreFilters")} onClick={() => setShowRegisterFilters((current) => !current)}>
              <MoreVertical size={18} />
            </button>
          </div>
        </div>
        {showRegisterFilters && <div className="attendance-tools workforce-filters">
          <ClearableSelect value={groupFilterId} clearValue="all" onChange={setGroupFilterId}>
            <option value="all">{t("reportsPage.allGroups")}</option>
            {groups.filter((group) => group.active !== false).map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </ClearableSelect>
          <ClearableSelect value={paymentTypeFilter} clearValue="all" onChange={(value) => setPaymentTypeFilter(value as PaymentType | "all")}>
            <option value="all">{t("workforcePage.allPaymentTypes")}</option>
            <option value="daily_wage">{translatePaymentType("daily_wage")}</option>
            <option value="production_based">{translatePaymentType("production_based")}</option>
            <option value="contract_lump_sum">{translatePaymentType("contract_lump_sum")}</option>
            <option value="monthly_salary">{translatePaymentType("monthly_salary")}</option>
            <option value="other">{translatePaymentType("other")}</option>
          </ClearableSelect>
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
                  <em className={isInactiveOn(labourer, today()) ? "status-inactive" : "status-active"}>{isInactiveOn(labourer, today()) ? t("common.inactive") : t("common.active")}</em>
                  {labourer.endedOn && <small>{t("workforcePage.endDate")}: {labourer.endedOn}</small>}
                </span>
                <button className="workforce-row__action" type="button" onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setActionLabourer(labourer);
                  setLabourAction("update");
                }}>{t("common.update")}</button>
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
            <div className="attendance-report-header__copy">
              <span>{t("workforcePage.dailyAttendance")}</span>
              <h2 id="mark-attendance-title">{t("workforcePage.markAttendance")}</h2>
            </div>
            <div className="attendance-header-actions">
              <span className={`attendance-auto-save attendance-auto-save--${sync.status}`} role="status" aria-live="polite">{attendanceSaveLabel}</span>
              <button className="attendance-report-close" type="button" onClick={() => {
                if (onAttendanceClose) onAttendanceClose();
                else setShowAttendanceEntry(false);
              }} aria-label={t("workforcePage.closeMarkAttendance")}><X size={19} /></button>
            </div>
          </header>
          <section className="record-panel daily-attendance-panel attendance-entry-modal-body">
            {(sync.status === "offline" || sync.dataSource === "cache") && <div className="attendance-cache-banner" role="status">
              <strong>{sync.status === "offline" ? t("workforcePage.offlineCachedLabour") : t("workforcePage.cachedLoadingLabour")}</strong>
              <small>{t("workforcePage.lastSynced")}: {readableSyncTime(sync.lastSyncTime)}</small>
            </div>}
            {sync.pendingCount > 0 && <div className="attendance-cache-banner attendance-cache-banner--pending" role="status">
              <strong>{t("workforcePage.pendingSync", { count: sync.pendingCount })}</strong>
            </div>}
            <div className="attendance-entry-controls">
              <ClearableSelect value={groupFilterId} clearValue="all" onChange={setGroupFilterId}>
                <option value="all">{t("reportsPage.allGroups")}</option>
                {groups.filter((group) => group.active !== false).map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
              </ClearableSelect>
              <label className="attendance-date-control">
                <span>{t("workforcePage.date")}</span>
                <input aria-label={t("workforcePage.attendanceDate")} type="date" value={date} onChange={(event) => setDate(event.target.value)} />
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
                ? <Empty>{t("workforcePage.noCachedLabour")}</Empty>
                : !filteredLabourers.length ? <Empty>{t("workforcePage.noLabourSearch")}</Empty> : filteredLabourers.map((labourer, index) => {
                const currentStatus = attendanceByLabourer.get(attendanceStatusKey(labourer.id, date));
                const previousStatus = yesterdayByLabourer.get(attendanceStatusKey(labourer.id, yesterdayDate));
                const markable = canMarkAttendanceOn(labourer, date);
                return (
                  <article className="attendance-card" key={labourer.id} ref={(node) => { attendanceRowRefs.current[labourer.id] = node; }}>
                    <span className="attendance-card__index">{index + 1}</span>
                    <div className="attendance-card__body">
                      <strong>{labourer.name}</strong>
                      <span>{t("workforcePage.yesterday")}: {previousStatus ? previousStatus === "half_day" ? "1/2" : previousStatus === "present" ? "P" : "A" : "-"}</span>
                      {!markable && <span className="status-inactive">{t("workforcePage.notAvailableForAttendance")}</span>}
                    </div>
                    <div className="attendance-status-buttons">
                      <button disabled={!canWriteAttendance || !markable || markingLabourers.has(labourer.id)} className={currentStatus === "present" ? "is-active" : ""} type="button" onClick={() => void markAttendance(labourer.id, "present")}>P</button>
                      <button disabled={!canWriteAttendance || !markable || markingLabourers.has(labourer.id)} className={currentStatus === "half_day" ? "is-active" : ""} type="button" onClick={() => void markAttendance(labourer.id, "half_day")}>1/2</button>
                      <button disabled={!canWriteAttendance || !markable || markingLabourers.has(labourer.id)} className={currentStatus === "absent" ? "is-active" : ""} type="button" onClick={() => void markAttendance(labourer.id, "absent")}>A</button>
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
            className="worker-dialog worker-dialog--record-detail"
            role="dialog"
            aria-modal="true"
            aria-labelledby="worker-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="worker-dialog__header">
              <h2 id="worker-dialog-title">{selectedLabourer.name}</h2>
            </header>
            <div className="worker-dialog__body">
              <h3>{t("workforcePage.attendanceStatistics")}</h3>
              <dl className="worker-stats">
                <div><dt>{t("common.status")}</dt><dd className={selectedLabourer.active === false ? "negative" : "positive"}>{selectedLabourer.active === false ? t("common.inactive") : t("common.active")}</dd></div>
                <div><dt>{t("workforcePage.paymentTypeLabel")}</dt><dd>{translatePaymentType(selectedLabourer.paymentType ?? "daily_wage")}</dd></div>
                <div><dt>{t("workforcePage.paymentSummary")}</dt><dd>{labourPaymentSummary(selectedLabourer)}</dd></div>
                <div><dt>{t("workforcePage.groupLabel")}</dt><dd>{selectedLabourer.group}</dd></div>
                <div><dt>{t("workforcePage.joinDate")}</dt><dd>{selectedLabourer.joinedOn ?? selectedLabourer.createdAt.slice(0, 10)}</dd></div>
                <div><dt>{t("workforcePage.endDate")}</dt><dd>{selectedLabourer.endedOn || "-"}</dd></div>
                <div><dt>{t("workforcePage.present")}</dt><dd>{presentCount}</dd></div>
                <div><dt>{t("workforcePage.halfDay")}</dt><dd>{halfDayCount}</dd></div>
                <div><dt>{t("workforcePage.absent")}</dt><dd>{absentCount}</dd></div>
              </dl>

              <h3>{t("workforcePage.financialOverview")}</h3>
              <dl className="worker-stats">
                <div><dt>{t("workforcePage.paymentSummary")}</dt><dd>{labourPaymentSummary(selectedLabourer)}</dd></div>
                <div><dt>{t("wageRatesPage.currentRate")}</dt><dd>{currentWageRate ? money(currentWageRate.dailyRate) : t("wageRatesPage.noCurrentRate")}</dd></div>
                <div><dt>{t("wageRatesPage.halfDayRate")}</dt><dd>{currentWageRate ? money(normalizeHalfDayRate(currentWageRate)) : "-"}</dd></div>
                <div><dt>{t("reportsPage.total")}</dt><dd className="positive">{money(totalEarnings)}</dd></div>
                <div><dt>{t("advancesPage.recordAdvance")}</dt><dd className={advanceAmount > 0 ? "negative" : ""}>{money(advanceAmount)}</dd></div>
                <div><dt>{t("workforcePage.paymentsLabel")}</dt><dd className={paidAmount > 0 ? "negative" : ""}>{money(paidAmount)}</dd></div>
                <div><dt>{t("workforcePage.netBalanceLabel")}</dt><dd className={netBalance < 0 ? "negative" : "positive"}>{money(netBalance)}</dd></div>
              </dl>
              {(selectedLabourRates.length > 0 || upcomingWageRate) && <>
                <h3>{t("wageRatesPage.history")}</h3>
                <dl className="worker-stats">
                  {upcomingWageRate && <div><dt>{t("wageRatesPage.nextScheduledRate")}</dt><dd>{money(upcomingWageRate.dailyRate)} · {upcomingWageRate.effectiveFrom}</dd></div>}
                  {selectedLabourRates.slice(0, 4).map((rate) => <div key={rate.id}>
                    <dt>{rate.effectiveFrom}{rate.effectiveTo ? ` - ${rate.effectiveTo}` : ""}</dt>
                    <dd>{money(rate.dailyRate)} / {money(normalizeHalfDayRate(rate))}</dd>
                  </div>)}
                </dl>
              </>}
            </div>
            <footer className="worker-dialog__footer">
              {canManageLabour && <button className="worker-dialog__link" type="button" onClick={() => { setActionLabourer(selectedLabourer); setLabourAction("update"); }}>{t("common.edit")}</button>}
              {canAddAdvance && <button className="worker-dialog__link" type="button" onClick={() => { setActionLabourer(selectedLabourer); setLabourAction("advance"); }}>{t("advancesPage.recordAdvance")}</button>}
              {canAddAdvance && selectedLabourer.paymentType === "production_based" && <button className="worker-dialog__link" type="button" onClick={() => { setActionLabourer(selectedLabourer); setLabourAction("production"); }}>{t("workforcePage.recordProduction")}</button>}
              {canAddAdvance && <button className="worker-dialog__link" type="button" onClick={() => { setActionLabourer(selectedLabourer); setLabourAction("payment"); }}>{t("workforcePage.paymentAction")}</button>}
              {canManageLabour && <button className="worker-dialog__link worker-dialog__link--danger" type="button" onClick={() => {
                if (!navigator.onLine || sync.pendingCount > 0) showToast(t("errors.syncPendingBeforeDeactivate"));
                else {
                  setActionLabourer(selectedLabourer);
                  setLabourAction("deactivate");
                }
              }}>{selectedLabourer.active === false ? t("common.delete") : t("workforcePage.deactivateDelete")}</button>}
              <button className="worker-dialog__close" type="button" onClick={() => setSelectedLabourer(null)}>{t("common.close")}</button>
            </footer>
          </section>
        </div>
      )}
      {actionLabourer && labourAction === "update" && <EditLabourPanel labourer={actionLabourer} onClose={closeLabourAction} onSave={saveLabour} />}
      {actionLabourer && labourAction === "advance" && <AddAdvancePanel labourer={actionLabourer} accounts={accounts} onClose={closeLabourAction} onSave={saveAdvance} />}
      {showAdvanceEntry && <AdvanceEntryPanel
        labourers={labourers}
        groups={groups}
        accounts={accounts}
        onClose={() => {
          setShowAdvanceEntry(false);
          onAdvanceClose?.();
        }}
        onSave={async (record) => {
          await saveAdvance(record);
          await refreshAdvances();
        }}
      />}
      {actionLabourer && labourAction === "production" && <AddProductionPanel labourer={actionLabourer} onClose={closeLabourAction} onSave={saveProduction} />}
      {actionLabourer && labourAction === "payment" && <AddPaymentPanel labourer={actionLabourer} onClose={closeLabourAction} onSave={savePayment} />}
      {showAddGroup && <AddGroupPanel onClose={() => setShowAddGroup(false)} onSave={async (record) => {
        await saveGroup(record);
        setShowAddGroup(false);
      }} />}
      {showAddLabour && <AddLabourPanel groups={groups} nextSortOrder={nextLabourSortOrder} onCreateGroup={saveGroup} onClose={() => setShowAddLabour(false)} onSave={async (record) => {
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
      {actionLabourer && labourAction === "deactivate" && token && user?.workspaceId && (
        <DeactivateLabourPanel
          token={token} workspaceId={user.workspaceId} labourer={actionLabourer}
          onClose={closeLabourAction}
          onComplete={async (action) => {
            await refreshOperationalData(); await Promise.all([refreshLabourers(), refreshAttendance(), refreshAdvances(), refreshPayments(), refreshProductionEntries()]);
            closeLabourAction();
            if (selectedLabourer?.id === actionLabourer.id) setSelectedLabourer(null);
            showToast(action === "deleted" ? t("workforcePage.labourDeleted") : t("workforcePage.labourDeactivated"));
          }}
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
  const { t } = useTranslation();
  return <>
    <label><span>{t("workforcePage.paymentTypeField")} *</span><select required value={form.paymentType} onChange={(event) => setForm({ ...form, paymentType: event.target.value as PaymentType })}>
      <option value="daily_wage">{translatePaymentType("daily_wage")}</option>
      <option value="production_based">{translatePaymentType("production_based")}</option>
      <option value="contract_lump_sum">{translatePaymentType("contract_lump_sum")}</option>
      <option value="monthly_salary">{translatePaymentType("monthly_salary")}</option>
      <option value="other">{translatePaymentType("other")}</option>
    </select></label>
    {form.paymentType === "daily_wage" && <label><span>{t("workforcePage.dailyWageRate")} *</span><input required min="0" step="0.01" type="number" value={form.dailyWage} onChange={(event) => setForm({ ...form, dailyWage: event.target.value })} /></label>}
    {form.paymentType === "production_based" && <>
      <label><span>{t("workforcePage.productionUnit")} *</span><select value={form.productionUnit} onChange={(event) => setForm({ ...form, productionUnit: event.target.value })}>
        <option value="carton">{t("workforcePage.carton")}</option><option value="crate">{t("workforcePage.crate")}</option><option value="tree">{t("workforcePage.tree")}</option><option value="task">{t("workforcePage.task")}</option><option value="custom">{t("workforcePage.custom")}</option>
      </select></label>
      {form.productionUnit === "custom" && <label><span>{t("workforcePage.customUnitName")} *</span><input required value={form.customProductionUnit} onChange={(event) => setForm({ ...form, customProductionUnit: event.target.value })} /></label>}
      <label><span>{t("workforcePage.unitRate")} *</span><input required min="0" step="0.01" type="number" value={form.productionUnitRate} onChange={(event) => setForm({ ...form, productionUnitRate: event.target.value })} /></label>
      <label><span>{t("workforcePage.minimumGuarantee")}</span><input min="0" step="0.01" type="number" value={form.minimumGuarantee} onChange={(event) => setForm({ ...form, minimumGuarantee: event.target.value })} /></label>
    </>}
    {form.paymentType === "contract_lump_sum" && <>
      <label><span>{t("workforcePage.contractTitle")}</span><input value={form.contractTitle} onChange={(event) => setForm({ ...form, contractTitle: event.target.value })} /></label>
      <label><span>{t("workforcePage.totalContractAmount")} *</span><input required min="0" step="0.01" type="number" value={form.contractAmount} onChange={(event) => setForm({ ...form, contractAmount: event.target.value })} /></label>
      <label><span>{t("workforcePage.contractStartDate")}</span><input type="date" value={form.contractStartDate} onChange={(event) => setForm({ ...form, contractStartDate: event.target.value })} /></label>
      <label><span>{t("workforcePage.expectedEndDate")}</span><input type="date" value={form.contractExpectedEndDate} onChange={(event) => setForm({ ...form, contractExpectedEndDate: event.target.value })} /></label>
      <label><span>{t("workforcePage.paymentTermsNotes")}</span><textarea value={form.contractTerms} onChange={(event) => setForm({ ...form, contractTerms: event.target.value })} /></label>
    </>}
    {form.paymentType === "monthly_salary" && <>
      <label><span>{t("workforcePage.monthlySalaryAmount")} *</span><input required min="0" step="0.01" type="number" value={form.monthlySalary} onChange={(event) => setForm({ ...form, monthlySalary: event.target.value })} /></label>
      <label><span>{t("workforcePage.paymentDay")}</span><input min="1" max="31" step="1" type="number" value={form.paymentDay} onChange={(event) => setForm({ ...form, paymentDay: event.target.value })} /></label>
    </>}
    {form.paymentType === "other" && <>
      <label><span>{t("reportsPage.description")}</span><input value={form.otherPaymentDescription} onChange={(event) => setForm({ ...form, otherPaymentDescription: event.target.value })} /></label>
      <label><span>{t("workforcePage.amountRate")}</span><input min="0" step="0.01" type="number" value={form.otherPaymentRate} onChange={(event) => setForm({ ...form, otherPaymentRate: event.target.value })} /></label>
    </>}
  </>;
}

function EditLabourPanel({ labourer, onClose, onSave }: { labourer: Labourer; onClose: () => void; onSave: (record: Labourer) => Promise<void> }) {
  const { t } = useTranslation();
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
    if (!form.name.trim()) { setError(t("workforcePage.labourNameRequired")); return; }
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
    } catch (caught) { setError(caught instanceof Error ? caught.message : t("workforcePage.unableUpdateLabour")); }
    finally { setBusy(false); }
  };
  return <ActionPanel title={t("workforcePage.updateLabourTitle")} onClose={onClose}>
    <form className="worker-action-form" onSubmit={(event) => void submit(event)}>
      <label><span>{t("workforcePage.labourName")} *</span><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
      <label><span>{t("workforcePage.groupLabel")}</span><input value={form.group} onChange={(event) => setForm({ ...form, group: event.target.value })} /></label>
      <LabourPaymentFields form={form} setForm={setForm} />
      <label><span>{t("workforcePage.statusLabel")}</span><select value={form.active ? "active" : "inactive"} onChange={(event) => setForm({ ...form, active: event.target.value === "active" })}><option value="active">{t("common.active")}</option><option value="inactive">{t("common.inactive")}</option></select></label>
      <label><span>{t("workforcePage.joinDate")}</span><input type="date" value={form.joinedOn} onChange={(event) => setForm({ ...form, joinedOn: event.target.value })} /></label>
      <label><span>{t("workforcePage.endDate")}</span><input type="date" value={form.endedOn} onChange={(event) => setForm({ ...form, endedOn: event.target.value })} /></label>
      <label><span>{t("workforcePage.phoneContact")}</span><input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
      <label><span>{t("reportsPage.notes")}</span><textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
      {error && <p className="worker-action-error">{error}</p>}
      <footer><button type="button" onClick={onClose}>{t("common.cancel")}</button><button disabled={busy} type="submit">{busy ? t("workforcePage.saving") : t("workforcePage.saveLabour")}</button></footer>
    </form>
  </ActionPanel>;
}

function AddLabourPanel({
  groups,
  nextSortOrder,
  onCreateGroup,
  onClose,
  onSave,
}: {
  groups: LabourGroup[];
  nextSortOrder: number;
  onCreateGroup: (record: LabourGroup) => Promise<void>;
  onClose: () => void;
  onSave: (record: Labourer) => Promise<void>;
}) {
  const { t } = useTranslation();
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
    if (!form.name.trim()) { setError(t("workforcePage.labourNameRequired")); return; }
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
        sortOrder: nextSortOrder,
        androidSortOrder: nextSortOrder,
        originalIndex: nextSortOrder,
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
      setError(caught instanceof Error ? caught.message : t("workforcePage.unableAddLabour"));
    } finally {
      setBusy(false);
    }
  };
  return <ActionPanel title={t("workforcePage.addLabourTitle")} onClose={onClose}>
    <form className="worker-action-form" onSubmit={(event) => void submit(event)}>
      <label><span>{t("workforcePage.labourName")} *</span><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
      <label><span>{t("workforcePage.dateOfJoining")} *</span><input required type="date" value={form.joinedOn} onChange={(event) => setForm({ ...form, joinedOn: event.target.value })} /></label>
      <label><span>{t("workforcePage.groupLabel")}</span><select value={form.groupId} onChange={(event) => {
        const next = event.target.value;
        const group = groups.find((item) => item.id === next);
        setForm({ ...form, groupId: next, group: group?.name ?? form.group });
      }}>
        <option value="">{t("workforcePage.none")}</option>
        {groups.filter((group) => group.active !== false).map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
        <option value="__new_group__">{t("workforcePage.createNewGroup")}</option>
      </select></label>
      {form.groupId === "__new_group__" && <label><span>{t("workforcePage.newGroupName")} *</span><input required value={form.group} onChange={(event) => setForm({ ...form, group: event.target.value })} /></label>}
      <LabourPaymentFields form={form} setForm={setForm} />
      <label><span>{t("workforcePage.phoneContact")}</span><input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
      <label><span>{t("workforcePage.statusLabel")}</span><select value={form.active ? "active" : "inactive"} onChange={(event) => setForm({ ...form, active: event.target.value === "active" })}><option value="active">{t("common.active")}</option><option value="inactive">{t("common.inactive")}</option></select></label>
      {error && <p className="worker-action-error">{error}</p>}
      <footer><button type="button" onClick={onClose}>{t("common.cancel")}</button><button disabled={busy} type="submit">{busy ? t("workforcePage.saving") : t("workforcePage.saveLabour")}</button></footer>
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
  const labourInputRef = useRef<HTMLInputElement>(null);
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
      setLabourerId("");
      setForm((current) => ({ ...current, amount: "", notes: "" }));
      window.requestAnimationFrame(() => labourInputRef.current?.focus());
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
          inputRef={labourInputRef}
          options={filteredLabourers}
          placeholder="Search labour"
          value={labourerId}
          onChange={setLabourerId}
          noResultsLabel="No matching labour found"
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

export function AttendanceImportPanel({ token, workspaceId, farmId, seasonId, onClose, onImported }: {
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

export function ExpenseImportPanel({ token, workspaceId, farmId, seasonId, onClose, onImported }: {
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

type PendingReceipt = { id: string; file: File; originalFile?: File; cropMetadata?: Record<string, unknown>; previewUrl?: string };
type CropBox = { left: number; top: number; right: number; bottom: number };
const receiptTypes = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const receiptMaxSize = 10 * 1024 * 1024;

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read receipt file."));
    reader.readAsDataURL(file);
  });
}

function imageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Unable to read receipt image."));
    };
    image.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality = 0.86): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Unable to process receipt image.")), type, quality);
  });
}

async function cropReceiptImage(file: File, crop: CropBox, rotation: number): Promise<{ file: File; metadata: Record<string, unknown> }> {
  const image = await imageFromFile(file);
  const normalizedRotation = ((rotation % 360) + 360) % 360;
  const rotatedCanvas = document.createElement("canvas");
  const rotatedContext = rotatedCanvas.getContext("2d");
  if (!rotatedContext) throw new Error("Image processing is not available.");
  const sideways = normalizedRotation === 90 || normalizedRotation === 270;
  rotatedCanvas.width = sideways ? image.naturalHeight : image.naturalWidth;
  rotatedCanvas.height = sideways ? image.naturalWidth : image.naturalHeight;
  rotatedContext.translate(rotatedCanvas.width / 2, rotatedCanvas.height / 2);
  rotatedContext.rotate((normalizedRotation * Math.PI) / 180);
  rotatedContext.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);

  const left = Math.max(0, Math.min(crop.left, 90));
  const top = Math.max(0, Math.min(crop.top, 90));
  const right = Math.max(left + 5, Math.min(crop.right, 100));
  const bottom = Math.max(top + 5, Math.min(crop.bottom, 100));
  const sourceX = Math.round((left / 100) * rotatedCanvas.width);
  const sourceY = Math.round((top / 100) * rotatedCanvas.height);
  const sourceWidth = Math.round(((right - left) / 100) * rotatedCanvas.width);
  const sourceHeight = Math.round(((bottom - top) / 100) * rotatedCanvas.height);
  const output = document.createElement("canvas");
  output.width = sourceWidth;
  output.height = sourceHeight;
  const outputContext = output.getContext("2d");
  if (!outputContext) throw new Error("Image processing is not available.");
  outputContext.filter = "contrast(1.08) saturate(0.98)";
  outputContext.drawImage(rotatedCanvas, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);
  const type = file.type === "image/png" ? "image/png" : "image/jpeg";
  const blob = await canvasToBlob(output, type);
  const name = file.name.replace(/\.[^.]+$/, "") + "-cropped." + (type === "image/png" ? "png" : "jpg");
  return {
    file: new File([blob], name, { type, lastModified: Date.now() }),
    metadata: { crop, rotation: normalizedRotation, originalName: file.name, processedAt: new Date().toISOString() },
  };
}

function ReceiptCropReviewModal({ file, onCancel, onAccept }: { file: File; onCancel: () => void; onAccept: (receipt: PendingReceipt) => void }) {
  const { t } = useTranslation();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [crop, setCrop] = useState<CropBox>({ left: 6, top: 6, right: 94, bottom: 94 });
  const [activeCorner, setActiveCorner] = useState<"topLeft" | "topRight" | "bottomLeft" | "bottomRight" | null>(null);
  const [rotation, setRotation] = useState(0);
  const [status, setStatus] = useState(t("expensesPage.detectingReceiptBorders"));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    const timer = window.setTimeout(() => setStatus(t("expensesPage.cropDetectedReview")), 450);
    return () => {
      window.clearTimeout(timer);
      URL.revokeObjectURL(url);
    };
  }, [file, t]);
  const autoDetect = () => {
    setCrop({ left: 6, top: 6, right: 94, bottom: 94 });
    setStatus(t("expensesPage.cropDetectedReview"));
  };
  const dragCorner = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!activeCorner || !stageRef.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100));
    const minSize = 12;
    setCrop((current) => {
      if (activeCorner === "topLeft") return { ...current, left: Math.min(x, current.right - minSize), top: Math.min(y, current.bottom - minSize) };
      if (activeCorner === "topRight") return { ...current, right: Math.max(x, current.left + minSize), top: Math.min(y, current.bottom - minSize) };
      if (activeCorner === "bottomLeft") return { ...current, left: Math.min(x, current.right - minSize), bottom: Math.max(y, current.top + minSize) };
      return { ...current, right: Math.max(x, current.left + minSize), bottom: Math.max(y, current.top + minSize) };
    });
    setStatus(t("expensesPage.adjustCorners"));
  };
  const startCornerDrag = (corner: typeof activeCorner) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setActiveCorner(corner);
  };
  const acceptCrop = async () => {
    setBusy(true);
    setStatus(t("expensesPage.croppingReceipt"));
    try {
      const result = await cropReceiptImage(file, crop, rotation);
      onAccept({ id: crypto.randomUUID(), file: result.file, originalFile: file, cropMetadata: result.metadata, previewUrl: URL.createObjectURL(result.file) });
    } finally {
      setBusy(false);
    }
  };
  const skipCrop = () => onAccept({ id: crypto.randomUUID(), file, originalFile: file, cropMetadata: { skipped: true, originalName: file.name, processedAt: new Date().toISOString() }, previewUrl: URL.createObjectURL(file) });
  return (
    <div className="modal-backdrop receipt-scanner-backdrop">
      <section className="receipt-crop-modal" role="dialog" aria-modal="true" aria-label={t("expensesPage.receiptCropReview")}>
        <header>
          <div><h2>{t("expensesPage.receiptCropReview")}</h2><p>{status}</p></div>
          <div className="receipt-crop-toolbar">
            <button type="button" onClick={() => setRotation((value) => (value + 90) % 360)}><RotateCw size={15} />{t("expensesPage.rotate")}</button>
            <button type="button" onClick={autoDetect}>{t("expensesPage.resetCrop")}</button>
            <button aria-label={t("common.close")} type="button" onClick={onCancel}><X size={18} /></button>
          </div>
        </header>
        <div
          className="receipt-crop-stage"
          ref={stageRef}
          onPointerMove={dragCorner}
          onPointerUp={() => setActiveCorner(null)}
          onPointerCancel={() => setActiveCorner(null)}
        >
          {previewUrl ? <img alt={file.name} src={previewUrl} style={{ transform: `rotate(${rotation}deg)` }} /> : null}
          <div className="receipt-crop-overlay" style={{ left: `${crop.left}%`, top: `${crop.top}%`, right: `${100 - crop.right}%`, bottom: `${100 - crop.bottom}%` }}>
            <button aria-label={t("expensesPage.cropTopLeft")} type="button" onPointerDown={startCornerDrag("topLeft")} />
            <button aria-label={t("expensesPage.cropTopRight")} type="button" onPointerDown={startCornerDrag("topRight")} />
            <button aria-label={t("expensesPage.cropBottomLeft")} type="button" onPointerDown={startCornerDrag("bottomLeft")} />
            <button aria-label={t("expensesPage.cropBottomRight")} type="button" onPointerDown={startCornerDrag("bottomRight")} />
          </div>
        </div>
        <footer>
          <button type="button" onClick={autoDetect}>{t("expensesPage.acceptAutoCrop")}</button>
          <button type="button" onClick={onCancel}>{t("expensesPage.retakeOrReplace")}</button>
          <button type="button" onClick={skipCrop}>{t("expensesPage.saveOriginal")}</button>
          <button type="button" disabled={busy} onClick={() => void acceptCrop()}>{busy ? t("expensesPage.processingReceipt") : t("expensesPage.acceptCrop")}</button>
        </footer>
      </section>
    </div>
  );
}

function ReceiptAttachmentPicker({ pending, onFiles, onRemove }: { pending: PendingReceipt[]; onFiles: (files: FileList | null) => void; onRemove: (id: string) => void }) {
  const { t } = useTranslation();
  return (
    <section className="receipt-attachment-card">
      <header><div><h3>{t("expensesPage.receiptAttachment")}</h3><p>{t("expensesPage.receiptOptional")}</p></div><Paperclip size={18} /></header>
      <div className="receipt-actions">
        <label><Camera size={16} />{t("expensesPage.takeReceiptPhoto")}<input accept="image/jpeg,image/png,image/webp" capture="environment" type="file" onChange={(event) => onFiles(event.target.files)} /></label>
        <label><UploadCloud size={16} />{t("expensesPage.uploadReceipt")}<input accept=".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf" multiple type="file" onChange={(event) => onFiles(event.target.files)} /></label>
      </div>
      {pending.length ? <div className="receipt-preview-grid">{pending.map((item) => (
        <article key={item.id}>
          {item.previewUrl ? <img alt={item.file.name} src={item.previewUrl} /> : <FileText size={28} />}
          <div><strong>{item.file.name}</strong><small>{Math.round(item.file.size / 1024)} KB{item.originalFile ? ` · ${t("expensesPage.croppedReceipt")}` : ""}</small></div>
          <button aria-label={t("common.delete")} type="button" onClick={() => onRemove(item.id)}><X size={14} /></button>
        </article>
      ))}</div> : null}
    </section>
  );
}

function ReceiptAttachmentList({ attachments, onOpen, onOpenOriginal, onDelete, onExtract, onApplyOcr, ocrResult, extracting }: { attachments: ExpenseAttachment[]; onOpen: (item: ExpenseAttachment) => void; onOpenOriginal?: (item: ExpenseAttachment) => void; onDelete?: (item: ExpenseAttachment) => void; onExtract?: (item: ExpenseAttachment) => void; onApplyOcr?: (result: ExpenseOcrSuggestion) => void; ocrResult?: ExpenseOcrSuggestion | null; extracting?: boolean }) {
  const { t } = useTranslation();
  const fields = ocrResult?.fields ?? {};
  const hasSuggestions = Boolean(ocrResult && (Object.values(fields).some((value) => value !== undefined && value !== "") || ocrResult.lineItems.length));
  return (
    <section className="receipt-detail-card">
      <div className="worker-dialog__section-head">
        <h3>{t("expensesPage.receiptAttachment")}</h3>
      </div>
      {!attachments.length ? <div className="receipt-detail-card__empty">
        <FileText size={28} />
        <strong>{t("expensesPage.noReceiptAttached")}</strong>
      </div> : attachments.map((item) => (
        <article key={item.id}>
          <span>{item.fileType.startsWith("image/") ? <ImageIcon size={18} /> : <FileText size={18} />}</span>
          <div><strong>{item.fileName}</strong><small>{Math.round(item.fileSize / 1024)} KB · {item.fileType}{item.ocrStatus ? ` · OCR: ${item.ocrStatus}` : ""}</small></div>
          <button type="button" onClick={() => onOpen(item)}>{t("expensesPage.viewCropped")}</button>
          {onOpenOriginal && <button type="button" onClick={() => onOpenOriginal(item)}>{t("expensesPage.viewOriginal")}</button>}
          {onExtract && <button type="button" onClick={() => onExtract(item)}>{t("expensesPage.extractFromReceipt")}</button>}
          {onDelete && <button className="danger-link" type="button" onClick={() => onDelete(item)}>{t("common.delete")}</button>}
        </article>
      ))}
      {extracting ? <p className="receipt-ocr-loading">{t("expensesPage.extractingReceiptData")}</p> : null}
      {ocrResult ? <div className="receipt-ocr-result">
        <strong>{t("expensesPage.suggestedExpenseData")}</strong>
        <p>{ocrResult.message || (ocrResult.status === "success" ? t("expensesPage.ocrCompleteReview") : t("expensesPage.ocrFailed"))}</p>
        <small>{t("expensesPage.confidence")}: {ocrResult.confidence}{ocrResult.provider ? ` · ${ocrResult.provider}` : ""}</small>
        {hasSuggestions ? <dl>
          {fields.date && <><dt>{t("expensesPage.date")}</dt><dd>{fields.date}</dd></>}
          {fields.supplier && <><dt>{t("expensesPage.supplier")}</dt><dd>{fields.supplier}</dd></>}
          {fields.receiptNumber && <><dt>{t("expensesPage.receiptNumber")}</dt><dd>{fields.receiptNumber}</dd></>}
          {fields.totalAmount !== undefined && <><dt>{t("expensesPage.amount")}</dt><dd>{formatMoney(fields.totalAmount)}</dd></>}
          {fields.vatAmount !== undefined && <><dt>{t("expensesPage.vat")}</dt><dd>{formatMoney(fields.vatAmount)}</dd></>}
          {fields.paymentMethod && <><dt>{t("expensesPage.paymentMethod")}</dt><dd>{fields.paymentMethod}</dd></>}
          {fields.description && <><dt>{t("expensesPage.description")}</dt><dd>{fields.description}</dd></>}
          {fields.suggestedCategory && <><dt>{t("expensesPage.category")}</dt><dd>{translateExpenseCategory(fields.suggestedCategory)}</dd></>}
          {fields.suggestedSubcategory && <><dt>{t("expensesPage.subcategory")}</dt><dd>{translateExpenseSubcategory(fields.suggestedSubcategory)}</dd></>}
        </dl> : null}
        {ocrResult.lineItems.length ? <div className="receipt-ocr-lines">
          <b>{t("expensesPage.suggestedLineItems")}</b>
          {ocrResult.lineItems.map((line, index) => <p key={`${line.name}:${index}`}><span>{line.name}</span><strong>{line.amount !== undefined ? formatMoney(line.amount) : "-"}</strong></p>)}
        </div> : null}
        {hasSuggestions && onApplyOcr ? <button className="receipt-ocr-apply" type="button" onClick={() => onApplyOcr(ocrResult)}>{t("expensesPage.applyToVoucher")}</button> : null}
      </div> : null}
    </section>
  );
}

function ExpensesModule() {
  const { t } = useTranslation();
  const { token, user, sessionRefreshing } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const load = useCallback(async () => (await loadWorkspaceVouchers({ mode: "all", includeGeneralFarmRecords: true, includeImportedAcrossSeasons: true })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), []);
  const loadAccounts = useCallback(() => workspaceRecords(offlineDb.accounts, { includeImportedAcrossSeasons: true }), []);
  const [vouchers, refresh] = useData(load);
  const [accounts] = useData(loadAccounts, ensureLocalAccounts);
  const [date, setDate] = useState(today());
  const workspaceId = user?.workspaceId ?? "";
  const farmId = getActiveFarmId();
  const seasonId = getActiveSeasonId();
  const categories = useQuery({ queryKey: ["expense-categories", workspaceId], queryFn: () => fetchExpenseCategories(token!, workspaceId), enabled: Boolean(token && workspaceId) });
  type VoucherItemDraft = {
    id: string;
    categoryId: string;
    categorySearch: string;
    subcategoryId: string;
    subcategorySearch: string;
    amount: string;
    description: string;
    remarks: string;
    oldExpenseItemId?: string | number;
  };
  type VoucherLineRow = {
    id: string;
    voucherId: string;
    voucherNumber: string;
    date: string;
    accountId: string;
    notes?: string;
    amount: number;
    category: string;
    categoryId: string;
    subcategory: string;
    subcategoryId: string;
    description: string;
    remarks?: string;
  };
  const newVoucherItemDraft = (): VoucherItemDraft => ({
    id: crypto.randomUUID(),
    categoryId: "",
    categorySearch: "",
    subcategoryId: "",
    subcategorySearch: "",
    amount: "",
    description: "",
    remarks: "",
  });
  const normalizeVoucherItems = (voucher: Voucher): VoucherItemDraft[] => {
    if (voucher.items?.length) {
      return voucher.items.map((item) => ({
        id: item.id || crypto.randomUUID(),
        categoryId: item.categoryId,
        categorySearch: item.categoryName ?? item.category,
        subcategoryId: item.subcategoryId ?? "",
        subcategorySearch: item.subcategoryName ?? item.subcategory ?? "",
        amount: String(item.amount ?? ""),
        description: item.description ?? item.remarks ?? "",
        remarks: item.remarks ?? "",
        oldExpenseItemId: item.oldExpenseItemId,
      }));
    }
    return [{
      id: crypto.randomUUID(),
      categoryId: voucher.categoryId ?? "",
      categorySearch: voucher.category ?? "",
      subcategoryId: voucher.subcategoryId ?? "",
      subcategorySearch: voucher.subcategory ?? "",
      amount: voucher.amount ? String(voucher.amount) : "",
      description: voucher.description ?? "",
      remarks: "",
    }];
  };
  const voucherLinesFor = useCallback((voucher: Voucher): VoucherLineRow[] => {
    if (voucher.items?.length) {
      return voucher.items.map((item) => ({
        id: `${voucher.id}:${item.id}`,
        voucherId: voucher.id,
        voucherNumber: getVoucherDisplayNumber(voucher) || voucher.voucherNumber,
        date: voucher.date,
        accountId: voucher.accountId,
        notes: voucher.notes,
        amount: item.amount,
        category: item.categoryName ?? item.category,
        categoryId: item.categoryId,
        subcategory: item.subcategoryName ?? item.subcategory ?? "",
        subcategoryId: item.subcategoryId ?? "",
        description: item.description || item.remarks || "",
        remarks: item.remarks,
      }));
    }
    return [{
      id: `${voucher.id}:legacy`,
      voucherId: voucher.id,
      voucherNumber: getVoucherDisplayNumber(voucher) || voucher.voucherNumber,
      date: voucher.date,
      accountId: voucher.accountId,
      notes: voucher.notes,
      amount: voucher.amount,
      category: voucher.category,
      categoryId: voucher.categoryId,
      subcategory: voucher.subcategory,
      subcategoryId: voucher.subcategoryId,
      description: voucher.description,
    }];
  }, []);
  const [customCategoryId, setCustomCategoryId] = useState("");
  const [customName, setCustomName] = useState("");
  const [voucherItems, setVoucherItems] = useState<VoucherItemDraft[]>([newVoucherItemDraft()]);
  const [accountId, setAccountId] = useState("");
  const [expenseSessionDate, setExpenseSessionDate] = useState(today());
  const [expenseSessionAccountId, setExpenseSessionAccountId] = useState("");
  const [notes, setNotes] = useState("");
  const [selectedVoucher, setSelectedVoucher] = useState<Voucher | null>(null);
  const [editingVoucher, setEditingVoucher] = useState<Voucher | null>(null);
  const [customVoucherNumberEnabled, setCustomVoucherNumberEnabled] = useState(false);
  const [customVoucherNumber, setCustomVoucherNumber] = useState("");
  const [voucherNumberValidation, setVoucherNumberValidation] = useState<{
    status: "idle" | "checking" | "valid" | "duplicate" | "invalid" | "offline";
    message: string;
    normalized?: string;
    blockingVoucher?: {
      id: string;
      workspaceId: string;
      farmId: string | null;
      seasonId: string | null;
      voucherNumber: string;
      date: string;
      amount: number;
      description: string;
      deletedAt?: string | null;
      source: "imported" | "pwa";
      oldExpenseId?: string | null;
    } | null;
  }>({ status: "idle", message: "" });
  const [showDeletedVouchers, setShowDeletedVouchers] = useState(false);
  const [showImportedVouchers, setShowImportedVouchers] = useState(true);
  const [pendingReceipts, setPendingReceipts] = useState<PendingReceipt[]>([]);
  const [, setReceiptCropQueue] = useState<File[]>([]);
  const [receiptCropTarget, setReceiptCropTarget] = useState<File | null>(null);
  const [receiptError, setReceiptError] = useState("");
  const [detailAttachments, setDetailAttachments] = useState<ExpenseAttachment[]>([]);
  const [detailOcr, setDetailOcr] = useState<ExpenseOcrSuggestion | null>(null);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [voucherSearch, setVoucherSearch] = useState("");
  const [debouncedVoucherSearch, setDebouncedVoucherSearch] = useState("");
  const [voucherFrom, setVoucherFrom] = useState("");
  const [voucherTo, setVoucherTo] = useState("");
  const [voucherCategory, setVoucherCategory] = useState("");
  const [voucherSubcategory, setVoucherSubcategory] = useState("");
  const [voucherAccountId, setVoucherAccountId] = useState("");
  const voucherFormRef = useRef<HTMLDivElement | null>(null);
  const voucherDateRef = useRef<HTMLInputElement | null>(null);
  const voucherItemCategoryRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const pendingEditFocusRef = useRef(false);
  const showToast = (message: string) => window.dispatchEvent(new CustomEvent("muzare-toast", { detail: message }));
  const isSyntheticLocalAccount = useCallback((value?: string) => Boolean(value?.includes(":local-")), []);
  const selectableExpenseAccounts = useMemo(() => accounts.filter((account) => !isSyntheticLocalAccount(account.id)), [accounts, isSyntheticLocalAccount]);
  const resolvedExpenseAccountId = accountId || selectableExpenseAccounts[0]?.id || "";
  const resetForm = (options?: { preserveSessionDefaults?: boolean }) => {
    const preserveSessionDefaults = options?.preserveSessionDefaults !== false;
    setDate(preserveSessionDefaults ? expenseSessionDate : today());
    setVoucherItems([newVoucherItemDraft()]);
    setAccountId(preserveSessionDefaults ? expenseSessionAccountId : "");
    setNotes("");
    setCustomVoucherNumberEnabled(false);
    setCustomVoucherNumber("");
    setVoucherNumberValidation({ status: "idle", message: "" });
    pendingReceipts.forEach((item) => item.previewUrl && URL.revokeObjectURL(item.previewUrl));
    setPendingReceipts([]);
    setReceiptError("");
  };
  useEffect(() => {
    const nextDate = today();
    setExpenseSessionDate(nextDate);
    setExpenseSessionAccountId("");
    setDate(nextDate);
    setAccountId("");
    setVoucherItems([newVoucherItemDraft()]);
    setNotes("");
    setCustomVoucherNumberEnabled(false);
    setCustomVoucherNumber("");
    setVoucherNumberValidation({ status: "idle", message: "" });
    pendingReceipts.forEach((item) => item.previewUrl && URL.revokeObjectURL(item.previewUrl));
    setPendingReceipts([]);
    setReceiptError("");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, farmId, seasonId]);
  useEffect(() => {
    setExpenseSessionDate(date);
  }, [date]);
  useEffect(() => {
    if (accountId) setExpenseSessionAccountId(accountId);
  }, [accountId]);
  useEffect(() => {
    if (!expenseSessionAccountId) return;
    if (selectableExpenseAccounts.some((account) => account.id === expenseSessionAccountId)) return;
    setExpenseSessionAccountId("");
    if (accountId === expenseSessionAccountId) setAccountId("");
    showToast("Previously selected payment account is no longer available.");
  }, [accountId, expenseSessionAccountId, selectableExpenseAccounts, t]);
  const openEdit = (voucher: Voucher) => {
    setSelectedVoucher(null); setEditingVoucher(voucher); setDate(voucher.date);
    setVoucherItems(normalizeVoucherItems(voucher)); setAccountId(voucher.accountId);
    setNotes(voucher.notes ?? "");
    setCustomVoucherNumberEnabled(true);
    setCustomVoucherNumber(getVoucherDisplayNumber(voucher) || voucher.voucherNumber);
    setVoucherNumberValidation({ status: "idle", message: "" });
    setPendingReceipts([]);
    setReceiptError("");
    pendingEditFocusRef.current = true;
  };
  useEffect(() => {
    if (!editingVoucher || !voucherItems.length || !pendingEditFocusRef.current) return;
    const handle = window.setTimeout(() => {
      voucherFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      const firstInput = voucherItemCategoryRefs.current[voucherItems[0]!.id] ?? null;
      firstInput?.focus();
      if (!firstInput) voucherDateRef.current?.focus();
      pendingEditFocusRef.current = false;
    }, 80);
    return () => window.clearTimeout(handle);
  }, [editingVoucher, voucherItems]);
  const nextLocalVoucherNumber = () => {
    const highest = vouchers.reduce((max, item) => {
      const parsed = parseVoucherSequenceNumber(getVoucherDisplayNumber(item) || item.voucherNumber);
      return parsed ? Math.max(max, parsed) : max;
    }, 0);
    return `V-${String(highest + 1).padStart(4, "0")}`;
  };
  const displayedNewVoucherNumber = editingVoucher
    ? customVoucherNumberEnabled && customVoucherNumber.trim()
      ? customVoucherNumber.trim()
      : getVoucherDisplayNumber(editingVoucher) || editingVoucher.voucherNumber
    : customVoucherNumberEnabled && customVoucherNumber.trim()
      ? customVoucherNumber.trim()
      : nextLocalVoucherNumber();
  const validateVoucherNumberDraft = useCallback(async (value: string) => {
    const trimmedValue = value.trim();
    if (!trimmedValue) return { status: "idle" as const, message: "" };
    const normalizedValue = normalizeVoucherNumber(trimmedValue);
    if (!normalizedValue) {
      return {
        status: "invalid" as const,
        message: t("expensesPage.voucherNumberFormatError"),
      };
    }
    const currentFarmId = getActiveFarmId() ?? undefined;
    const [cachedWorkspaceVouchers, pendingVoucherMutations] = await Promise.all([
      workspaceId ? offlineDb.vouchers.where("workspaceId").equals(workspaceId).toArray().then((rows) => getActiveVouchers(rows).filter((item) => item.farmId === currentFarmId)) : Promise.resolve([] as Voucher[]),
      workspaceId ? offlineDb.pendingMutations.where("workspaceId").equals(workspaceId).and((mutation) =>
        mutation.entity === "voucher"
        && mutation.operation !== "delete"
        && mutation.status !== "resolved"
        && mutation.status !== "discarded"
        && mutation.farmId === currentFarmId).toArray() : Promise.resolve([]),
    ]);
    const duplicateCachedVoucher = cachedWorkspaceVouchers.some((item) =>
      item.id !== editingVoucher?.id
      && (getVoucherDisplayNumber(item) || item.voucherNumber) === normalizedValue);
    const duplicatePendingVoucher = pendingVoucherMutations.some((mutation) => {
      const payload = mutation.payload as Partial<Voucher>;
      return payload.id !== editingVoucher?.id
        && (getVoucherDisplayNumber(payload as Record<string, unknown>) || payload.voucherNumber) === normalizedValue;
    });
    if (duplicateCachedVoucher || duplicatePendingVoucher) {
      return {
        status: "duplicate" as const,
        message: t("expensesPage.voucherNumberDuplicate", { number: normalizedValue }),
        normalized: normalizedValue,
      };
    }
    if (!navigator.onLine || !token || !workspaceId) {
      return {
        status: "offline" as const,
        message: t("expensesPage.voucherNumberValidatedOffline"),
        normalized: normalizedValue,
      };
    }
    try {
      const result = await validateVoucherNumber(token, workspaceId, { voucherNumber: normalizedValue, recordId: editingVoucher?.id, farmId: currentFarmId });
      if (!result.available) {
        return {
          status: "duplicate" as const,
          message: t("expensesPage.voucherNumberDuplicate", { number: result.voucherNumber }),
          normalized: result.voucherNumber,
          blockingVoucher: result.blockingVoucher
            ? {
              id: result.blockingVoucher.id,
              workspaceId: result.blockingVoucher.workspaceId,
              farmId: result.blockingVoucher.farmId,
              seasonId: result.blockingVoucher.seasonId,
              voucherNumber: result.blockingVoucher.voucherNumber,
              date: result.blockingVoucher.date,
              amount: result.blockingVoucher.amount,
              description: result.blockingVoucher.description,
              deletedAt: result.blockingVoucher.deletedAt,
              source: result.blockingVoucher.source,
              oldExpenseId: result.blockingVoucher.oldExpenseId,
            }
            : null,
        };
      }
      return {
        status: "valid" as const,
        message: "",
        normalized: result.voucherNumber,
      };
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        return {
          status: "duplicate" as const,
          message: error.message,
          normalized: normalizedValue,
        };
      }
      if (error instanceof ApiError && error.status === 400) {
        return {
          status: "invalid" as const,
          message: error.message,
          normalized: normalizedValue,
        };
      }
      return {
        status: "offline" as const,
        message: t("expensesPage.voucherNumberValidatedOffline"),
        normalized: normalizedValue,
      };
    }
  }, [editingVoucher?.id, t, token, workspaceId]);
  useEffect(() => {
    if (!customVoucherNumberEnabled) {
      setVoucherNumberValidation({ status: "idle", message: "" });
      return;
    }
    const trimmedValue = customVoucherNumber.trim();
    if (!trimmedValue) {
      setVoucherNumberValidation({ status: "idle", message: "" });
      return;
    }
    let cancelled = false;
    setVoucherNumberValidation((current) => ({ ...current, status: "checking", message: t("expensesPage.voucherNumberChecking") }));
    const handle = window.setTimeout(() => {
      void validateVoucherNumberDraft(trimmedValue).then((result) => {
        if (cancelled) return;
        setVoucherNumberValidation(result);
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [customVoucherNumber, customVoucherNumberEnabled, editingVoucher, t, validateVoucherNumberDraft]);
  const voucherNumberSaveBlocked = customVoucherNumberEnabled
    && (voucherNumberValidation.status === "checking" || voucherNumberValidation.status === "duplicate" || voucherNumberValidation.status === "invalid");
  const addReceiptFiles = (files: FileList | null) => {
    if (!files) return;
    setReceiptError("");
    const next: PendingReceipt[] = [];
    const imageQueue: File[] = [];
    for (const file of Array.from(files)) {
      if (!receiptTypes.has(file.type)) {
        setReceiptError(t("expensesPage.receiptTypeError"));
        continue;
      }
      if (file.size > receiptMaxSize) {
        setReceiptError(t("expensesPage.receiptSizeError"));
        continue;
      }
      if (file.type.startsWith("image/")) imageQueue.push(file);
      else next.push({ id: crypto.randomUUID(), file });
    }
    setPendingReceipts((current) => [...current, ...next]);
    if (imageQueue.length) {
      setReceiptCropQueue((current) => [...current, ...imageQueue.slice(1)]);
      if (!receiptCropTarget) setReceiptCropTarget(imageQueue[0]);
    }
  };
  const advanceReceiptCropQueue = (accepted?: PendingReceipt) => {
    if (accepted) {
      setPendingReceipts((current) => [...current, accepted]);
      showToast(accepted.cropMetadata?.skipped ? t("expensesPage.receiptAttached") : t("expensesPage.receiptCroppedAttached"));
    }
    setReceiptCropQueue((current) => {
      const [next, ...rest] = current;
      setReceiptCropTarget(next ?? null);
      return rest;
    });
  };
  const removePendingReceipt = (id: string) => {
    setPendingReceipts((current) => {
      const target = current.find((item) => item.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return current.filter((item) => item.id !== id);
    });
  };
  const uploadPendingReceipts = async (expenseId: string) => {
    if (!pendingReceipts.length) return;
    if (!navigator.onLine || !token) {
      showToast(t("expensesPage.receiptUploadRequiresInternet"));
      return;
    }
    for (const item of pendingReceipts) {
      await uploadExpenseAttachment(token, workspaceId, expenseId, {
        farmId,
        seasonId,
        fileName: item.file.name,
        fileType: item.file.type,
        fileSize: item.file.size,
        contentBase64: await fileToBase64(item.file),
        originalContentBase64: item.originalFile ? await fileToBase64(item.originalFile) : undefined,
        originalFileSize: item.originalFile?.size,
        cropMetadata: item.cropMetadata,
      });
    }
  };
  const loadVoucherAttachments = useCallback(async (voucher: Voucher | null) => {
    setDetailOcr(null);
    if (!voucher || !token || !workspaceId) { setDetailAttachments([]); return; }
    try {
      const response = await fetchExpenseAttachments(token, workspaceId, voucher.id);
      setDetailAttachments(response.attachments);
    } catch {
      setDetailAttachments([]);
    }
  }, [token, workspaceId]);

  const canCreateVouchers = Boolean(!sessionRefreshing && user && workspaceId && canCreate(user, "expenses", workspaceId));
  const canEditVouchers = Boolean(!sessionRefreshing && user && workspaceId && canEdit(user, "expenses", workspaceId));
  const canDeleteVouchers = Boolean(!sessionRefreshing && user && workspaceId && canDelete(user, "expenses", workspaceId));
  const canManage = Boolean(!sessionRefreshing && user && workspaceId && hasPermission(user, "MANAGE_EXPENSE_CATEGORIES", workspaceId));
  const addVoucherItem = useCallback(() => {
    const nextItem = newVoucherItemDraft();
    setVoucherItems((current) => [...current, nextItem]);
    window.setTimeout(() => {
      voucherItemCategoryRefs.current[nextItem.id]?.focus();
      voucherItemCategoryRefs.current[nextItem.id]?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 60);
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!(editingVoucher ? canEditVouchers : canCreateVouchers)) {
      showToast(t("common.viewOnlyAccess"));
      return;
    }
    if (!resolvedExpenseAccountId || isSyntheticLocalAccount(resolvedExpenseAccountId)) {
      showToast(t("expensesPage.selectRealPaymentAccount"));
      return;
    }
    const resolvedItems: VoucherItem[] = [];
    for (const item of voucherItems) {
      const category = categories.data?.categories.find((entry) => entry.id === item.categoryId);
      const subcategory = category?.subcategories.find((entry) => entry.id === item.subcategoryId);
      const parsedAmount = Number(item.amount);
      if (!category || !subcategory || !item.description.trim() || !Number.isFinite(parsedAmount) || parsedAmount <= 0) return;
      resolvedItems.push({
        id: item.id,
        categoryId: category.id,
        category: category.name,
        subcategoryId: subcategory.id,
        subcategory: subcategory.name,
        amount: parsedAmount,
        description: item.description.trim(),
        remarks: item.remarks.trim() || undefined,
        oldExpenseItemId: item.oldExpenseItemId,
      });
    }
    if (!resolvedItems.length) return;
    const primaryItem = resolvedItems[0];
    const totalAmount = resolvedItems.reduce((sum, item) => sum + item.amount, 0);
    const suggestedVoucherNumber = nextLocalVoucherNumber();
    const manualVoucherNumber = customVoucherNumberEnabled
      ? customVoucherNumber.trim()
      : editingVoucher
        ? getVoucherDisplayNumber(editingVoucher) || editingVoucher.voucherNumber
        : suggestedVoucherNumber;
    const validation = await validateVoucherNumberDraft(manualVoucherNumber || suggestedVoucherNumber);
    setVoucherNumberValidation(validation);
    if (validation.normalized && customVoucherNumberEnabled) setCustomVoucherNumber(validation.normalized);
    if (validation.status === "duplicate" || validation.status === "invalid") {
      showToast(validation.message);
      return;
    }
    const nextVoucherNumber = validation.normalized
      ?? normalizeVoucherNumber(manualVoucherNumber || suggestedVoucherNumber)
      ?? suggestedVoucherNumber;
    const existingDisplayedVoucherNumber = editingVoucher ? (getVoucherDisplayNumber(editingVoucher) || editingVoucher.voucherNumber) : "";
    const explicitVoucherNumberEdit = Boolean(editingVoucher && nextVoucherNumber !== existingDisplayedVoucherNumber);
    const record: Voucher = {
      ...(editingVoucher ?? makeLocalRecord()), voucherNumber: nextVoucherNumber, date,
      categoryId: primaryItem.categoryId,
      category: primaryItem.category,
      subcategoryId: primaryItem.subcategoryId ?? "",
      subcategory: primaryItem.subcategory ?? "",
      description: resolvedItems.length === 1 ? primaryItem.description : `${primaryItem.description} +${resolvedItems.length - 1} ${t("expensesPage.moreItems")}`,
      amount: totalAmount,
      accountId: resolvedExpenseAccountId,
      notes: notes.trim() || undefined,
      items: resolvedItems,
      allowVoucherNumberEdit: explicitVoucherNumberEdit || undefined,
      voucherNumberEdited: explicitVoucherNumberEdit ? true : (editingVoucher?.voucherNumberEdited ?? undefined),
    };
    await persistOperationalRecord("voucher", record);
    await uploadPendingReceipts(record.id);
    showToast(editingVoucher ? t("expensesPage.voucherUpdated") : t("expensesPage.voucherSaved"));
    setExpenseSessionDate(date);
    setExpenseSessionAccountId(resolvedExpenseAccountId);
    setEditingVoucher(null);
    resetForm({ preserveSessionDefaults: true });
    await refresh();
  };
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedVoucherSearch(voucherSearch.trim()), 275);
    return () => window.clearTimeout(timer);
  }, [voucherSearch]);
  const voucherSearchQuery = useQuery({
    queryKey: ["expense-search", workspaceId, farmId, seasonId, debouncedVoucherSearch, voucherFrom, voucherTo, voucherCategory, voucherSubcategory, voucherAccountId, showDeletedVouchers, showImportedVouchers],
    queryFn: () => searchExpenses(token!, workspaceId, {
      farmId: farmId!, seasonId: seasonId!, search: debouncedVoucherSearch || undefined, from: voucherFrom || undefined, to: voucherTo || undefined,
      category: voucherCategory || undefined, subcategory: voucherSubcategory || undefined, accountId: voucherAccountId || undefined,
      includeDeleted: showDeletedVouchers,
      includeImported: showImportedVouchers,
    }),
    enabled: Boolean(token && workspaceId && farmId && seasonId && navigator.onLine),
  });
  const accountById = useMemo(() => new Map(accounts.map((account) => [account.id, account.name])), [accounts]);
  const visibleVoucherSource = useMemo(() => getAllVouchers(vouchers, { includeDeleted: showDeletedVouchers }), [showDeletedVouchers, vouchers]);
  const voucherCategories = useMemo(() => [...new Set(visibleVoucherSource.flatMap((voucher) => voucherLinesFor(voucher).map((line) => line.category)).filter(Boolean))].sort(), [visibleVoucherSource, voucherLinesFor]);
  const voucherSubcategories = useMemo(() => [...new Set(visibleVoucherSource
    .flatMap((voucher) => voucherLinesFor(voucher))
    .filter((line) => !voucherCategory || line.category === voucherCategory)
    .map((line) => line.subcategory)
    .filter(Boolean))].sort(), [visibleVoucherSource, voucherCategory, voucherLinesFor]);
  function toVoucherRecord(item: Voucher | ExpenseSearchRecord): Voucher {
    if ("pendingSync" in item) return item;
    return {
      id: item.id,
      workspaceId: item.workspaceId,
      farmId: item.farmId,
      seasonId: item.seasonId,
      pendingSync: false,
      deletedAt: item.deletedAt ?? undefined,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      voucherNumber: item.voucherNumber,
      originalVoucherNumber: item.originalVoucherNumber,
      legacyVoucherNumber: item.legacyVoucherNumber,
      voucherNumberEdited: "voucherNumberEdited" in item ? item.voucherNumberEdited === true : undefined,
      date: item.date,
      category: item.category,
      categoryId: item.categoryId,
      subcategory: item.subcategory,
      subcategoryId: item.subcategoryId,
      description: item.description,
      amount: item.amount,
      accountId: item.accountId,
      notes: item.notes,
      items: Array.isArray(item.items)
        ? item.items.map((line, index) => ({
            id: typeof line.id === "string" ? line.id : `${item.id}:item:${index}`,
            category: typeof line.category === "string" ? line.category : item.category,
            categoryName: typeof line.categoryName === "string" ? line.categoryName : undefined,
            categoryId: typeof line.categoryId === "string" ? line.categoryId : item.categoryId,
            subcategory: typeof line.subcategory === "string" ? line.subcategory : item.subcategory,
            subcategoryName: typeof line.subcategoryName === "string" ? line.subcategoryName : undefined,
            subcategoryId: typeof line.subcategoryId === "string" ? line.subcategoryId : item.subcategoryId,
            amount: typeof line.amount === "number" ? line.amount : Number(line.amount ?? item.amount) || 0,
            description: typeof line.description === "string" ? line.description : item.description,
            remarks: typeof line.remarks === "string" ? line.remarks : undefined,
            oldExpenseItemId: typeof line.oldExpenseItemId === "string" || typeof line.oldExpenseItemId === "number" ? line.oldExpenseItemId : undefined,
          }))
        : undefined,
    };
  }
  const matchesVoucher = useCallback((item: Voucher | ExpenseSearchRecord) => {
    const accountName = accountById.get(item.accountId)
      ?? ("accountName" in item && typeof item.accountName === "string" ? item.accountName : "");
    const normalizedSearch = voucherSearch.trim().toLowerCase();
    const shortDate = item.date.length >= 10 ? `${item.date.slice(5, 7)}/${item.date.slice(8, 10)}` : item.date;
    const lines = voucherLinesFor(toVoucherRecord(item));
    return (!voucherFrom || item.date >= voucherFrom)
      && (!voucherTo || item.date <= voucherTo)
      && (!voucherCategory || lines.some((line) => line.category === voucherCategory))
      && (!voucherSubcategory || lines.some((line) => line.subcategory === voucherSubcategory))
      && (!voucherAccountId || item.accountId === voucherAccountId)
      && (!normalizedSearch || [
        getVoucherDisplayNumber(item) || item.voucherNumber, item.description, item.notes ?? "", item.category, item.subcategory, accountName,
        String(item.amount), item.date, shortDate,
        ...lines.flatMap((line) => [line.category, line.subcategory, line.description, line.remarks ?? "", String(line.amount)]),
      ].some((value) => value.toLowerCase().includes(normalizedSearch)));
  }, [accountById, voucherAccountId, voucherCategory, voucherFrom, voucherLinesFor, voucherSearch, voucherSubcategory, voucherTo]);
  const filteredVouchers = useMemo(() => {
    const serverRecords = voucherSearchQuery.data?.records ?? [];
    const merged = navigator.onLine && voucherSearchQuery.data
      ? (() => {
          const mergedMap = new Map<string, Voucher | ExpenseSearchRecord>(serverRecords.map((record) => [record.id, record]));
          vouchers.forEach((item) => {
            if (!showDeletedVouchers && getAllVouchers([item]).length === 0) return;
            const existing = mergedMap.get(item.id);
            if (!item.pendingSync) return;
            if (!existing || item.updatedAt > existing.updatedAt) mergedMap.set(item.id, item);
          });
          return [...mergedMap.values()];
        })()
      : visibleVoucherSource;
    return merged
      .filter((item) => getAllVouchers([item], { includeDeleted: showDeletedVouchers }).length > 0)
      .map((item) => toVoucherRecord(item))
      .filter((item) => matchesVoucher(item))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [matchesVoucher, showDeletedVouchers, visibleVoucherSource, voucherSearchQuery.data, vouchers]);
  const voucherLineItems = useMemo(() => filteredVouchers.flatMap((item) => voucherLinesFor(item)), [filteredVouchers, voucherLinesFor]);
  const total = filteredVouchers.reduce((sum, item) => sum + item.amount, 0);
  const grouped = [...voucherLineItems.reduce((map, item) => {
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
  );
  const clearFilters = () => {
    setVoucherSearch("");
    setDebouncedVoucherSearch("");
    setVoucherFrom("");
    setVoucherTo("");
    setVoucherCategory("");
    setVoucherSubcategory("");
    setVoucherAccountId("");
  };
  useEffect(() => {
    const recordId = searchParams.get("recordId");
    if (!recordId) return;
    const voucher = vouchers.find((item) => item.id === recordId);
    if (voucher && getAllVouchers([voucher], { includeDeleted: showDeletedVouchers }).length === 0) return;
    if (voucher) setSelectedVoucher(voucher);
  }, [searchParams, showDeletedVouchers, vouchers]);
  useEffect(() => {
    void loadVoucherAttachments(selectedVoucher);
  }, [loadVoucherAttachments, selectedVoucher]);
  const openReceipt = async (attachment: ExpenseAttachment) => {
    if (!token || !workspaceId || !selectedVoucher) return;
    try { await openExpenseAttachment(token, workspaceId, selectedVoucher.id, attachment); }
    catch (error) { showToast(error instanceof Error ? error.message : "Unable to open receipt attachment."); }
  };
  const openOriginalReceipt = async (attachment: ExpenseAttachment) => {
    if (!token || !workspaceId || !selectedVoucher) return;
    try { await openExpenseAttachment(token, workspaceId, selectedVoucher.id, attachment, "original"); }
    catch (error) { showToast(error instanceof Error ? error.message : "Unable to open original receipt."); }
  };
  const removeReceipt = async (attachment: ExpenseAttachment) => {
    if (!token || !workspaceId || !selectedVoucher || !window.confirm(t("expensesPage.deleteReceiptConfirm"))) return;
    setAttachmentBusy(true);
    try {
      await deleteExpenseAttachment(token, workspaceId, selectedVoucher.id, attachment.id);
      await loadVoucherAttachments(selectedVoucher);
    } finally {
      setAttachmentBusy(false);
    }
  };
  const applyOcrToVoucher = (result: ExpenseOcrSuggestion, voucher?: Voucher | null) => {
    if (voucher) openEdit(voucher);
    const fields = result.fields ?? {};
    if (fields.date) setDate(fields.date);
    const suggestedCategory = fields.suggestedCategory || result.lineItems.find((line) => line.suggestedCategory)?.suggestedCategory;
    const suggestedSubcategory = fields.suggestedSubcategory || result.lineItems.find((line) => line.suggestedSubcategory)?.suggestedSubcategory;
    const normalizedCategory = suggestedCategory?.trim().toLowerCase();
    const matchedCategory = normalizedCategory
      ? categories.data?.categories.find((item) => item.name.trim().toLowerCase() === normalizedCategory)
      : undefined;
    const normalizedSubcategory = suggestedSubcategory?.trim().toLowerCase();
    const matchedSubcategory = normalizedSubcategory && matchedCategory
      ? matchedCategory.subcategories.find((item) => item.name.trim().toLowerCase() === normalizedSubcategory)
      : undefined;
    if (result.lineItems.length) {
      setVoucherItems(result.lineItems.map((line, index) => {
        const lineCategory = line.suggestedCategory?.trim().toLowerCase();
        const category = lineCategory ? categories.data?.categories.find((item) => item.name.trim().toLowerCase() === lineCategory) : matchedCategory;
        const lineSubcategory = line.suggestedSubcategory?.trim().toLowerCase();
        const subcategory = lineSubcategory && category
          ? category.subcategories.find((item) => item.name.trim().toLowerCase() === lineSubcategory)
          : category?.id === matchedCategory?.id ? matchedSubcategory : undefined;
        return {
          id: crypto.randomUUID(),
          categoryId: category?.id ?? "",
          categorySearch: category?.name ?? line.suggestedCategory ?? fields.suggestedCategory ?? "",
          subcategoryId: subcategory?.id ?? "",
          subcategorySearch: subcategory?.name ?? line.suggestedSubcategory ?? fields.suggestedSubcategory ?? "",
          amount: line.amount !== undefined ? String(line.amount) : (index === 0 && fields.totalAmount !== undefined ? String(fields.totalAmount) : ""),
          description: line.name ?? "",
          remarks: "",
        };
      }));
    } else {
      setVoucherItems((current) => {
        const first = current[0] ?? newVoucherItemDraft();
        const nextFirst = {
          ...first,
          categoryId: matchedCategory?.id ?? first.categoryId,
          categorySearch: matchedCategory?.name ?? first.categorySearch,
          subcategoryId: matchedSubcategory?.id ?? first.subcategoryId,
          subcategorySearch: matchedSubcategory?.name ?? first.subcategorySearch,
          amount: fields.totalAmount !== undefined ? String(fields.totalAmount) : first.amount,
          description: fields.description ?? first.description,
        };
        return [nextFirst, ...current.slice(1)];
      });
    }
    const noteParts = [
      fields.supplier ? `${t("expensesPage.supplier")}: ${fields.supplier}` : "",
      fields.receiptNumber ? `${t("expensesPage.receiptNumber")}: ${fields.receiptNumber}` : "",
      fields.vatAmount !== undefined ? `${t("expensesPage.vat")}: ${fields.vatAmount}` : "",
      fields.paymentMethod ? `${t("expensesPage.paymentMethod")}: ${fields.paymentMethod}` : "",
    ].filter(Boolean);
    if (noteParts.length) setNotes((current) => current ? `${current}\n${noteParts.join(" · ")}` : noteParts.join(" · "));
    setSelectedVoucher(null);
    showToast(t("expensesPage.ocrSuggestionsApplied"));
  };
  const extractReceipt = async (attachment: ExpenseAttachment) => {
    if (!token || !workspaceId || !selectedVoucher) return;
    setAttachmentBusy(true); setDetailOcr(null);
    try {
      const result = await extractExpenseReceipt(token, workspaceId, attachment.id);
      setDetailOcr(result);
      showToast(result.message || (result.status === "success" ? t("expensesPage.ocrCompleteReview") : t("expensesPage.ocrFailed")));
      await loadVoucherAttachments(selectedVoucher);
    }
    catch { setDetailOcr({ confidence: "low", status: "failed", rawText: "", fields: {}, message: t("expensesPage.ocrFailed"), lineItems: [] }); }
    finally { setAttachmentBusy(false); }
  };
  const removeVoucher = async (voucher: Voucher) => {
    if (!canDeleteVouchers || !window.confirm(t("expensesPage.deleteVoucherConfirm", { number: getVoucherDisplayNumber(voucher) || voucher.voucherNumber }))) return;
    await deleteOperationalRecord("voucher", voucher);
    setSelectedVoucher(null);
    setSearchParams((current) => { current.delete("recordId"); return current; });
    showToast(t("expensesPage.deleteVoucherSuccess"));
    await refresh();
  };
  const addCustom = async (event: FormEvent) => {
    event.preventDefault();
    if (!token || !workspaceId || !customCategoryId || !customName.trim()) return;
    await createExpenseSubcategory(token, workspaceId, { categoryId: customCategoryId, name: customName.trim() });
    setCustomName(""); await categories.refetch();
  };
  const updateVoucherItem = (id: string, updater: (item: VoucherItemDraft) => VoucherItemDraft) => {
    setVoucherItems((current) => current.map((item) => item.id === id ? updater(item) : item));
  };
  const voucherGrandTotal = voucherItems.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);

  return (
    <>
      {(canCreateVouchers || (editingVoucher && canEditVouchers)) && <FormCard title={<span className="expense-voucher-form__card-title"><span>{editingVoucher ? t("expensesPage.editVoucherAction") : t("expensesPage.newVoucher")}</span><span className="expense-voucher-form__number-display"><span className="expense-voucher-form__number-label">{t("expensesPage.voucherLabel")}</span><span className="expense-voucher-form__number">{displayedNewVoucherNumber}</span>{!editingVoucher && <button
          type="button"
          className="expense-voucher-form__number-trigger"
          onClick={() => {
            setCustomVoucherNumberEnabled((current) => {
              if (current) {
                setCustomVoucherNumber("");
                return false;
              }
              setCustomVoucherNumber(nextLocalVoucherNumber());
              return true;
            });
          }}
          aria-label={customVoucherNumberEnabled ? t("expensesPage.cancelVoucherNumberEdit") : t("expensesPage.editVoucherNumber")}
          title={customVoucherNumberEnabled ? t("expensesPage.cancelVoucherNumberEdit") : t("expensesPage.editVoucherNumber")}
        >
          <Pencil size={14} />
        </button>}</span></span>}>
        {receiptCropTarget && <ReceiptCropReviewModal file={receiptCropTarget} onCancel={() => advanceReceiptCropQueue()} onAccept={advanceReceiptCropQueue} />}
        <form className="module-form inline-form expense-voucher-form" onSubmit={(event) => void submit(event)}>
          <div ref={voucherFormRef} />
          <div className="expense-voucher-form__top-row">
            <label>
              <span>{t("expensesPage.date")}</span>
              <input ref={voucherDateRef} type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            </label>
            <label>
              <span>{t("expensesPage.paymentAccount")}</span>
              <select value={resolvedExpenseAccountId} onChange={(event) => setAccountId(event.target.value)}>
                <option value="" disabled>{t("expensesPage.selectPaymentAccount")}</option>
                {selectableExpenseAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
              </select>
            </label>
          </div>
          {customVoucherNumberEnabled && <div className="expense-voucher-form__number-row">
              <label className="expense-voucher-form__number-edit">
                <span>{t("expensesPage.voucherNumberOverride")}</span>
                <div className="expense-voucher-form__number-edit-row">
                  <input
                    className={voucherNumberValidation.status === "duplicate" || voucherNumberValidation.status === "invalid" ? "expense-voucher-form__number-input is-invalid" : "expense-voucher-form__number-input"}
                    value={customVoucherNumber}
                    onChange={(event) => setCustomVoucherNumber(event.target.value.toUpperCase())}
                    onBlur={() => {
                      const normalized = normalizeVoucherNumber(customVoucherNumber);
                      if (normalized) setCustomVoucherNumber(normalized);
                    }}
                    placeholder={editingVoucher ? (getVoucherDisplayNumber(editingVoucher) || editingVoucher.voucherNumber) : nextLocalVoucherNumber()}
                    aria-invalid={voucherNumberValidation.status === "duplicate" || voucherNumberValidation.status === "invalid"}
                  />
                  {!editingVoucher && <button type="button" className="secondary-action expense-voucher-form__number-reset" onClick={() => { setCustomVoucherNumberEnabled(false); setCustomVoucherNumber(""); }}>
                    {t("expensesPage.useSuggestedVoucherNumber")}
                  </button>}
                </div>
                {voucherNumberValidation.message ? <small className={voucherNumberValidation.status === "duplicate" || voucherNumberValidation.status === "invalid" ? "expense-voucher-form__number-feedback is-error" : "expense-voucher-form__number-feedback"}>{voucherNumberValidation.message}</small> : null}
                {voucherNumberValidation.status === "duplicate" && voucherNumberValidation.blockingVoucher ? <div className="expense-voucher-form__blocking-voucher">
                  <small>{voucherNumberValidation.blockingVoucher.source === "imported" ? t("expensesPage.blockingImportedVoucher") : t("expensesPage.blockingVoucher")}: {voucherNumberValidation.blockingVoucher.voucherNumber} · {voucherNumberValidation.blockingVoucher.date} · {money(voucherNumberValidation.blockingVoucher.amount)}</small>
                  <small>{voucherNumberValidation.blockingVoucher.description || "-"}</small>
                  <small>ID: {voucherNumberValidation.blockingVoucher.id}</small>
                  <small>Workspace: {voucherNumberValidation.blockingVoucher.workspaceId} · Farm: {voucherNumberValidation.blockingVoucher.farmId ?? "-"} · Season: {voucherNumberValidation.blockingVoucher.seasonId ?? "-"}</small>
                  <small>{voucherNumberValidation.blockingVoucher.deletedAt ? `Deleted: ${voucherNumberValidation.blockingVoucher.deletedAt}` : "Deleted: active"}</small>
                  <button
                    type="button"
                    className="secondary-action"
                    onClick={() => {
                      const record = filteredVouchers.find((item) => item.id === voucherNumberValidation.blockingVoucher?.id);
                      if (record) {
                        setSelectedVoucher(toVoucherRecord(record));
                        return;
                      }
                      setVoucherSearch(voucherNumberValidation.blockingVoucher?.voucherNumber ?? "");
                      setDebouncedVoucherSearch(voucherNumberValidation.blockingVoucher?.voucherNumber ?? "");
                      showToast(t("expensesPage.blockingVoucherHiddenHint"));
                    }}
                  >
                    {t("expensesPage.openBlockingVoucher")}
                  </button>
                </div> : null}
              </label>
          </div>}
          {!selectableExpenseAccounts.length && <p className="expense-voucher-form__warning">{t("expensesPage.noRealPaymentAccounts")}</p>}
          <label className="expense-voucher-form__notes">
            <span>{t("expensesPage.notesOptional")}</span>
            <input value={notes} placeholder={t("expensesPage.notesOptional")} onChange={(event) => setNotes(event.target.value)} />
          </label>
          <div className="expense-voucher-items">
            <div className="expense-voucher-items__header">
              <strong>{t("expensesPage.voucherItems")}</strong>
            </div>
            <div className="expense-voucher-items__list">
              {voucherItems.map((item, index) => {
                const selectedCategory = categories.data?.categories.find((entry) => entry.id === item.categoryId);
                return (
                  <article className="expense-voucher-item" key={item.id}>
                    <div className="expense-voucher-item__top">
                      <strong>{t("expensesPage.itemNumber", { number: index + 1 })}</strong>
                      {voucherItems.length > 1 && <button className="expense-voucher-item__remove" type="button" onClick={() => setVoucherItems((current) => current.filter((entry) => entry.id !== item.id))}>{t("expensesPage.removeItem")}</button>}
                    </div>
                    <div className="expense-voucher-item__grid">
                      <label><span>{t("expensesPage.categoryRequired")}</span><SearchInput ref={(node) => { voucherItemCategoryRefs.current[item.id] = node; }} required list={`expense-category-options-${item.id}`} placeholder={t("expensesPage.selectCategory")} value={item.categorySearch} onChange={(value) => {
                        const next = categories.data?.categories.find((entry) => entry.name === value);
                        updateVoucherItem(item.id, (current) => ({ ...current, categorySearch: value, categoryId: next?.id ?? "", subcategoryId: "", subcategorySearch: "" }));
                      }} onClear={() => updateVoucherItem(item.id, (current) => ({ ...current, categoryId: "", categorySearch: "", subcategoryId: "", subcategorySearch: "" }))} /><datalist id={`expense-category-options-${item.id}`}>{categories.data?.categories.map((entry) => <option key={entry.id} value={entry.name} />)}</datalist></label>
                      <label><span>{t("expensesPage.subcategoryRequired")}</span><SearchInput required disabled={!item.categoryId} list={`expense-subcategory-options-${item.id}`} placeholder={t("expensesPage.selectSubcategory")} value={item.subcategorySearch} onChange={(value) => {
                        const next = selectedCategory?.subcategories.find((entry) => entry.name === value);
                        updateVoucherItem(item.id, (current) => ({ ...current, subcategorySearch: value, subcategoryId: next?.id ?? "" }));
                      }} onClear={() => updateVoucherItem(item.id, (current) => ({ ...current, subcategoryId: "", subcategorySearch: "" }))} /><datalist id={`expense-subcategory-options-${item.id}`}>{selectedCategory?.subcategories.map((entry) => <option key={entry.id} value={entry.name} />)}</datalist></label>
                      <label><span>{t("expensesPage.amount")}</span><input required min="0.01" step="0.01" type="number" value={item.amount} placeholder={t("expensesPage.amount")} onChange={(event) => updateVoucherItem(item.id, (current) => ({ ...current, amount: event.target.value }))} /></label>
                      <label className="expense-voucher-item__description"><span>{t("expensesPage.description")}</span><input required value={item.description} placeholder={t("expensesPage.description")} onChange={(event) => updateVoucherItem(item.id, (current) => ({ ...current, description: event.target.value }))} /></label>
                    </div>
                  </article>
                );
              })}
            </div>
            <button className="expense-voucher-items__add expense-voucher-items__add--bottom" type="button" onClick={addVoucherItem}>{t("expensesPage.addAnotherItem")}</button>
            <div className="expense-voucher-items__total">
              <span>{t("expensesPage.grandTotal")}</span>
              <strong>{money(voucherGrandTotal)}</strong>
            </div>
          </div>
          <ReceiptAttachmentPicker pending={pendingReceipts} onFiles={addReceiptFiles} onRemove={removePendingReceipt} />
          {receiptError && <p className="worker-action-error">{receiptError}</p>}
          <button type="submit" disabled={!selectableExpenseAccounts.length || voucherNumberSaveBlocked}>{editingVoucher ? t("expensesPage.updateVoucher") : t("expensesPage.saveVoucher")}</button>
          {editingVoucher && <button type="button" onClick={() => { pendingEditFocusRef.current = false; setEditingVoucher(null); resetForm(); }}>{t("expensesPage.cancelEdit")}</button>}
        </form>
      </FormCard>}
      <section className="record-panel expense-search-panel">
        <h2>{t("expensesPage.searchVouchers")}</h2>
        <div className="expense-search-filters">
          <SearchInput placeholder={t("expensesPage.searchPlaceholder")} value={voucherSearch} onChange={setVoucherSearch} />
          <fieldset className="expense-date-range">
            <legend>{t("expensesPage.dateRange")}</legend>
            <label className="expense-filter-field expense-date-field"><span><CalendarDays size={15} />{t("expensesPage.fromDate")}</span><input aria-label={t("expensesPage.fromDate")} type="date" value={voucherFrom} onChange={(event) => setVoucherFrom(event.target.value)} /></label>
            <label className="expense-filter-field expense-date-field"><span><CalendarDays size={15} />{t("expensesPage.toDate")}</span><input aria-label={t("expensesPage.toDate")} type="date" value={voucherTo} onChange={(event) => setVoucherTo(event.target.value)} /></label>
          </fieldset>
          <div className="expense-filter-grid">
            <label className="expense-filter-field"><span>{t("expensesPage.category")}</span><ClearableSelect aria-label={t("expensesPage.category")} value={voucherCategory} onChange={(value) => { setVoucherCategory(value); setVoucherSubcategory(""); }}>
              <option value="">{t("expensesPage.allCategories")}</option>{voucherCategories.map((item) => <option key={item} value={item}>{translateExpenseCategory(item)}</option>)}
            </ClearableSelect></label>
            <label className="expense-filter-field"><span>{t("expensesPage.subcategory")}</span><ClearableSelect aria-label={t("expensesPage.subcategory")} value={voucherSubcategory} onChange={setVoucherSubcategory}>
              <option value="">{t("expensesPage.allSubcategories")}</option>{[...new Set(voucherSubcategories)].map((name) => <option key={name} value={name}>{translateExpenseSubcategory(name)}</option>)}
            </ClearableSelect></label>
            <label className="expense-filter-field expense-filter-field--account"><span>{t("expensesPage.paymentAccount")}</span><ClearableSelect aria-label={t("expensesPage.paymentAccount")} value={voucherAccountId} onChange={setVoucherAccountId}>
              <option value="">{t("expensesPage.allAccounts")}</option>{accounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </ClearableSelect></label>
          </div>
        </div>
        <div className="expense-search-meta">
          <small>{hasActiveFilters ? t("expensesPage.showingCurrentFilters") : t("expensesPage.showingSeasonScope")}</small>
          <label className="partner-ledger-show-deleted"><input checked={showDeletedVouchers} type="checkbox" onChange={(event) => setShowDeletedVouchers(event.target.checked)} /> {t("expensesPage.showDeletedVouchers")}</label>
          <label className="partner-ledger-show-deleted"><input checked={showImportedVouchers} type="checkbox" onChange={(event) => setShowImportedVouchers(event.target.checked)} /> {t("expensesPage.showImportedVouchers")}</label>
          {hasActiveFilters && <button type="button" onClick={clearFilters}>{t("expensesPage.clearFilters")}</button>}
        </div>
        {voucherSearchQuery.isFetching && <small>{t("expensesPage.refreshingMatches")}</small>}
        {!navigator.onLine && <small>{t("expensesPage.offlineShowingCached")}</small>}
        {voucherSearchQuery.isError && <small>{t("expensesPage.apiRefreshFailed")}</small>}
      </section>
      <Summary value={money(total)} label={hasActiveFilters ? t("expensesPage.totalCurrentFilters") : t("expensesPage.totalCurrentSeason")} />
      <section className="record-panel"><h2>{t("expensesPage.expensesByCategory")}</h2>{!grouped.length ? <Empty>{t("expensesPage.noExpenseTotals")}</Empty> : <div className="expense-category-report">{grouped.map(([category, items]) => { const categoryTotal = [...items.values()].reduce((sum, amount) => sum + amount, 0); return <article key={category}><header><h3>{translateExpenseCategory(category)}</h3><strong>{money(categoryTotal)}</strong></header>{[...items].map(([subcategory, amount]) => <p key={subcategory}><span>{subcategory === "Miscellaneous" ? t("expensesPage.miscellaneous") : translateExpenseSubcategory(subcategory)}</span><strong>{money(amount)}</strong></p>)}<b>{t("expensesPage.categoryTotal")} <span>{money(categoryTotal)}</span></b></article>; })}</div>}</section>
      {canManage && <section className="record-panel"><h2>{t("expensesPage.customSubcategories")}</h2><form className="module-form compact-form" onSubmit={(event) => void addCustom(event)}><select required value={customCategoryId} onChange={(event) => setCustomCategoryId(event.target.value)}><option value="">{t("expensesPage.selectCategory")}</option>{categories.data?.categories.map((item) => <option key={item.id} value={item.id}>{translateExpenseCategory(item.name)}</option>)}</select><input required placeholder={t("expensesPage.newSubcategory")} value={customName} onChange={(event) => setCustomName(event.target.value)} /><button type="submit">{t("expensesPage.addSubcategory")}</button></form><div className="custom-subcategory-list">{categories.data?.categories.flatMap((item) => item.subcategories.filter((subcategory) => !subcategory.isSystem).map((subcategory) => <span key={subcategory.id}>{translateExpenseCategory(item.name)} / {subcategory.name}<button type="button" onClick={() => { const name = window.prompt(t("expensesPage.renameCustomSubcategory"), subcategory.name); if (token && name?.trim()) void updateExpenseSubcategory(token, workspaceId, subcategory.id, { name: name.trim() }).then(() => categories.refetch()); }}>{t("expensesPage.edit")}</button><button type="button" onClick={() => token && void updateExpenseSubcategory(token, workspaceId, subcategory.id, { active: false }).then(() => categories.refetch())}>{t("expensesPage.disable")}</button></span>))}</div></section>}
      <RecordTable
        empty={t("expensesPage.noExpensesFound")}
        rows={filteredVouchers.map((item) => {
          const lines = voucherLinesFor(item);
          const summary = lines.length > 1 ? `${translateExpenseCategory(lines[0].category)} / ${lines[0].subcategory ? translateExpenseSubcategory(lines[0].subcategory) : t("expensesPage.miscellaneous")} +${lines.length - 1} ${t("expensesPage.moreItems")}` : `${translateExpenseCategory(item.category)} / ${item.subcategory ? translateExpenseSubcategory(item.subcategory) : t("expensesPage.miscellaneous")}`;
          const description = lines.length > 1 ? `${lines[0].description} +${lines.length - 1} ${t("expensesPage.moreItems")}` : item.description;
          return [getVoucherDisplayNumber(item) || item.voucherNumber, item.date, summary, description, accountById.get(item.accountId) ?? t("expensesPage.unknownAccount"), money(item.amount)];
        })}
        actions={filteredVouchers.map((item) => <div className="record-list__actions" key={item.id}><button type="button" onClick={() => setSelectedVoucher(item)}>{t("expensesPage.viewDetails")}</button>{canEditVouchers && <button type="button" onClick={() => openEdit(item)}>{t("expensesPage.edit")}</button>}</div>)}
      />
      {selectedVoucher && <div className="worker-dialog-backdrop" role="presentation" onClick={() => setSelectedVoucher(null)}>
        <section className="worker-dialog worker-dialog--wide worker-dialog--record-detail expense-voucher-detail-dialog" role="dialog" aria-modal="true" aria-label={t("expensesPage.voucherDetails")} onClick={(event) => event.stopPropagation()}>
          <header className="worker-dialog__header worker-dialog__header--detail">
            <div className="worker-dialog__title-stack">
              <h2>{getVoucherDisplayNumber(selectedVoucher) || selectedVoucher.voucherNumber}</h2>
              <div className="worker-dialog__header-meta">
                <span>{shortDate(selectedVoucher.date)}</span>
              </div>
            </div>
            <div className="worker-dialog__header-actions">
              {canEditVouchers && <button className="worker-dialog__action worker-dialog__icon-button" type="button" aria-label={t("expensesPage.editVoucherAction")} title={t("expensesPage.editVoucherAction")} onClick={() => openEdit(selectedVoucher)}>
                <Pencil size={16} />
              </button>}
              <button className="worker-dialog__icon-button" type="button" aria-label={t("common.close")} onClick={() => setSelectedVoucher(null)}><X size={18} /></button>
            </div>
          </header>
          <div className="worker-dialog__body">
          <section className="worker-dialog__surface expense-voucher-detail__summary">
            <dl className="worker-stats worker-stats--summary">
              <div><dt>{t("expensesPage.date")}</dt><dd>{shortDate(selectedVoucher.date)}</dd></div>
              <div><dt>{t("expensesPage.amount")}</dt><dd>{money(selectedVoucher.amount)}</dd></div>
              <div><dt>{t("expensesPage.paymentSource")}</dt><dd>{accounts.find((item) => item.id === selectedVoucher.accountId)?.name ?? t("expensesPage.unknownAccount")}</dd></div>
              {selectedVoucher.notes ? <div><dt>{t("expensesPage.reference")}</dt><dd>{selectedVoucher.notes}</dd></div> : null}
            </dl>
          </section>
          <section className="expense-voucher-detail-items">
            <div className="worker-dialog__section-head">
              <h3>{t("expensesPage.voucherItems")}</h3>
              <span>{(selectedVoucher.items?.length ?? 0) || 1}</span>
            </div>
            {(selectedVoucher.items?.length ? selectedVoucher.items : [{
              id: `${selectedVoucher.id}:legacy`,
              category: selectedVoucher.category,
              subcategory: selectedVoucher.subcategory,
              amount: selectedVoucher.amount,
              description: selectedVoucher.description,
            }]).map((item, index) => (
              <article className="expense-voucher-detail-item" key={item.id}>
                <div className="expense-voucher-detail-item__header">
                  <strong>{translateExpenseCategory(item.category)} / {item.subcategory ? translateExpenseSubcategory(item.subcategory) : t("expensesPage.miscellaneous")}</strong>
                  <b>{money(item.amount)}</b>
                </div>
                <dl className="expense-voucher-detail-item__grid">
                  <div><dt>{t("expensesPage.itemNumber", { number: index + 1 })}</dt><dd>{t("expensesPage.itemNumber", { number: index + 1 })}</dd></div>
                  <div><dt>{t("expensesPage.subcategory")}</dt><dd>{item.subcategory ? translateExpenseSubcategory(item.subcategory) : t("expensesPage.miscellaneous")}</dd></div>
                  <div className="expense-voucher-detail-item__description"><dt>{t("expensesPage.description")}</dt><dd>{item.description || "-"}</dd></div>
                </dl>
                {"remarks" in item && item.remarks ? <small>{item.remarks}</small> : null}
              </article>
            ))}
          </section>
          <section className="expense-voucher-detail__total" aria-label={t("expensesPage.grandTotal")}>
            <span>{t("expensesPage.grandTotal")}</span>
            <strong>{money(selectedVoucher.amount)}</strong>
          </section>
          <ReceiptAttachmentList
            attachments={detailAttachments}
            ocrResult={detailOcr}
            extracting={attachmentBusy}
            onOpen={(item) => void openReceipt(item)}
            onOpenOriginal={(item) => void openOriginalReceipt(item)}
            onExtract={(item) => void extractReceipt(item)}
            onApplyOcr={(result) => applyOcrToVoucher(result, selectedVoucher)}
            onDelete={canDeleteVouchers && !attachmentBusy ? (item) => void removeReceipt(item) : undefined}
          />
          </div>
          <footer className="worker-dialog__footer">
            {canDeleteVouchers && <button className="worker-dialog__link worker-dialog__link--danger" type="button" onClick={() => void removeVoucher(selectedVoucher)}>{t("expensesPage.deleteVoucher")}</button>}
            <button className="worker-dialog__close" type="button" onClick={() => setSelectedVoucher(null)}>{t("expensesPage.close")}</button>
            {canEditVouchers && <button className="worker-dialog__primary" type="button" onClick={() => openEdit(selectedVoucher)}>{t("expensesPage.editVoucherAction")}</button>}
          </footer>
        </section>
      </div>}
    </>
  );
}

type DispatchItemDraft = Omit<DispatchItem, "cartons"> & { cartons: string };
const newDispatchItem = (): DispatchItemDraft => ({ id: crypto.randomUUID(), dateTypeId: "", cartons: "" });

const dispatchSerialFor = (dispatch: Pick<Dispatch, "serialNumber" | "dispatchNumber" | "id" | "date">) =>
  dispatch.serialNumber?.trim() || dispatch.dispatchNumber?.trim() || `DIS-${dispatch.date.replaceAll("-", "")}-${dispatch.id.slice(0, 3).toUpperCase()}`;

function nextDispatchSerial(records: Dispatch[], date: string, editing?: Dispatch | null) {
  if (editing?.serialNumber) return editing.serialNumber;
  const dateToken = date.replaceAll("-", "");
  const prefix = `DIS-${dateToken}-`;
  const used = records
    .filter((record) => record.id !== editing?.id)
    .map((record) => record.serialNumber ?? record.dispatchNumber ?? "")
    .filter((value) => value.startsWith(prefix))
    .map((value) => Number(value.slice(prefix.length)))
    .filter((value) => Number.isFinite(value));
  return `${prefix}${String(Math.max(0, ...used) + 1).padStart(3, "0")}`;
}

function DispatchModule() {
  const { t } = useTranslation();
  const { user, sessionRefreshing } = useAuth();
  const workspaceId = user?.workspaceId ?? "";
  const canCreateDispatch = Boolean(!sessionRefreshing && user && workspaceId && canCreate(user, "dispatch", workspaceId));
  const canEditDispatch = Boolean(!sessionRefreshing && user && workspaceId && canEdit(user, "dispatch", workspaceId));
  const canDeleteDispatch = Boolean(!sessionRefreshing && user && workspaceId && canDelete(user, "dispatch", workspaceId));
  const canManageMasters = canEditDispatch;
  const load = useCallback(async () => (await workspaceRecords(offlineDb.dispatches)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), []);
  const loadVehicles = useCallback(() => workspaceRecords(offlineDb.vehicles), []);
  const loadDateTypes = useCallback(() => workspaceRecords(offlineDb.dateTypes), []);
  const loadSales = useCallback(() => workspaceRecords(offlineDb.sales), []);
  const [records, refresh] = useData(load);
  const [vehicles, refreshVehicles] = useData(loadVehicles);
  const [dateTypes, refreshDateTypes] = useData(loadDateTypes);
  const [sales] = useData(loadSales);
  const [date, setDate] = useState(today());
  const [vehicleId, setVehicleId] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<DispatchItemDraft[]>([newDispatchItem()]);
  const [editing, setEditing] = useState<Dispatch | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [showVehicles, setShowVehicles] = useState(false);
  const [showDateTypes, setShowDateTypes] = useState(false);
  const [reportFrom, setReportFrom] = useState("");
  const [reportTo, setReportTo] = useState("");
  const activeVehicles = vehicles.filter((item) => item.active);
  const activeDateTypes = dateTypes.filter((item) => item.active);
  const vehicleName = (id?: string, fallback?: string) => vehicles.find((item) => item.id === id)?.number ?? fallback ?? "Unknown vehicle";
  const dateTypeName = (id: string, fallback?: string) => dateTypes.find((item) => item.id === id)?.name ?? fallback ?? "Unknown type";
  const filteredRecords = records.filter((item) => (!reportFrom || item.date >= reportFrom) && (!reportTo || item.date <= reportTo));
  const soldByItem = useMemo(() => soldQuantityByDispatchItem(sales), [sales]);
  const linkedSalesByDispatch = useMemo(() => sales.reduce((map, sale) => {
    if (sale.deletedAt || !sale.dispatchId) return map;
    map.set(sale.dispatchId, (map.get(sale.dispatchId) ?? 0) + 1);
    return map;
  }, new Map<string, number>()), [sales]);

  const reset = () => {
    setEditing(null); setDate(today()); setVehicleId(""); setNotes(""); setItems([newDispatchItem()]); setError("");
  };
  const edit = (record: Dispatch) => {
    setEditing(record); setDate(record.date); setVehicleId(record.vehicleId ?? ""); setNotes(record.notes ?? record.remarks ?? "");
    setItems(record.items?.map((item) => ({ ...item, cartons: String(item.cartons) })) ?? [newDispatchItem()]);
    setError("");
  };
  const updateItem = (id: string, field: "dateTypeId" | "cartons", value: string) => {
    setItems((current) => current.map((item) => item.id === id ? { ...item, [field]: value } : item));
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!(editing ? canEditDispatch : canCreateDispatch)) {
      setError(t("common.viewOnlyAccess"));
      return;
    }
    const selectedVehicle = activeVehicles.find((item) => item.id === vehicleId);
    const validItems = items.map((item) => ({ ...item, cartons: Number(item.cartons) }));
    if (!selectedVehicle) return setError(t("dispatchPage.activeVehicleRequired"));
    if (!validItems.length || validItems.some((item) => !item.dateTypeId || !Number.isInteger(item.cartons) || item.cartons <= 0)) return setError(t("dispatchPage.validItemsRequired"));
    if (new Set(validItems.map((item) => item.dateTypeId)).size !== validItems.length) return setError(t("dispatchPage.uniqueTypeRequired"));
    setSaving(true); setError("");
    try {
      const serialNumber = nextDispatchSerial(records, date, editing);
      const record: Dispatch = {
        ...(editing ?? makeLocalRecord()), date, vehicleId, serialNumber, notes: notes.trim(),
        destination: undefined,
        dispatchNumber: undefined,
        plotName: undefined,
        deliveryDate: undefined,
        status: undefined,
        unit: "cartons",
        remarks: notes.trim() || undefined,
        vehicleNumber: selectedVehicle.number, driverName: selectedVehicle.driverName,
        items: validItems.map((item) => ({ ...item, dateTypeName: dateTypeName(item.dateTypeId) })),
      };
      await persistOperationalRecord("dispatch", record);
      reset(); await refresh();
      window.dispatchEvent(new CustomEvent("muzare-toast", { detail: editing ? t("dispatchPage.dispatchUpdated") : t("dispatchPage.dispatchSaved") }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to save dispatch.");
    } finally {
      setSaving(false);
    }
  };
  const remove = async (record: Dispatch) => {
    if (!canDeleteDispatch) return;
    if (!window.confirm(t("dispatchPage.dispatchDeleteConfirm"))) return;
    await deleteOperationalRecord("dispatch", record); await refresh();
  };
  const vehicleTotals = new Map<string, number>();
  const typeTotals = new Map<string, number>();
  for (const record of filteredRecords) {
    vehicleTotals.set(vehicleName(record.vehicleId, record.vehicleNumber), (vehicleTotals.get(vehicleName(record.vehicleId, record.vehicleNumber)) ?? 0) + dispatchCartons(record));
    for (const item of record.items ?? []) typeTotals.set(dateTypeName(item.dateTypeId, item.dateTypeName), (typeTotals.get(dateTypeName(item.dateTypeId, item.dateTypeName)) ?? 0) + item.cartons);
    if (!record.items?.length && record.produceType) typeTotals.set(record.produceType, (typeTotals.get(record.produceType) ?? 0) + (record.cartons ?? 0));
  }
  const soldCartonsForDispatch = (record: Dispatch) =>
    (record.items ?? []).reduce((sum, item) => sum + (soldByItem.get(dispatchItemKey(record.id, item.id)) ?? 0), 0);
  const totalDispatched = filteredRecords.reduce((sum, item) => sum + dispatchCartons(item), 0);
  const totalSold = filteredRecords.reduce((sum, item) => sum + soldCartonsForDispatch(item), 0);
  const totalRemaining = Math.max(totalDispatched - totalSold, 0);

  return (
    <>
      <div className="dispatch-toolbar">
        <div><h2>{t("dispatchPage.title")}</h2><p>{t("dispatchPage.description")}</p></div>
        {canManageMasters && <div><button type="button" onClick={() => setShowVehicles(true)}>{t("dispatchPage.manageVehicles")}</button><button type="button" onClick={() => setShowDateTypes(true)}>{t("dispatchPage.manageTypes")}</button></div>}
      </div>
      {(canCreateDispatch || (editing && canEditDispatch)) && <FormCard title={editing ? t("dispatchPage.updateDispatch") : t("dispatchPage.newDispatch")}>
        <form className="module-form dispatch-form" onSubmit={(event) => void submit(event)}>
          <label><span>{t("dispatchPage.dispatchDate")}</span><input required type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
          <label><span>{t("dispatchPage.vehicle")}</span><ClearableSelect required value={vehicleId} onChange={setVehicleId}><option value="">{t("dispatchPage.selectActiveVehicle")}</option>{activeVehicles.map((item) => <option key={item.id} value={item.id}>{item.number}{item.driverName ? ` - ${item.driverName}` : ""}</option>)}</ClearableSelect></label>
          <label><span>{t("dispatchPage.notes")}</span><input placeholder={t("dispatchPage.optional")} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
          <div className="dispatch-items">
            <h3>{t("dispatchPage.dateTypesAndCartons")}</h3>
            {items.map((item, index) => <div className="dispatch-item-row" key={item.id}>
              <label><span>{t("dispatchPage.dateType", { index: index + 1 })}</span><ClearableSelect required value={item.dateTypeId} onChange={(value) => updateItem(item.id, "dateTypeId", value)}><option value="">{t("dispatchPage.selectType")}</option>{activeDateTypes.filter((type) => type.id === item.dateTypeId || !items.some((current) => current.id !== item.id && current.dateTypeId === type.id)).map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</ClearableSelect></label>
              <label><span>{t("dispatchPage.cartons")}</span><input required type="number" min="1" step="1" value={item.cartons} onChange={(event) => updateItem(item.id, "cartons", event.target.value)} /></label>
              {items.length > 1 && <button className="danger-link" type="button" onClick={() => setItems((current) => current.filter((currentItem) => currentItem.id !== item.id))}>{t("dispatchPage.remove")}</button>}
            </div>)}
            <button className="secondary-action" type="button" onClick={() => setItems((current) => [...current, newDispatchItem()])}>{t("dispatchPage.addItem")}</button>
            <strong>{t("dispatchPage.totalCartons", { count: items.reduce((sum, item) => sum + (Number(item.cartons) || 0), 0) })}</strong>
          </div>
          {error && <p className="form-error">{error}</p>}
          <div className="dispatch-form-actions"><button disabled={saving} type="submit">{saving ? t("advancesPage.saving") : editing ? t("dispatchPage.updateDispatch") : t("dispatchPage.newDispatch")}</button>{editing && <button className="secondary-action" type="button" onClick={reset}>{t("common.close")}</button>}</div>
        </form>
      </FormCard>}
      <div className="summary-grid">
        <Summary label={t("dispatchPage.totalDispatchedCartons")} value={String(totalDispatched)} />
        <Summary label={t("salesPage.soldCartons")} value={String(totalSold)} />
        <Summary label={t("salesPage.remainingCartons")} value={String(totalRemaining)} />
      </div>
      <section className="record-panel dispatch-summary">
        <h2>{t("dispatchPage.dispatchSummary")}</h2>
        <div className="dispatch-summary__filters"><label><span>{t("reports.dateFrom")}</span><input type="date" value={reportFrom} onChange={(event) => setReportFrom(event.target.value)} /></label><label><span>{t("reports.dateTo")}</span><input type="date" value={reportTo} onChange={(event) => setReportTo(event.target.value)} /></label></div>
        <div className="dispatch-summary__groups"><div><h3>{t("dispatchPage.byVehicle")}</h3>{[...vehicleTotals].map(([name, total]) => <p key={name}><span>{name}</span><strong>{total} {t("dispatchPage.cartons")}</strong></p>)}</div><div><h3>{t("dispatchPage.byType")}</h3>{[...typeTotals].map(([name, total]) => <p key={name}><span>{name}</span><strong>{total} {t("dispatchPage.cartons")}</strong></p>)}</div></div>
      </section>
      <section className="record-panel"><h2>{t("dispatchPage.dispatchRecords")}</h2>{!filteredRecords.length ? <Empty>{t("dispatchPage.noDispatches")}</Empty> : <div className="dispatch-list">{filteredRecords.map((record) => {
        const soldCartons = soldCartonsForDispatch(record);
        const remainingCartons = Math.max(dispatchCartons(record) - soldCartons, 0);
        const linkedSales = linkedSalesByDispatch.get(record.id) ?? 0;
        const typeCount = record.items?.length ?? (record.produceType ? 1 : 0);
        return <article key={record.id}><header><div><strong>{dispatchSerialFor(record)}</strong><h3>{record.vehicleNumber ?? vehicleName(record.vehicleId)}</h3><p>{record.date} · {t("dispatchPage.typeCount", { count: typeCount })}</p></div><b>{dispatchCartons(record)} {t("dispatchPage.cartons")}</b></header><div className="dispatch-breakdown">{record.items?.map((item) => {
          const sold = soldByItem.get(dispatchItemKey(record.id, item.id)) ?? 0;
          const remaining = Math.max(item.cartons - sold, 0);
          return <span key={item.id}>{dateTypeName(item.dateTypeId, item.dateTypeName)}: {item.cartons} | {t("salesPage.soldCartons")} {sold} | {t("salesPage.remainingCartons")} {remaining}</span>;
        }) ?? <span>{record.produceType}: {record.cartons}</span>}</div><p className="dispatch-linked-summary">{t("salesPage.soldCartons")} {soldCartons} | {t("salesPage.remainingCartons")} {remainingCartons} | {t("dispatchPage.linkedSales")} {linkedSales}</p><footer>{canEditDispatch && <button type="button" onClick={() => edit(record)}>{t("common.view")}</button>}{canDeleteDispatch && <button className="danger-link" type="button" onClick={() => void remove(record)}>{t("dispatchPage.delete")}</button>}</footer></article>;
      })}</div>}</section>
      {showVehicles && canManageMasters && <DispatchVehicleManager vehicles={vehicles} dispatches={records} onClose={() => setShowVehicles(false)} onRefresh={refreshVehicles} />}
      {showDateTypes && canManageMasters && <DispatchDateTypeManager dateTypes={dateTypes} dispatches={records} onClose={() => setShowDateTypes(false)} onRefresh={refreshDateTypes} />}
    </>
  );
}

function DispatchVehicleManager({ vehicles, dispatches, onClose, onRefresh }: { vehicles: Vehicle[]; dispatches: Dispatch[]; onClose: () => void; onRefresh: () => Promise<void> }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<Vehicle | null>(null);
  const [number, setNumber] = useState("");
  const [driverName, setDriverName] = useState("");
  const [driverPhone, setDriverPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [active, setActive] = useState(true);
  const [error, setError] = useState("");
  const reset = () => { setEditing(null); setNumber(""); setDriverName(""); setDriverPhone(""); setNotes(""); setActive(true); setError(""); };
  const edit = (item: Vehicle) => { setEditing(item); setNumber(item.number); setDriverName(item.driverName ?? ""); setDriverPhone(item.driverPhone ?? ""); setNotes(item.notes ?? ""); setActive(item.active); setError(""); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (vehicles.some((item) => item.id !== editing?.id && item.number.trim().toLowerCase() === number.trim().toLowerCase())) return setError(t("dispatchPage.vehicleExists"));
    await persistOperationalRecord("vehicle", { ...(editing ?? makeLocalRecord()), number: number.trim(), driverName: driverName.trim(), driverPhone: driverPhone.trim(), notes: notes.trim(), active });
    reset(); await onRefresh();
  };
  const remove = async (item: Vehicle) => {
    if (dispatches.some((dispatch) => dispatch.vehicleId === item.id)) return setError(t("dispatchPage.vehicleDeleteBlocked"));
    if (window.confirm(t("dispatchPage.deleteVehicleConfirm", { number: item.number }))) { await deleteOperationalRecord("vehicle", item); await onRefresh(); }
  };
  const toggleActive = async (item: Vehicle) => {
    await persistOperationalRecord("vehicle", { ...item, active: !item.active });
    await onRefresh();
  };
  return (
    <div className="worker-dialog-backdrop" role="presentation" onClick={onClose}>
      <section className="worker-dialog dispatch-master-dialog" role="dialog" aria-modal="true" aria-label={t("dispatchPage.manageVehicles")} onClick={(event) => event.stopPropagation()}>
        <header className="worker-dialog__header">
          <h2>{t("dispatchPage.manageVehicles")}</h2>
          <button type="button" onClick={onClose} aria-label={t("common.close")}><X size={18} /></button>
        </header>
        <div className="worker-dialog__body">
          <form id="dispatch-vehicle-form" className="module-form dispatch-master-form" onSubmit={(event) => void submit(event)}>
            <label><span>{t("dispatchPage.vehicleNameNumber")}</span><input required value={number} onChange={(event) => setNumber(event.target.value)} /></label>
            <label><span>{t("dispatchPage.driverName")}</span><input value={driverName} onChange={(event) => setDriverName(event.target.value)} /></label>
            <label><span>{t("dispatchPage.driverPhone")}</span><input value={driverPhone} onChange={(event) => setDriverPhone(event.target.value)} /></label>
            <label><span>{t("dispatchPage.notes")}</span><input value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
            <label className="checkbox-row"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /> {t("dispatchPage.activeVehicle")}</label>
            {error && <p className="form-error">{error}</p>}
          </form>
          <div className="master-list">
            {vehicles.map((item) => (
              <article key={item.id}>
                <div>
                  <strong>{item.number}</strong>
                  <p>{item.driverName || t("dispatchPage.noDriver")}{item.driverPhone ? ` | ${item.driverPhone}` : ""}</p>
                  <small>{item.active ? t("common.active") : t("common.inactive")}</small>
                </div>
                <div>
                  <button type="button" onClick={() => edit(item)}>{t("dispatchPage.update")}</button>
                  <button type="button" onClick={() => void toggleActive(item)}>{item.active ? t("common.inactive") : t("common.active")}</button>
                  <button className="danger-link" type="button" onClick={() => void remove(item)}>{t("dispatchPage.delete")}</button>
                </div>
              </article>
            ))}
          </div>
        </div>
        <footer className="worker-dialog__footer">
          <button className="secondary-action" type="button" onClick={reset}>{t("dispatchPage.cancel")}</button>
          <button type="submit" form="dispatch-vehicle-form">{editing ? t("dispatchPage.updateVehicle") : t("dispatchPage.saveVehicle")}</button>
        </footer>
      </section>
    </div>
  );
}

function DispatchDateTypeManager({ dateTypes, dispatches, onClose, onRefresh }: { dateTypes: DateType[]; dispatches: Dispatch[]; onClose: () => void; onRefresh: () => Promise<void> }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<DateType | null>(null);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [active, setActive] = useState(true);
  const [error, setError] = useState("");
  const reset = () => { setEditing(null); setName(""); setNotes(""); setActive(true); setError(""); };
  const edit = (item: DateType) => { setEditing(item); setName(item.name); setNotes(item.notes ?? ""); setActive(item.active); setError(""); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (dateTypes.some((item) => item.id !== editing?.id && item.name.trim().toLowerCase() === name.trim().toLowerCase())) return setError(t("dispatchPage.dateTypeExists"));
    await persistOperationalRecord("dateType", { ...(editing ?? makeLocalRecord()), name: name.trim(), notes: notes.trim(), active });
    reset(); await onRefresh();
  };
  const remove = async (item: DateType) => {
    if (dispatches.some((dispatch) => dispatch.items?.some((entry) => entry.dateTypeId === item.id))) return setError(t("dispatchPage.dateTypeDeleteBlocked"));
    if (window.confirm(t("dispatchPage.deleteDateTypeConfirm", { name: item.name }))) { await deleteOperationalRecord("dateType", item); await onRefresh(); }
  };
  const toggleActive = async (item: DateType) => {
    await persistOperationalRecord("dateType", { ...item, active: !item.active });
    await onRefresh();
  };
  return (
    <div className="worker-dialog-backdrop" role="presentation" onClick={onClose}>
      <section className="worker-dialog dispatch-master-dialog" role="dialog" aria-modal="true" aria-label={t("dispatchPage.manageTypes")} onClick={(event) => event.stopPropagation()}>
        <header className="worker-dialog__header">
          <h2>{t("dispatchPage.manageTypes")}</h2>
          <button type="button" onClick={onClose} aria-label={t("common.close")}><X size={18} /></button>
        </header>
        <div className="worker-dialog__body">
          <form id="dispatch-date-type-form" className="module-form dispatch-master-form" onSubmit={(event) => void submit(event)}>
            <label><span>{t("dispatchPage.dateTypeName")}</span><input required value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label><span>{t("dispatchPage.notesDescription")}</span><input value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
            <label className="checkbox-row"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /> {t("dispatchPage.activeType")}</label>
            {error && <p className="form-error">{error}</p>}
          </form>
          <div className="master-list">
            {dateTypes.map((item) => (
              <article key={item.id}>
                <div>
                  <strong>{item.name}</strong>
                  {item.notes && <p>{item.notes}</p>}
                  <small>{item.active ? t("common.active") : t("common.inactive")}</small>
                </div>
                <div>
                  <button type="button" onClick={() => edit(item)}>{t("dispatchPage.update")}</button>
                  <button type="button" onClick={() => void toggleActive(item)}>{item.active ? t("common.inactive") : t("dispatchPage.enable")}</button>
                  <button className="danger-link" type="button" onClick={() => void remove(item)}>{t("dispatchPage.delete")}</button>
                </div>
              </article>
            ))}
          </div>
        </div>
        <footer className="worker-dialog__footer">
          <button className="secondary-action" type="button" onClick={reset}>{t("dispatchPage.cancel")}</button>
          <button type="submit" form="dispatch-date-type-form">{editing ? t("dispatchPage.updateType") : t("dispatchPage.saveDateType")}</button>
        </footer>
      </section>
    </div>
  );
}

function SalesModule() {
  const { t } = useTranslation();
  const { user, sessionRefreshing } = useAuth();
  const workspaceId = user?.workspaceId ?? "";
  const canCreateSales = Boolean(!sessionRefreshing && user && workspaceId && canCreate(user, "sales", workspaceId));
  const canEditSales = Boolean(!sessionRefreshing && user && workspaceId && canEdit(user, "sales", workspaceId));
  const canDeleteSales = Boolean(!sessionRefreshing && user && workspaceId && canDelete(user, "sales", workspaceId));
  const [searchParams, setSearchParams] = useSearchParams();
  const load = useCallback(async () => (await workspaceRecords(offlineDb.sales)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), []);
  const loadAccounts = useCallback(() => workspaceRecords(offlineDb.accounts, { includeImportedAcrossSeasons: true }), []);
  const loadDispatches = useCallback(async () => (await workspaceRecords(offlineDb.dispatches)).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)), []);
  const loadVehicles = useCallback(() => workspaceRecords(offlineDb.vehicles), []);
  const loadDateTypes = useCallback(() => workspaceRecords(offlineDb.dateTypes), []);
  const [sales, refresh] = useData(load);
  const [accounts] = useData(loadAccounts, ensureLocalAccounts);
  const [dispatches] = useData(loadDispatches);
  const [vehicles] = useData(loadVehicles);
  const [dateTypes] = useData(loadDateTypes);
  const [saleType, setSaleType] = useState<NonNullable<Sale["saleType"]>>("dispatch_sale");
  const [date, setDate] = useState(today());
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [buyerName, setBuyerName] = useState("");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [paymentDate, setPaymentDate] = useState(today());
  const [quantity, setQuantity] = useState("");
  const [unitPrice, setUnitPrice] = useState("");
  const [accountId, setAccountId] = useState("");
  const [remarks, setRemarks] = useState("");
  const [directDateTypeId, setDirectDateTypeId] = useState("");
  const [directProduceType, setDirectProduceType] = useState("");
  const [dispatchSearch, setDispatchSearch] = useState("");
  const [selectedDispatchKey, setSelectedDispatchKey] = useState("");
  const [error, setError] = useState("");
  const [selectedSale, setSelectedSale] = useState<Sale | null>(null);
  const [salePendingDelete, setSalePendingDelete] = useState<Sale | null>(null);
  const [editingSale, setEditingSale] = useState<Sale | null>(null);
  const vehicleLabel = useCallback((dispatch: Dispatch) => vehicles.find((item) => item.id === dispatch.vehicleId)?.number ?? dispatch.vehicleNumber ?? "Unknown vehicle", [vehicles]);
  const availability = useMemo(() => buildDispatchAvailability(dispatches, sales, dateTypes, vehicleLabel), [dateTypes, dispatches, sales, vehicleLabel]);
  const activeDateTypes = useMemo(() => dateTypes.filter((item) => item.active !== false), [dateTypes]);
  const editingDispatchKey = editingSale?.dispatchId && editingSale?.dispatchItemId ? dispatchItemKey(editingSale.dispatchId, editingSale.dispatchItemId) : "";
  const filteredAvailability = useMemo(() => availability
    .filter((item) => item.remainingCartons > 0 || dispatchItemKey(item.dispatch.id, item.itemId) === editingDispatchKey)
    .filter((item) => !dispatchSearch.trim() || item.searchText.includes(dispatchSearch.trim().toLowerCase())), [availability, dispatchSearch, editingDispatchKey]);
  const selectedDispatch = useMemo(() => availability.find((item) => dispatchItemKey(item.dispatch.id, item.itemId) === selectedDispatchKey) ?? null, [availability, selectedDispatchKey]);
  const selectedDirectType = useMemo(() => activeDateTypes.find((item) => item.id === directDateTypeId) ?? null, [activeDateTypes, directDateTypeId]);
  const currentSaleType = saleType;
  const selectedDispatchMax = selectedDispatch
    ? selectedDispatch.remainingCartons + (editingDispatchKey === selectedDispatchKey ? Number(editingSale?.quantity ?? 0) : 0)
    : undefined;
  const totalAmount = (Number(quantity) || 0) * (Number(unitPrice) || 0);
  const canSave = Boolean(accountId || accounts[0]?.id);
  const saleTypeLabel = (sale: Pick<Sale, "saleType" | "dispatchId">) => translateSaleType(resolveSaleType(sale));
  const resetForm = useCallback(() => {
    setEditingSale(null);
    setSaleType("dispatch_sale");
    setDate(today());
    setInvoiceNumber("");
    setBuyerName("");
    setDeliveryDate("");
    setPaymentDate(today());
    setQuantity("");
    setUnitPrice("");
    setAccountId(accounts[0]?.id ?? "");
    setRemarks("");
    setDirectDateTypeId("");
    setDirectProduceType("");
    setDispatchSearch("");
    setSelectedDispatchKey("");
    setError("");
  }, [accounts]);
  const editSale = useCallback((sale: Sale) => {
    setSelectedSale(null);
    setEditingSale(sale);
    setSaleType(resolveSaleType(sale));
    setDate(sale.date);
    setInvoiceNumber(sale.invoiceNumber ?? "");
    setBuyerName(sale.buyerName ?? "");
    setDeliveryDate(sale.deliveryDate ?? "");
    setPaymentDate(sale.paymentDate ?? today());
    setQuantity(String(sale.quantity));
    setUnitPrice(String(sale.unitPrice));
    setAccountId(sale.accountId ?? accounts[0]?.id ?? "");
    setRemarks(sale.remarks ?? "");
    setDirectDateTypeId(sale.dateTypeId ?? "");
    setDirectProduceType(sale.produceType ?? "");
    setDispatchSearch("");
    setSelectedDispatchKey(dispatchItemKey(sale.dispatchId, sale.dispatchItemId));
    setError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [accounts]);
  const removeSale = useCallback(async (sale: Sale) => {
    await deleteOperationalRecord("sale", sale);
    setSelectedSale((current) => current?.id === sale.id ? null : current);
    setSalePendingDelete((current) => current?.id === sale.id ? null : current);
    setEditingSale((current) => current?.id === sale.id ? null : current);
    await refresh();
    window.dispatchEvent(new CustomEvent("muzare-toast", { detail: t("salesPage.saleDeleted") }));
  }, [refresh, t]);
  useEffect(() => {
    const recordId = searchParams.get("recordId");
    const mode = searchParams.get("mode");
    if (!recordId) return;
    const sale = sales.find((item) => item.id === recordId) ?? null;
    if (!sale) return;
    if (mode === "edit") editSale(sale);
    else setSelectedSale(sale);
    setSearchParams((current) => {
      current.delete("recordId");
      current.delete("mode");
      return current;
    }, { replace: true });
  }, [editSale, sales, searchParams, setSearchParams]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!(editingSale ? canEditSales : canCreateSales)) {
      setError(t("common.viewOnlyAccess"));
      return;
    }
    const quantityValue = Number(quantity);
    const unitPriceValue = Number(unitPrice);
    if (!quantityValue || quantityValue <= 0) return setError(t("salesPage.validQuantity"));
    if (!unitPriceValue || unitPriceValue < 0) return setError(t("salesPage.validUnitPrice"));
    if (!canSave) return setError(t("salesPage.selectAccountError"));
    if (currentSaleType === "dispatch_sale") {
      if (!selectedDispatch) return setError(t("salesPage.selectDispatchError"));
      if (date < selectedDispatch.dispatch.date) return setError(t("salesPage.dateEarlierThanDispatch"));
      if (quantityValue > (selectedDispatchMax ?? 0)) return setError(t("salesPage.quantityExceeds"));
    }
    const directProduct = selectedDirectType?.name ?? directProduceType.trim();
    if (currentSaleType === "farm_direct_sale" && !directProduct) return setError(t("salesPage.selectOrEnterProduct"));
    const record: Sale = {
      ...(editingSale ?? makeLocalRecord()),
      saleType: currentSaleType,
      date,
      invoiceNumber: invoiceNumber.trim() || undefined,
      buyerName: buyerName.trim() || undefined,
      produceType: currentSaleType === "dispatch_sale" ? (selectedDispatch?.dateTypeName ?? "") : directProduct,
      quantity: quantityValue,
      unitPrice: unitPriceValue,
      amount: quantityValue * unitPriceValue,
      accountId: accountId || accounts[0]?.id || "",
      dispatchId: currentSaleType === "dispatch_sale" ? selectedDispatch?.dispatch.id : undefined,
      dispatchItemId: currentSaleType === "dispatch_sale" ? selectedDispatch?.itemId : undefined,
      dispatchDate: currentSaleType === "dispatch_sale" ? selectedDispatch?.dispatch.date : undefined,
      deliveryDate: deliveryDate || undefined,
      vehicleId: currentSaleType === "dispatch_sale" ? selectedDispatch?.dispatch.vehicleId : undefined,
      vehicleNumber: currentSaleType === "dispatch_sale" ? selectedDispatch?.vehicleLabel : undefined,
      dateTypeId: currentSaleType === "dispatch_sale" ? selectedDispatch?.dateTypeId : (selectedDirectType?.id ?? undefined),
      dateTypeName: currentSaleType === "dispatch_sale" ? selectedDispatch?.dateTypeName : (selectedDirectType?.name ?? undefined),
      paymentStatus: "paid",
      paymentDate,
      paymentReceived: quantityValue * unitPriceValue,
      plotName: currentSaleType === "dispatch_sale" ? selectedDispatch?.dispatch.plotName : undefined,
      unit: "cartons",
      remarks: remarks.trim() || undefined,
    };
    await persistOperationalRecord("sale", record);
    resetForm();
    await refresh();
    window.dispatchEvent(new CustomEvent("muzare-toast", { detail: editingSale ? t("salesPage.saleUpdated") : t("salesPage.saleRecorded") }));
  };

  return (
    <>
      {(canCreateSales || (editingSale && canEditSales)) && <FormCard title={t("salesPage.title")}>
        <form className="module-form sales-form" onSubmit={(event) => void submit(event)}>
          <div className="sales-type-toggle">
            <button className={currentSaleType === "dispatch_sale" ? "is-active" : ""} type="button" onClick={() => { setSaleType("dispatch_sale"); setError(""); }}>
              {t("salesPage.fromDispatch")}
            </button>
            <button className={currentSaleType === "farm_direct_sale" ? "is-active" : ""} type="button" onClick={() => { setSaleType("farm_direct_sale"); setSelectedDispatchKey(""); setError(""); }}>
              {t("salesPage.directFarmSale")}
            </button>
          </div>
          <label><span>{t("reportsPage.saleDate")}</span><input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
          <label><span>{t("salesPage.invoiceSerial")}</span><input placeholder={t("dispatchPage.optional")} value={invoiceNumber} onChange={(event) => setInvoiceNumber(event.target.value)} /></label>
          <label><span>{t("salesPage.buyerCustomer")}</span><input placeholder={t("dispatchPage.optional")} value={buyerName} onChange={(event) => setBuyerName(event.target.value)} /></label>
          <label><span>{t("reportsPage.deliveryDate")}</span><input type="date" value={deliveryDate} onChange={(event) => setDeliveryDate(event.target.value)} /></label>
          {currentSaleType === "dispatch_sale"
            ? <div className="sales-dispatch-picker">
              <div className="sales-dispatch-picker__header">
                <label><span>{t("salesPage.dispatchRecord")}</span></label>
                <span>{t("salesPage.availableCount", { count: filteredAvailability.length })}</span>
              </div>
              <SearchInput placeholder={t("salesPage.searchDispatch")} value={dispatchSearch} onChange={setDispatchSearch} onClear={() => setDispatchSearch("")} />
              {selectedDispatch ? <div className="sales-selected-dispatch">
                <strong>{selectedDispatch.dateTypeName}</strong>
                <span>{selectedDispatch.dispatch.date} | {selectedDispatch.vehicleLabel}</span>
                <span>{t("salesPage.remainingCartons")} {selectedDispatchMax ?? selectedDispatch.remainingCartons}</span>
              </div> : null}
              <div className="dispatch-list sales-availability-list">
                {filteredAvailability.length ? filteredAvailability.map((item) => {
                  const selected = selectedDispatchKey === dispatchItemKey(item.dispatch.id, item.itemId);
                  const availableCartons = item.remainingCartons + (editingDispatchKey === dispatchItemKey(item.dispatch.id, item.itemId) ? Number(editingSale?.quantity ?? 0) : 0);
                  return <article className={selected ? "is-selected" : ""} key={dispatchItemKey(item.dispatch.id, item.itemId)}>
                    <header>
                      <div>
                        <strong>{item.dispatch.date}</strong>
                        <h3>{item.dateTypeName}</h3>
                        <p>{item.vehicleLabel}</p>
                      </div>
                      <b>{availableCartons} {t("salesPage.remainingCartons").toLowerCase()}</b>
                    </header>
                    <p className="dispatch-linked-summary">{t("systemValues.dispatchStatuses.dispatched")} {item.dispatchedCartons} | {t("salesPage.soldCartons")} {item.soldCartons} | {t("salesPage.remainingCartons")} {availableCartons}</p>
                    <footer>{canCreateSales && <button type="button" onClick={() => setSelectedDispatchKey(dispatchItemKey(item.dispatch.id, item.itemId))}>{t("salesPage.selectDispatch")}</button>}</footer>
                  </article>;
                }) : <Empty>{t("salesPage.noAvailableDispatch")}</Empty>}
              </div>
            </div>
            : activeDateTypes.length
              ? <label><span>{t("reportsPage.productVariety")}</span><ClearableSelect value={directDateTypeId} onChange={setDirectDateTypeId}>
                <option value="">{t("salesPage.selectProductVariety")}</option>
                {activeDateTypes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </ClearableSelect></label>
              : <label><span>{t("reportsPage.productVariety")}</span><input required placeholder={t("salesPage.enterProductVariety")} value={directProduceType} onChange={(event) => setDirectProduceType(event.target.value)} /></label>}
          <label><span>{t("salesPage.cartonsSold")}</span><input required type="number" min="1" max={currentSaleType === "dispatch_sale" ? selectedDispatchMax : undefined} placeholder={t("reportsPage.quantity")} value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
          <label><span>{t("salesPage.ratePrice")}</span><input required type="number" min="0" step="0.01" placeholder={t("reportsPage.rate")} value={unitPrice} onChange={(event) => setUnitPrice(event.target.value)} /></label>
          <label><span>{t("salesPage.totalAmount")}</span><input readOnly value={totalAmount ? money(totalAmount) : money(0)} /></label>
          <label><span>{t("salesPage.paymentAccount")}</span><ClearableSelect value={accountId || ""} onChange={setAccountId}>
            <option value="">{t("salesPage.selectPaymentAccount")}</option>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </ClearableSelect></label>
          <label><span>{t("reportsPage.paymentDate")}</span><input type="date" value={paymentDate} onChange={(event) => setPaymentDate(event.target.value)} /></label>
          <label><span>{t("reportsPage.remarks")}</span><input placeholder={t("dispatchPage.optional")} value={remarks} onChange={(event) => setRemarks(event.target.value)} /></label>
          {currentSaleType === "dispatch_sale" && selectedDispatch ? <p className="dispatch-linked-summary">{t("salesPage.dispatchMeta", { date: selectedDispatch.dispatch.date })} | {selectedDispatch.dateTypeName} | {t("salesPage.remainingCartons")} {selectedDispatchMax ?? selectedDispatch.remainingCartons}</p> : null}
          {error ? <p className="form-error">{error}</p> : null}
          <div className="sales-form__actions">
            {editingSale && <button className="secondary-action" type="button" onClick={resetForm}>{t("expensesPage.cancelEdit")}</button>}
            <button disabled={!canSave} type="submit">{editingSale ? t("salesPage.updateSale") : t("salesPage.saveSale")}</button>
          </div>
        </form>
      </FormCard>}
      <div className="summary-grid">
        <Summary label={t("dashboard.totalSales")} value={money(sales.reduce((sum, item) => sum + item.amount, 0))} />
        <Summary label={t("salesPage.availableDispatchItems")} value={String(filteredAvailability.length)} />
        <Summary label={t("salesPage.unsoldCartons")} value={String(filteredAvailability.reduce((sum, item) => sum + item.remainingCartons, 0))} />
      </div>
      <section className="record-panel sales-records-panel">
        <div className="sales-records-panel__header">
          <h2>{t("common.recentRecords")}</h2>
          <span>{t("reportsPage.transactionCount", { count: sales.length })}</span>
        </div>
        {!sales.length ? <Empty>{t("salesPage.noSalesRecorded")}<br />{t("salesPage.noSalesRecordedDescription")}</Empty> : <div className="sales-record-list">
          {sales.map((item) => {
            const paymentStatus = item.paymentStatus ?? "paid";
            return <article className="sales-record-card" key={item.id}>
              <div className="sales-record-card__date">
                <strong>{shortDate(item.date)}</strong>
                <span className={`sales-type-badge sales-type-badge--${resolveSaleType(item)}`}>{saleTypeLabel(item)}</span>
              </div>
              <div className="sales-record-card__body">
                <div className="sales-record-card__identity">
                  <strong>{item.buyerName?.trim() || t("salesPage.unassignedBuyer")}</strong>
                  <span>{saleProduceLabel(item)}</span>
                  <small>
                    {item.dispatchDate ? t("salesPage.dispatchMeta", { date: item.dispatchDate }) : t("salesPage.directFarmSaleMeta")}
                    {item.invoiceNumber ? ` • ${item.invoiceNumber}` : ""}
                  </small>
                </div>
                <div className="sales-record-card__metrics">
                  <span>{item.quantity} × {money(item.unitPrice)}</span>
                  <strong>{money(item.amount)}</strong>
                  <small className={`status-badge status-badge--${paymentStatus === "paid" ? "approved" : paymentStatus === "partial" ? "pending" : "rejected"}`}>
                    {translateSalesStatus(paymentStatus)}
                  </small>
                </div>
              </div>
              <div className="sales-record-card__actions">
                <button className="sales-action-button sales-action-button--neutral" type="button" aria-label={`${t("common.view")} ${item.invoiceNumber ?? item.date}`} onClick={() => setSelectedSale(item)}>
                  <Eye size={15} />
                  <span>{t("common.view")}</span>
                </button>
                {canEditSales && <button className="sales-action-button sales-action-button--edit" type="button" aria-label={`${t("common.edit")} ${item.invoiceNumber ?? item.date}`} onClick={() => editSale(item)}>
                  <Pencil size={15} />
                  <span>{t("common.edit")}</span>
                </button>}
                {canDeleteSales && <button className="sales-action-button sales-action-button--danger" type="button" aria-label={`${t("common.delete")} ${item.invoiceNumber ?? item.date}`} onClick={() => setSalePendingDelete(item)}>
                  <Trash2 size={15} />
                  <span>{t("common.delete")}</span>
                </button>}
              </div>
            </article>;
          })}
        </div>}
      </section>
      {selectedSale && <div className="worker-dialog-backdrop" role="presentation" onClick={() => setSelectedSale(null)}><section className="worker-dialog worker-dialog--record-detail" role="dialog" aria-modal="true" aria-label={t("salesPage.saleDetails")} onClick={(event) => event.stopPropagation()}><header className="worker-dialog__header"><h2>{t("salesPage.saleDetails")}</h2><button type="button" onClick={() => setSelectedSale(null)}><X size={18} /></button></header><div className="worker-dialog__body"><dl className="worker-stats"><div><dt>{t("salesPage.saleType")}</dt><dd>{saleTypeLabel(selectedSale)}</dd></div><div><dt>{t("reportsPage.date")}</dt><dd>{selectedSale.date}</dd></div><div><dt>{t("reportsPage.invoiceNumber")}</dt><dd>{selectedSale.invoiceNumber ?? "-"}</dd></div><div><dt>{t("reportsPage.dispatchDate")}</dt><dd>{selectedSale.dispatchDate ?? "-"}</dd></div><div><dt>{t("reportsPage.deliveryDate")}</dt><dd>{selectedSale.deliveryDate ?? "-"}</dd></div><div><dt>{t("reportsPage.paymentDate")}</dt><dd>{selectedSale.paymentDate ?? "-"}</dd></div><div><dt>{t("reportsPage.buyer")}</dt><dd>{selectedSale.buyerName ?? "-"}</dd></div><div><dt>{t("reportsPage.plot")}</dt><dd>{selectedSale.plotName ?? "-"}</dd></div><div><dt>{t("reportsPage.product")}</dt><dd>{saleProduceLabel(selectedSale)}</dd></div><div><dt>{t("reportsPage.vehicle")}</dt><dd>{selectedSale.vehicleNumber ?? "-"}</dd></div><div><dt>{t("reportsPage.quantity")}</dt><dd>{selectedSale.quantity}</dd></div><div><dt>{t("reportsPage.rate")}</dt><dd>{money(selectedSale.unitPrice)}</dd></div><div><dt>{t("reportsPage.amount")}</dt><dd>{money(selectedSale.amount)}</dd></div><div><dt>{t("salesPage.paymentAccount")}</dt><dd>{accounts.find((account) => account.id === selectedSale.accountId)?.name ?? "-"}</dd></div><div><dt>{t("reportsPage.remarks")}</dt><dd>{selectedSale.remarks ?? "-"}</dd></div></dl></div><footer className="worker-dialog__footer"><button className="worker-dialog__close" type="button" onClick={() => setSelectedSale(null)}>{t("common.close")}</button>{canEditSales && <button className="worker-dialog__link" type="button" onClick={() => editSale(selectedSale)}>{t("common.edit")}</button>}{canDeleteSales && <button className="worker-dialog__link worker-dialog__link--danger" type="button" onClick={() => setSalePendingDelete(selectedSale)}>{t("common.delete")}</button>}</footer></section></div>}
      {salePendingDelete && <div className="worker-dialog-backdrop" role="presentation" onClick={() => setSalePendingDelete(null)}>
        <section className="worker-action-dialog sales-delete-dialog" role="dialog" aria-modal="true" aria-label={t("salesPage.deleteSaleTitle")} onClick={(event) => event.stopPropagation()}>
          <header>
            <div>
              <h2>{t("salesPage.deleteSaleTitle")}</h2>
              <p>{salePendingDelete.invoiceNumber ? `${t("reportsPage.invoiceNumber")} ${salePendingDelete.invoiceNumber}` : `${salePendingDelete.date} • ${saleProduceLabel(salePendingDelete)}`}</p>
            </div>
            <button type="button" onClick={() => setSalePendingDelete(null)} aria-label={t("common.close")}><X size={18} /></button>
          </header>
          <div className="worker-action-dialog__body">
            <p>{t("salesPage.deleteSaleWarning")}</p>
          </div>
          <footer>
            <button type="button" onClick={() => setSalePendingDelete(null)}>{t("common.cancel")}</button>
            <button className="danger-button" type="button" onClick={() => void removeSale(salePendingDelete)}>{t("common.delete")}</button>
          </footer>
        </section>
      </div>}
    </>
  );
}

const partnerEntryName = (entry: PartnerEntry, settlementTemplate?: (from: string, to: string) => string) =>
  entry.type === "settlement"
    ? settlementTemplate?.(entry.fromPartner ?? "-", entry.toPartner ?? "-") ?? `${entry.fromPartner} to ${entry.toPartner}`
    : entry.partnerName ?? "-";
const partnerEntryBalanceEffect = (entry: PartnerEntry) => entry.type === "contribution"
  ? entry.amount
  : entry.type === "withdrawal"
    ? -entry.amount
    : entry.type === "adjustment"
      ? partnerAdjustmentEffect(entry)
      : 0;

function PartnerAccountAutocomplete({
  accounts,
  label,
  noResultsLabel,
  onSelect,
  placeholder,
  value,
}: {
  accounts: Account[];
  label: string;
  noResultsLabel: string;
  onSelect: (account: Account | null) => void;
  placeholder: string;
  value: string;
}) {
  const rootRef = useRef<HTMLLabelElement | null>(null);
  const selected = accounts.find((account) => account.id === value) ?? null;
  const [query, setQuery] = useState(selected?.name ?? "");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (!open) setQuery(selected?.name ?? "");
  }, [open, selected?.name]);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const normalizedQuery = query.trim().toLowerCase();
  const matches = useMemo(() => {
    const score = (account: Account) => {
      const name = account.name.toLowerCase();
      const email = String((account as Account & { email?: string }).email ?? "").toLowerCase();
      if (!normalizedQuery) return 1;
      if (name === normalizedQuery || email === normalizedQuery) return 0;
      if (name.startsWith(normalizedQuery) || email.startsWith(normalizedQuery)) return 1;
      if (name.split(/\s+/).some((word) => word.startsWith(normalizedQuery))) return 2;
      if (name.includes(normalizedQuery) || email.includes(normalizedQuery)) return 3;
      return 99;
    };
    return accounts
      .map((account) => ({ account, score: score(account) }))
      .filter((item) => item.score < 99)
      .sort((a, b) => a.score - b.score || a.account.name.localeCompare(b.account.name))
      .slice(0, 8)
      .map((item) => item.account);
  }, [accounts, normalizedQuery]);

  useEffect(() => setActiveIndex(0), [normalizedQuery]);

  const select = (account: Account) => {
    onSelect(account);
    setQuery(account.name);
    setOpen(false);
  };
  const clear = () => {
    onSelect(null);
    setQuery("");
    setOpen(false);
  };

  return (
    <label className="partner-autocomplete" ref={rootRef}>
      <span>{label}</span>
      <div className="partner-autocomplete__control">
        <Search size={16} aria-hidden="true" />
        <input
          autoComplete="off"
          placeholder={placeholder}
          value={query}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((current) => Math.min(current + 1, Math.max(matches.length - 1, 0)));
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((current) => Math.max(current - 1, 0));
            }
            if (event.key === "Enter" && open && matches[activeIndex]) {
              event.preventDefault();
              select(matches[activeIndex]);
            }
            if (event.key === "Escape") setOpen(false);
          }}
        />
        {(query || selected) && <button
          type="button"
          aria-label={label}
          onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); clear(); }}
        ><X size={15} /></button>}
      </div>
      {open && <div className="partner-autocomplete__menu" role="listbox">
        {matches.length ? matches.map((account, index) => (
          <button
            className={index === activeIndex ? "is-active" : ""}
            key={account.id}
            type="button"
            role="option"
            aria-selected={account.id === value}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => select(account)}
          >
            <strong>{account.name}</strong>
            <small>{account.type}</small>
          </button>
        )) : <p>{noResultsLabel}</p>}
      </div>}
    </label>
  );
}

function PartnerLedgerModule() {
  const { t } = useTranslation();
  const { user, sessionRefreshing } = useAuth();
  const [searchParams] = useSearchParams();
  const workspaceId = user?.workspaceId ?? "";
  const canCreateEntries = Boolean(!sessionRefreshing && user && workspaceId && canCreate(user, "accounts", workspaceId));
  const canEditEntries = Boolean(!sessionRefreshing && user && workspaceId && canEdit(user, "accounts", workspaceId));
  const canDeleteEntries = Boolean(!sessionRefreshing && user && workspaceId && canDelete(user, "accounts", workspaceId));
  const [showDeleted, setShowDeleted] = useState(false);
  const load = useCallback(async () => (await workspaceRecords(offlineDb.partnerEntries, { includeDeleted: showDeleted })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [showDeleted]);
  const loadAccounts = useCallback(() => workspaceRecords(offlineDb.accounts, { includeImportedAcrossSeasons: true }), []);
  const loadAdvances = useCallback(() => workspaceRecords(offlineDb.advances), []);
  const loadVouchers = useCallback(() => loadWorkspaceVouchers({ includeGeneralFarmRecords: true, includeImportedAcrossSeasons: true }), []);
  const loadSales = useCallback(() => workspaceRecords(offlineDb.sales), []);
  const [entries, refresh] = useData(load);
  const [accounts] = useData(loadAccounts, ensureLocalAccounts);
  const [advances] = useData(loadAdvances);
  const [vouchers] = useData(loadVouchers);
  const [sales] = useData(loadSales);
  const [date, setDate] = useState(today());
  const [partnerName, setPartnerName] = useState("");
  const [partnerAccountId, setPartnerAccountId] = useState("");
  const [fromPartner, setFromPartner] = useState("");
  const [toPartner, setToPartner] = useState("");
  const [fromAccountId, setFromAccountId] = useState("");
  const [toAccountId, setToAccountId] = useState("");
  const [type, setType] = useState<PartnerEntry["type"]>("contribution");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [accountId, setAccountId] = useState("");
  const [adjustmentDirection, setAdjustmentDirection] = useState<NonNullable<PartnerEntry["adjustmentDirection"]>>("increase");
  const [editing, setEditing] = useState<PartnerEntry | null>(null);
  const [viewing, setViewing] = useState<PartnerEntry | null>(null);
  const [deleting, setDeleting] = useState<PartnerEntry | null>(null);
  const [deletionReason, setDeletionReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [entryFilter, setEntryFilter] = useState<"all" | PartnerEntry["type"]>("all");
  const partnerAccounts = useMemo(() => accounts.filter((account) => account.type === "partner"), [accounts]);
  const cashBankAccounts = useMemo(() => accounts.filter((account) => account.type === "cash" || account.type === "bank"), [accounts]);
  const defaultCashAccountId = useMemo(() => cashBankAccounts.find((account) => account.type === "cash")?.id ?? cashBankAccounts[0]?.id ?? "", [cashBankAccounts]);
  const selectedDepositAccountId = useMemo(
    () => cashBankAccounts.some((account) => account.id === accountId) ? accountId : defaultCashAccountId,
    [accountId, cashBankAccounts, defaultCashAccountId],
  );
  const partnerEntryLabel = (entry: PartnerEntry) => entry.type === "contribution"
    ? t("partnerLedgerPage.capitalInjected")
    : entry.type === "withdrawal"
      ? t("partnerLedgerPage.returnMoneyToPartner")
      : entry.type === "adjustment"
        ? t("partnerLedgerPage.adjustments")
        : t("partnerLedgerPage.transfersOut");
  const partnerSettlementRoute = (from: string, to: string) => t("partnerLedgerPage.partnerSettlementRoute", { from, to });
  useEffect(() => {
    const recordId = searchParams.get("recordId");
    if (recordId) setViewing(entries.find((entry) => entry.id === recordId) ?? null);
  }, [entries, searchParams]);

  const resetForm = () => {
    setEditing(null); setDate(today()); setPartnerName(""); setPartnerAccountId(""); setFromPartner(""); setToPartner(""); setFromAccountId(""); setToAccountId(""); setType("contribution"); setAmount(""); setNotes(""); setAccountId(""); setAdjustmentDirection("increase"); setError("");
  };

  const edit = (entry: PartnerEntry) => {
    setEditing(entry); setDate(entry.date); setPartnerName(entry.partnerName ?? ""); setType(entry.type);
    setPartnerAccountId(entry.partnerAccountId ?? resolvePartnerAccountId(entry, accounts) ?? "");
    setFromPartner(entry.fromPartner ?? ""); setToPartner(entry.toPartner ?? "");
    setFromAccountId(entry.fromAccountId ?? ""); setToAccountId(entry.toAccountId ?? "");
    setAmount(String(entry.amount)); setNotes(entry.notes); setAccountId(entry.accountId ?? ""); setAdjustmentDirection(entry.adjustmentDirection ?? "increase"); setError("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!(editing ? canEditEntries : canCreateEntries)) {
      setError(t("common.viewOnlyAccess"));
      return;
    }
    const settlement = type === "settlement";
    const needsCashBankAccount = type === "contribution" || type === "withdrawal";
    const resolvedAccountId = needsCashBankAccount ? selectedDepositAccountId : undefined;
    const amountValue = Number(amount);
    if (!date) return setError(t("partnerLedgerPage.pleaseSelectDate"));
    if (!Number.isFinite(amountValue) || amountValue <= 0) return setError(t("partnerLedgerPage.pleaseEnterAmount"));
    if (settlement) {
      if (!fromAccountId) return setError(t("partnerLedgerPage.pleaseSelectFromPartner"));
      if (!toAccountId) return setError(t("partnerLedgerPage.pleaseSelectToPartner"));
      if (fromAccountId === toAccountId) return setError(t("partnerLedgerPage.differentPartnerValidation"));
    } else if (!partnerName.trim() || !partnerAccountId) {
      return setError(t("partnerLedgerPage.pleaseSelectPartner"));
    }
    if (needsCashBankAccount && !resolvedAccountId) {
      return setError(t("partnerLedgerPage.noCashBankAccount"));
    }
    setSaving(true); setError("");
    try {
      const fields = settlement
        ? {
            date, type, amount: amountValue, notes, fromAccountId, toAccountId,
            fromPartner: accounts.find((account) => account.id === fromAccountId)?.name ?? fromPartner.trim(),
            toPartner: accounts.find((account) => account.id === toAccountId)?.name ?? toPartner.trim(),
            partnerName: undefined, partnerAccountId: undefined, accountId: undefined, adjustmentDirection: undefined,
          }
        : {
            date, type, amount: amountValue, notes, partnerName: partnerName.trim(), partnerAccountId,
            accountId: needsCashBankAccount ? resolvedAccountId : undefined,
            adjustmentDirection: type === "adjustment" ? adjustmentDirection : undefined,
            fromPartner: undefined, toPartner: undefined, fromAccountId: undefined, toAccountId: undefined,
          };
      const record: PartnerEntry = editing
        ? { ...editing, ...fields }
        : { ...makeLocalRecord(), ...fields };
      await persistOperationalRecord("partnerEntry", record);
      resetForm();
      window.dispatchEvent(new CustomEvent("muzare-toast", { detail: editing ? t("partnerLedgerPage.entryUpdated") : t("partnerLedgerPage.entrySaved") }));
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("partnerLedgerPage.saveFailed"));
    } finally {
      setSaving(false);
    }
  };
  const confirmDelete = async () => {
    if (!deleting) return;
    setSaving(true); setError("");
    try {
      await deleteOperationalRecord("partnerEntry", { ...deleting, deletionReason });
      window.dispatchEvent(new CustomEvent("muzare-toast", { detail: t("partnerLedgerPage.entryDeleted") }));
      setDeleting(null); setDeletionReason("");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("partnerLedgerPage.deleteFailed"));
    } finally {
      setSaving(false);
    }
  };
  const visibleEntries = entries.filter((item) => (showDeleted || isActiveOperationalRecord(item)) && (entryFilter === "all" || item.type === entryFilter));
  const activeEntries = entries.filter((item) => isActiveOperationalRecord(item));
  const accountName = (id?: string) => id ? accounts.find((account) => account.id === id)?.name ?? t("expensesPage.unknownAccount") : "-";
  const partnerPositions = useMemo(
    () => buildPartnerLiabilityPositions(accounts, vouchers, advances, activeEntries, sales),
    [accounts, vouchers, advances, activeEntries, sales],
  );
  const balance = partnerPositions.reduce((sum, item) => sum + item.currentPartnerBalance, 0);
  const runningBalances = (() => {
    const balances = new Map<string, { name: string; amount: number }>();
    const labels = new Map<string, string>();
    const adjust = (key: string, name: string, amount: number) => {
      const current = balances.get(key) ?? { name: name.trim(), amount: 0 };
      balances.set(key, { ...current, amount: current.amount + amount });
    };
    for (const entry of [...activeEntries].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt))) {
      if (entry.type === "settlement") {
        if (!entry.fromAccountId || !entry.toAccountId) {
          labels.set(entry.id, t("partnerLedgerPage.unresolvedSettlementAccountMapping")); continue;
        }
        const fromName = accounts.find((account) => account.id === entry.fromAccountId)?.name ?? entry.fromPartner!;
        const toName = accounts.find((account) => account.id === entry.toAccountId)?.name ?? entry.toPartner!;
        adjust(entry.fromAccountId, fromName, entry.amount);
        adjust(entry.toAccountId, toName, -entry.amount);
        labels.set(entry.id, `${fromName}: ${money(balances.get(entry.fromAccountId)!.amount)} | ${toName}: ${money(balances.get(entry.toAccountId)!.amount)}`);
      } else {
        const resolvedId = resolvePartnerAccountId(entry, accounts);
        const name = accounts.find((account) => account.id === resolvedId)?.name ?? entry.partnerName!;
        const key = resolvedId ?? `legacy:${entry.partnerName!.trim().toLowerCase()}`;
        adjust(key, name, partnerEntryBalanceEffect(entry));
        labels.set(entry.id, `${name}: ${money(balances.get(key)!.amount)}`);
      }
    }
    return labels;
  })();

  return (
    <>
      {(canCreateEntries || (editing && canEditEntries)) && <FormCard title={editing ? t("partnerLedgerPage.editPartnerEntry") : t("partnerLedgerPage.recordPartnerEntry")}>
        <form className="module-form partner-entry-form" onSubmit={(event) => void submit(event)}>
          <label><span>{t("partnerLedgerPage.date")}</span><input required type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
          <label><span>{t("partnerLedgerPage.type")}</span><ClearableSelect allowClear={false} value={type} onChange={(value) => setType(value as PartnerEntry["type"])}>
            <option value="contribution">{t("partnerLedgerPage.capitalInjected")}</option>
            <option value="settlement">{t("partnerLedgerPage.transfersOut")}</option>
            <option value="withdrawal">{t("partnerLedgerPage.returnMoneyToPartner")}</option>
            <option value="adjustment">{t("partnerLedgerPage.adjustments")}</option>
          </ClearableSelect></label>
          {type === "settlement" ? <>
            <label><span>{t("partnerLedgerPage.fromPartnerAccount")}</span><ClearableSelect required value={fromAccountId} onChange={setFromAccountId}><option value="">{t("partnerLedgerPage.searchPartner")}</option>{partnerAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</ClearableSelect></label>
            <label><span>{t("partnerLedgerPage.toPartnerAccount")}</span><ClearableSelect required value={toAccountId} onChange={setToAccountId}><option value="">{t("partnerLedgerPage.searchPartner")}</option>{partnerAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</ClearableSelect></label>
          </> : <>
            <PartnerAccountAutocomplete
              accounts={partnerAccounts}
              label={t("partnerLedgerPage.partner")}
              noResultsLabel={t("partnerLedgerPage.noPartnerMatches")}
              placeholder={t("partnerLedgerPage.searchPartner")}
              value={partnerAccountId}
              onSelect={(account) => {
                setPartnerAccountId(account?.id ?? "");
                setPartnerName(account?.name ?? "");
              }}
            />
          </>}
          <label><span>{t("partnerLedgerPage.amount")}</span><input required type="number" min="0.01" step="0.01" placeholder={t("partnerLedgerPage.amount")} value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
          {type === "adjustment" && <label><span>{t("partnerLedgerPage.adjustmentDirection")}</span><ClearableSelect allowClear={false} value={adjustmentDirection} onChange={(value) => setAdjustmentDirection(value as NonNullable<PartnerEntry["adjustmentDirection"]>)}>
            <option value="increase">{t("partnerLedgerPage.increaseFarmOwesPartner")}</option>
            <option value="decrease">{t("partnerLedgerPage.decreaseFarmOwesPartner")}</option>
          </ClearableSelect></label>}
          <label><span>{type === "adjustment" ? t("partnerLedgerPage.reasonNotes") : t("partnerLedgerPage.notes")}</span><input placeholder={type === "adjustment" ? t("partnerLedgerPage.reasonNotes") : t("partnerLedgerPage.notes")} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
          {(type === "contribution" || type === "withdrawal") && <label><span>{type === "contribution" ? t("partnerLedgerPage.depositTo") : t("partnerLedgerPage.paymentFrom")}</span>
            {cashBankAccounts.length > 0 ? <ClearableSelect value={selectedDepositAccountId} onChange={setAccountId}>
              <option value="">{type === "contribution" ? t("partnerLedgerPage.depositToPlaceholder") : t("partnerLedgerPage.paymentFromPlaceholder")}</option>
              {cashBankAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
            </ClearableSelect> : <p className="worker-action-error">{t("partnerLedgerPage.noCashBankAccount")}</p>}
          </label>}
          <button className="partner-ledger-submit" disabled={saving} type="submit">{saving ? t("partnerLedgerPage.saving") : editing ? t("partnerLedgerPage.updateEntry") : t("partnerLedgerPage.saveEntry")}</button>
          {editing && <button className="secondary-button" disabled={saving} type="button" onClick={resetForm}>{t("partnerLedgerPage.cancelEdit")}</button>}
        </form>
        {error && <p className="worker-action-error">{error}</p>}
      </FormCard>}
      <Summary
        label={getPartnerBalanceState(balance) === "partner_holds_business_money"
          ? t("partnerLedgerPage.partnerHoldsBusinessMoney")
          : t("partnerLedgerPage.farmOwesPartner")}
        value={money(balance)}
      />
      {activeEntries.some((entry) => entry.type === "settlement" && (!entry.fromAccountId || !entry.toAccountId)) && <p className="worker-action-error">{t("partnerLedgerPage.unresolvedSettlementRepair")}</p>}
      <section className="record-panel">
        <h2>{t("partnerLedgerPage.partnerPosition")}</h2>
        {!partnerPositions.length ? <Empty>{t("partnerLedgerPage.noPartnerPositions")}</Empty> : <div className="partner-position-table">
          <div className="partner-position-row partner-position-row--header"><span>{t("partnerLedgerPage.partner")}</span><span>{t("partnerLedgerPage.openingBalance")}</span><span>{t("partnerLedgerPage.capitalInjected")}</span><span>{t("partnerLedgerPage.directExpensesPaid")}</span><span>{t("partnerLedgerPage.transfersOut")}</span><span>{t("partnerLedgerPage.transfersIn")}</span><span>{t("partnerLedgerPage.moneyReturned")}</span><span>{t("partnerLedgerPage.adjustments")}</span><span>{t("partnerLedgerPage.currentPartnerBalance")}</span></div>
          {partnerPositions.map((item) => <div className="partner-position-row" key={item.name}>
            <strong>{item.name}</strong><span>{money(item.openingBalance)}</span><span>{money(item.capitalInjected)}</span><span>{money(item.directExpensesPaid)}</span><span>{money(item.transfersOut)}</span><span>{money(item.transfersIn)}</span><span>{money(item.moneyReturned)}</span><span>{money(item.adjustments)}</span><b>{money(item.currentPartnerBalance)}</b>
          </div>)}
        </div>}
        {!!partnerPositions.length && <div className="partner-position-cards">
          {partnerPositions.map((item) => <article key={`mobile-${item.name}`}>
            <header><strong>{item.name}</strong><b>{money(item.currentPartnerBalance)}</b></header>
            <p>{getPartnerBalanceState(item.currentPartnerBalance) === "partner_holds_business_money" ? t("partnerLedgerPage.partnerHoldsBusinessMoney") : t("partnerLedgerPage.farmOwesPartner")}</p>
            <div><span>{t("partnerLedgerPage.openingBalance")}</span><strong>{money(item.openingBalance)}</strong></div>
            <div><span>{t("partnerLedgerPage.capitalInjected")}</span><strong>{money(item.capitalInjected)}</strong></div>
            <div><span>{t("partnerLedgerPage.directExpensesPaid")}</span><strong>{money(item.directExpensesPaid)}</strong></div>
            <div><span>{t("partnerLedgerPage.transfersOut")}</span><strong>{money(item.transfersOut)}</strong></div>
            <div><span>{t("partnerLedgerPage.transfersIn")}</span><strong>{money(item.transfersIn)}</strong></div>
            <div><span>{t("partnerLedgerPage.moneyReturned")}</span><strong>{money(item.moneyReturned)}</strong></div>
            <div><span>{t("partnerLedgerPage.adjustments")}</span><strong>{money(item.adjustments)}</strong></div>
          </article>)}
        </div>}
      </section>
      <label className="partner-ledger-filter"><span>{t("partnerLedgerPage.ledgerFilter")}</span><select value={entryFilter} onChange={(event) => setEntryFilter(event.target.value as typeof entryFilter)}>
        <option value="all">{t("partnerLedgerPage.all")}</option><option value="contribution">{t("partnerLedgerPage.capitalInjected")}</option><option value="settlement">{t("partnerLedgerPage.partnerSettlement")}</option><option value="withdrawal">{t("partnerLedgerPage.returnMoneyToPartner")}</option><option value="adjustment">{t("partnerLedgerPage.adjustments")}</option>
      </select></label>
      {canDeleteEntries && <label className="partner-ledger-show-deleted"><input checked={showDeleted} type="checkbox" onChange={(event) => setShowDeleted(event.target.checked)} /> {t("partnerLedgerPage.showDeleted")}</label>}
      <RecordTable
        empty={t("partnerLedgerPage.noPartnerEntries")}
        rows={visibleEntries.map((item) => [item.date, partnerEntryName(item, partnerSettlementRoute), partnerEntryLabel(item), item.type === "settlement" ? `${accountName(item.fromAccountId)} -> ${accountName(item.toAccountId)}` : `${accountName(item.partnerAccountId ?? resolvePartnerAccountId(item, accounts))} / ${accountName(item.accountId)}`, item.notes || "-", money(item.type === "withdrawal" ? -item.amount : item.amount), item.deletedAt ? t("partnerLedgerPage.deleted") : runningBalances.get(item.id) ?? "-"])}
        actions={visibleEntries.map((item) => (
          <div className="record-list__actions" key={`actions-${item.id}`}>
            <button type="button" onClick={() => setViewing(item)}>{t("partnerLedgerPage.view")}</button>
            {canEditEntries && isActiveOperationalRecord(item) && <button type="button" onClick={() => edit(item)}>{t("partnerLedgerPage.edit")}</button>}
            {canDeleteEntries && isActiveOperationalRecord(item) && <button className="danger-button" type="button" onClick={() => { setDeleting(item); setDeletionReason(""); }}>{t("partnerLedgerPage.delete")}</button>}
          </div>
        ))}
      />
      {viewing && (
        <div className="worker-dialog-backdrop worker-action-backdrop">
          <section className="worker-action-dialog">
            <header><h2>{t("partnerLedgerPage.detailsTitle")}</h2><button aria-label={t("common.close")} type="button" onClick={() => setViewing(null)}><X size={19} /></button></header>
            <div className="worker-action-form partner-ledger-details">
              <p><strong>{t("partnerLedgerPage.date")}</strong><span>{viewing.date}</span></p><p><strong>{t("partnerLedgerPage.partner")}</strong><span>{partnerEntryName(viewing, partnerSettlementRoute)}</span></p>
              <p><strong>{t("partnerLedgerPage.type")}</strong><span>{partnerEntryLabel(viewing)}</span></p>{viewing.type !== "settlement" && <><p><strong>{t("partnerLedgerPage.partnerAccount")}</strong><span>{accountName(viewing.partnerAccountId ?? resolvePartnerAccountId(viewing, accounts))}</span></p><p><strong>{t("partnerLedgerPage.account")}</strong><span>{accountName(viewing.accountId)}</span></p></>}
              <p><strong>{t("partnerLedgerPage.amount")}</strong><span>{money(viewing.amount)}</span></p><p><strong>{t("partnerLedgerPage.notes")}</strong><span>{viewing.notes || "-"}</span></p>
              {viewing.deletedAt && <p><strong>{t("partnerLedgerPage.deleted")}</strong><span>{new Date(viewing.deletedAt).toLocaleString()}</span></p>}
              <footer><button type="button" onClick={() => setViewing(null)}>{t("partnerLedgerPage.close")}</button></footer>
            </div>
          </section>
        </div>
      )}
      {deleting && (
        <div className="worker-dialog-backdrop worker-action-backdrop">
          <section className="worker-action-dialog">
            <header><h2>{t("partnerLedgerPage.deleteTitle")}</h2><button aria-label={t("common.close")} type="button" onClick={() => setDeleting(null)}><X size={19} /></button></header>
            <div className="worker-action-form">
              <p className="worker-action-warning">{t("partnerLedgerPage.deleteWarning")}</p>
              <p>{deleting.date} | {partnerEntryName(deleting, partnerSettlementRoute)} | {partnerEntryLabel(deleting)} | {accountName(deleting.accountId)} | {money(deleting.amount)}</p>
              <label><span>{t("partnerLedgerPage.deletionReason")}</span><textarea value={deletionReason} onChange={(event) => setDeletionReason(event.target.value)} /></label>
              {error && <p className="worker-action-error">{error}</p>}
              <footer><button disabled={saving} type="button" onClick={() => setDeleting(null)}>{t("partnerLedgerPage.cancel")}</button><button className="danger-button" disabled={saving} type="button" onClick={() => void confirmDelete()}>{saving ? t("partnerLedgerPage.deleting") : t("partnerLedgerPage.deleteEntry")}</button></footer>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function AccountsModule() {
  const { t } = useTranslation();
  const { user, sessionRefreshing } = useAuth();
  const workspaceId = user?.workspaceId ?? "";
  const canCreateAccounts = Boolean(!sessionRefreshing && user && workspaceId && canCreate(user, "accounts", workspaceId));
  const navigate = useNavigate();
  const loadAccounts = useCallback(async () => (await workspaceRecords(offlineDb.accounts, { includeImportedAcrossSeasons: true })).sort((a, b) => a.createdAt.localeCompare(b.createdAt)), []);
  const loadVouchers = useCallback(() => loadWorkspaceVouchers({ includeGeneralFarmRecords: true, includeImportedAcrossSeasons: true }), []);
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
  const [ledgerType, setLedgerType] = useState<"all" | "sale" | "voucher" | "advance" | "settlement_sent" | "settlement_received" | "contribution" | "withdrawal" | "adjustment">("all");
  const [ledgerFrom, setLedgerFrom] = useState("");
  const [ledgerTo, setLedgerTo] = useState("");
  const [ledgerMinAmount, setLedgerMinAmount] = useState("");
  const [ledgerMaxAmount, setLedgerMaxAmount] = useState("");
  const [showEmptyLedgerGroups, setShowEmptyLedgerGroups] = useState(false);
  const [ledgerGroupExpanded, setLedgerGroupExpanded] = useState<Record<AccountTransactionGroupKey, boolean>>(defaultTransactionGroupExpansion);
  const [partnerLedgerGroupExpanded, setPartnerLedgerGroupExpanded] = useState<Record<PartnerLiabilityLedgerGroupKey, boolean>>(defaultPartnerLiabilityGroupExpansion);
  const [name, setName] = useState("");
  const [type, setType] = useState<Account["type"]>("bank");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canCreateAccounts) return;
    const record: Account = { ...makeLocalRecord(), name, type };
    await persistOperationalRecord("account", record);
    setName("");
    await refresh();
  };
  const activeSales = sales.filter((item) => isActiveOperationalRecord(item));
  const activeVouchers = getActiveVouchers(vouchers);
  const activeEntries = entries.filter((item) => isActiveOperationalRecord(item));
  const activeAdvances = advances.filter((item) => isActiveOperationalRecord(item));
  const balance = (account: Account) => calculateAccountBalance(account, activeSales, activeVouchers, activeAdvances, activeEntries);
  const totalAdvances = activeAdvances.reduce((sum, item) => sum + item.amount, 0);
  const totalVoucherExpenses = activeVouchers.reduce((sum, item) => sum + item.amount, 0);
  const selectedAccount = selectedAccountId ? accounts.find((item) => item.id === selectedAccountId) ?? null : null;
  const ledgerGroupTitle = useCallback((groupKey: AccountTransactionGroupKey) => ({
    expenses: t("accountsPage.groupExpenses"),
    advances: t("accountsPage.groupAdvances"),
    settlements: t("accountsPage.groupSettlements"),
    income: t("accountsPage.groupIncome"),
    other: t("accountsPage.groupOther"),
  }[groupKey]), [t]);
  const ledgerTypeLabel = useCallback((row: Pick<AccountLedgerRow, "type">) => (
    row.type === "sale" ? t("accountsPage.saleCredit")
      : row.type === "voucher" ? t("accountsPage.voucherExpense")
        : row.type === "advance" ? t("accountsPage.labourAdvance")
          : row.type === "settlement_sent" ? t("accountsPage.settlementSent")
            : row.type === "settlement_received" ? t("accountsPage.settlementReceived")
              : row.type === "adjustment" ? t("accountsPage.adjustment")
              : row.type === "contribution" ? t("accountsPage.contribution")
                : t("accountsPage.withdrawal")
  ), [t]);
  const partnerLiabilityGroupTitle = useCallback((groupKey: PartnerLiabilityLedgerGroupKey) => ({
    capital_injected: t("accountsPage.capitalInjected"),
    direct_expenses_paid: t("accountsPage.directExpensesPaid"),
    transfers_in: t("accountsPage.transfersIn"),
    transfers_out: t("accountsPage.transfersOut"),
    money_returned: t("accountsPage.moneyReturned"),
    adjustments: t("accountsPage.adjustments"),
    other: t("accountsPage.groupOther"),
  }[groupKey]), [t]);
  const ledgerRows = useMemo(() => {
    if (!selectedAccount) return [];
    const rows: AccountLedgerRow[] = [];
    const selectedIsPartner = selectedAccount.type === "partner";
    for (const sale of activeSales.filter((item) => item.accountId === selectedAccount.id)) {
      rows.push({
        id: `sale:${sale.id}`,
        date: sale.date,
        type: selectedIsPartner ? "adjustment" : "sale",
        reference: sale.id.slice(0, 8),
        description: `${sale.buyerName} - ${saleProduceLabel(sale)}${sale.dispatchDate ? ` | Dispatch ${sale.dispatchDate}` : ""}`,
        debit: selectedIsPartner ? sale.amount : 0,
        credit: selectedIsPartner ? 0 : sale.amount,
        source: "sales",
        sourceId: sale.id,
        classification: selectedIsPartner ? "adjustment" : "sale",
        partnerLiabilityGroup: selectedIsPartner ? "adjustments" : undefined,
      });
    }
    for (const voucher of activeVouchers.filter((item) => item.accountId === selectedAccount.id)) {
      rows.push({
        id: `voucher:${voucher.id}`,
        date: voucher.date,
        type: "voucher",
        reference: getVoucherDisplayNumber(voucher) || voucher.voucherNumber,
        description: `${voucher.category} / ${voucher.subcategory} - ${voucher.description}`,
        debit: selectedIsPartner ? 0 : voucher.amount,
        credit: selectedIsPartner ? voucher.amount : 0,
        source: "expenses",
        sourceId: voucher.id,
        classification: "voucher",
        partnerLiabilityGroup: selectedIsPartner ? "direct_expenses_paid" : undefined,
      });
    }
    for (const advance of activeAdvances.filter((item) => item.accountId === selectedAccount.id)) {
      rows.push({
        id: `advance:${advance.id}`,
        date: advance.date,
        type: "advance",
        reference: advance.id.slice(0, 8),
        description: `${t("accountsPage.labourAdvance")}${advance.notes ? ` - ${advance.notes}` : ""}`,
        debit: selectedIsPartner ? 0 : advance.amount,
        credit: selectedIsPartner ? advance.amount : 0,
        source: "labour_advances",
        sourceId: advance.id,
        classification: "advance",
        partnerLiabilityGroup: selectedIsPartner ? "direct_expenses_paid" : undefined,
      });
    }
    for (const entry of activeEntries) {
      const resolvedPartnerAccountId = resolvePartnerAccountId(entry, accounts);
      if (entry.type === "contribution" && ((selectedIsPartner && resolvedPartnerAccountId === selectedAccount.id) || (!selectedIsPartner && entry.accountId === selectedAccount.id))) {
        rows.push({
          id: `partner:${entry.id}`,
          date: entry.date,
          type: "contribution",
          reference: entry.id.slice(0, 8),
          description: `${entry.partnerName ?? selectedAccount.name}${entry.notes ? ` - ${entry.notes}` : ""}`,
          debit: 0,
          credit: entry.amount,
          source: "partner_ledger",
          sourceId: entry.id,
          counterparty: entry.partnerName,
          classification: "contribution",
          partnerLiabilityGroup: selectedIsPartner ? "capital_injected" : undefined,
        });
      }
      if (entry.type === "withdrawal" && ((selectedIsPartner && resolvedPartnerAccountId === selectedAccount.id) || (!selectedIsPartner && entry.accountId === selectedAccount.id))) {
        rows.push({
          id: `partner:${entry.id}`,
          date: entry.date,
          type: "withdrawal",
          reference: entry.id.slice(0, 8),
          description: `${entry.partnerName ?? selectedAccount.name}${entry.notes ? ` - ${entry.notes}` : ""}`,
          debit: entry.amount,
          credit: 0,
          source: "partner_ledger",
          sourceId: entry.id,
          counterparty: entry.partnerName,
          classification: "withdrawal",
          partnerLiabilityGroup: selectedIsPartner ? "money_returned" : undefined,
        });
      }
      if (entry.type === "settlement") {
        if (entry.fromAccountId === selectedAccount.id) {
          rows.push({
            id: `partner:${entry.id}:sent`,
            date: entry.date,
            type: "settlement_sent",
            reference: entry.id.slice(0, 8),
            description: entry.notes || t("accountsPage.settlementSent"),
            debit: selectedIsPartner ? 0 : entry.amount,
            credit: selectedIsPartner ? entry.amount : 0,
            source: "partner_ledger",
            sourceId: entry.id,
            counterparty: entry.toPartner,
            classification: "settlement_sent",
            partnerLiabilityGroup: selectedIsPartner ? "transfers_out" : undefined,
          });
        }
        if (entry.toAccountId === selectedAccount.id) {
          rows.push({
            id: `partner:${entry.id}:received`,
            date: entry.date,
            type: "settlement_received",
            reference: entry.id.slice(0, 8),
            description: entry.notes || t("accountsPage.settlementReceived"),
            debit: selectedIsPartner ? entry.amount : 0,
            credit: selectedIsPartner ? 0 : entry.amount,
            source: "partner_ledger",
            sourceId: entry.id,
            counterparty: entry.fromPartner,
            classification: "settlement_received",
            partnerLiabilityGroup: selectedIsPartner ? "transfers_in" : undefined,
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
  }, [activeAdvances, activeEntries, activeSales, activeVouchers, accounts, selectedAccount, t]);
  const filteredLedgerRows = useMemo(() => {
    const term = ledgerSearch.trim().toLowerCase();
    const minAmount = ledgerMinAmount ? Number(ledgerMinAmount) : null;
    const maxAmount = ledgerMaxAmount ? Number(ledgerMaxAmount) : null;
    return ledgerRows.filter((row) => (ledgerType === "all" || row.type === ledgerType)
      && (!ledgerFrom || row.date >= ledgerFrom)
      && (!ledgerTo || row.date <= ledgerTo)
      && (minAmount === null || Math.max(row.debit, row.credit) >= minAmount)
      && (maxAmount === null || Math.max(row.debit, row.credit) <= maxAmount)
      && (!term || [
        row.reference,
        row.description,
        row.counterparty ?? "",
        row.date,
        String(row.debit),
        String(row.credit),
      ].some((value) => value.toLowerCase().includes(term))));
  }, [ledgerFrom, ledgerMaxAmount, ledgerMinAmount, ledgerRows, ledgerSearch, ledgerTo, ledgerType]);
  const partnerLedgerGroups = useMemo(
    () => selectedAccount?.type === "partner" ? groupPartnerLiabilityTransactions(filteredLedgerRows) : [],
    [filteredLedgerRows, selectedAccount],
  );
  const visiblePartnerLedgerGroups = useMemo(
    () => partnerLedgerGroups.filter((group) => showEmptyLedgerGroups || group.count > 0),
    [partnerLedgerGroups, showEmptyLedgerGroups],
  );
  const rawPartnerLedgerBreakdown = useMemo(() => {
    const byType = {
      capitalInjected: 0,
      directVoucherExpensesPaid: 0,
      directLabourAdvancesPaid: 0,
      directExpensesPaid: 0,
      transfersIn: 0,
      transfersOut: 0,
      moneyReturned: 0,
      adjustments: 0,
    };
    if (selectedAccount?.type !== "partner") return { ...byType, netBalance: 0 };
    for (const row of filteredLedgerRows) {
      if (row.partnerLiabilityGroup === "capital_injected") byType.capitalInjected += row.credit;
      if (row.type === "voucher") byType.directVoucherExpensesPaid += row.credit;
      if (row.type === "advance") byType.directLabourAdvancesPaid += row.credit;
      if (row.partnerLiabilityGroup === "direct_expenses_paid") byType.directExpensesPaid += row.credit - row.debit;
      if (row.partnerLiabilityGroup === "transfers_in") byType.transfersIn += Math.max(row.debit, row.credit);
      if (row.partnerLiabilityGroup === "transfers_out") byType.transfersOut += Math.max(row.debit, row.credit);
      if (row.partnerLiabilityGroup === "money_returned") byType.moneyReturned += row.debit;
      if (row.partnerLiabilityGroup === "adjustments") byType.adjustments += row.credit - row.debit;
    }
    return {
      ...byType,
      netBalance: byType.capitalInjected
        + byType.directExpensesPaid
        + byType.transfersOut
        - byType.transfersIn
        - byType.moneyReturned
        + byType.adjustments,
    };
  }, [filteredLedgerRows, selectedAccount]);
  const rawPartnerLedgerOverview = useMemo(() => {
    const overview = {
      openingBalance: 0,
      capitalInjected: 0,
      directVoucherExpensesPaid: 0,
      directLabourAdvancesPaid: 0,
      directExpensesPaid: 0,
      transfersIn: 0,
      transfersOut: 0,
      moneyReturned: 0,
      adjustments: 0,
    };
    if (selectedAccount?.type !== "partner") return { ...overview, netBalance: 0 };
    for (const row of ledgerRows) {
      if (row.partnerLiabilityGroup === "capital_injected") overview.capitalInjected += row.credit;
      if (row.type === "voucher") overview.directVoucherExpensesPaid += row.credit;
      if (row.type === "advance") overview.directLabourAdvancesPaid += row.credit;
      if (row.partnerLiabilityGroup === "direct_expenses_paid") overview.directExpensesPaid += row.credit - row.debit;
      if (row.partnerLiabilityGroup === "transfers_in") overview.transfersIn += Math.max(row.debit, row.credit);
      if (row.partnerLiabilityGroup === "transfers_out") overview.transfersOut += Math.max(row.debit, row.credit);
      if (row.partnerLiabilityGroup === "money_returned") overview.moneyReturned += row.debit;
      if (row.partnerLiabilityGroup === "adjustments") overview.adjustments += row.credit - row.debit;
    }
    return {
      ...overview,
      netBalance: calculatePartnerLiabilityBalance(overview),
    };
  }, [ledgerRows, selectedAccount]);
  const rawStandardLedgerBreakdown = useMemo(() => {
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
  const groupedLedgerRows = useMemo(() => groupAccountTransactions(filteredLedgerRows), [filteredLedgerRows]);
  const visibleLedgerGroups = useMemo(() => groupedLedgerRows.filter((group) => showEmptyLedgerGroups || group.count > 0), [groupedLedgerRows, showEmptyLedgerGroups]);
  const ledgerCurrentBalance = selectedAccount ? balance(selectedAccount) : 0;
  const rawPartnerLedgerSummary = useMemo(() => {
    const summary = {
      capitalInjected: 0,
      directExpensesPaid: 0,
      transfersIn: 0,
      transfersOut: 0,
      moneyReturned: 0,
      adjustments: 0,
    };
    if (selectedAccount?.type !== "partner") return { ...summary, netBalance: 0 };
    for (const group of partnerLedgerGroups) {
      if (group.groupKey === "capital_injected") summary.capitalInjected += group.totalAmount;
      if (group.groupKey === "direct_expenses_paid") summary.directExpensesPaid += group.totalAmount;
      if (group.groupKey === "transfers_in") summary.transfersIn += Math.abs(group.totalAmount);
      if (group.groupKey === "transfers_out") summary.transfersOut += Math.abs(group.totalAmount);
      if (group.groupKey === "money_returned") summary.moneyReturned += -group.totalAmount;
      if (group.groupKey === "adjustments") summary.adjustments += group.totalAmount;
    }
    return {
      ...summary,
      netBalance: summary.capitalInjected + summary.directExpensesPaid + summary.transfersOut - summary.transfersIn - summary.moneyReturned + summary.adjustments,
    };
  }, [partnerLedgerGroups, selectedAccount]);
  const rawStandardLedgerSummary = useMemo(() => {
    const summary = {
      expenses: 0,
      advances: 0,
      settlements: 0,
      income: 0,
      other: 0,
    };
    for (const group of groupedLedgerRows) {
      if (group.groupKey === "expenses") summary.expenses += group.debitTotal;
      if (group.groupKey === "advances") summary.advances += group.debitTotal;
      if (group.groupKey === "settlements") summary.settlements += group.totalAmount;
      if (group.groupKey === "income") summary.income += group.totalAmount;
      if (group.groupKey === "other") summary.other += group.totalAmount;
    }
    return {
      ...summary,
      netBalance: summary.income - summary.expenses - summary.advances + summary.settlements + summary.other,
    };
  }, [groupedLedgerRows]);
  const ledgerBreakdown = selectedAccount?.type === "partner" ? rawPartnerLedgerBreakdown : rawStandardLedgerBreakdown;
  const ledgerSummary = selectedAccount?.type === "partner" ? rawPartnerLedgerSummary : rawStandardLedgerSummary;
  const hasLedgerFilters = Boolean(ledgerSearch.trim() || ledgerType !== "all" || ledgerFrom || ledgerTo || ledgerMinAmount || ledgerMaxAmount);
  const ledgerReconciliationDelta = Math.round((ledgerCurrentBalance - ledgerSummary.netBalance) * 100) / 100;
  const showLedgerWarning = selectedAccount && Math.abs(ledgerReconciliationDelta) > 0.009;
  const showNoVisibleTransactionsWarning = selectedAccount && filteredLedgerRows.length === 0 && Math.abs(ledgerCurrentBalance) > 0.009;
  const isSelectedPartner = selectedAccount?.type === "partner";
  const standardLedgerSummaryView = !isSelectedPartner
    ? ledgerSummary as {
        expenses: number;
        advances: number;
        settlements: number;
        income: number;
        other: number;
        netBalance: number;
      }
    : null;
  const partnerLedgerOverviewView = isSelectedPartner
    ? rawPartnerLedgerOverview as {
        capitalInjected: number;
        directVoucherExpensesPaid: number;
        directLabourAdvancesPaid: number;
        directExpensesPaid: number;
        transfersIn: number;
        transfersOut: number;
        moneyReturned: number;
        adjustments: number;
        netBalance: number;
      }
    : null;
  const standardLedgerBreakdownView = !isSelectedPartner
    ? ledgerBreakdown as {
        salesReceived: number;
        voucherExpensesPaid: number;
        labourAdvancesPaid: number;
        settlementsSent: number;
        settlementsReceived: number;
        contributions: number;
        withdrawals: number;
        netBalance: number;
      }
    : null;
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
      {canCreateAccounts && <FormCard title={t("accountsPage.createAccount")}>
        <form className="module-form compact-form" onSubmit={(event) => void submit(event)}>
          <input required placeholder={t("accountsPage.accountName")} value={name} onChange={(event) => setName(event.target.value)} />
          <select value={type} onChange={(event) => setType(event.target.value as Account["type"])}>
            <option value="cash">{t("accountsPage.cash")}</option><option value="bank">{t("accountsPage.bank")}</option><option value="partner">{t("accountsPage.partner")}</option>
          </select>
          <button type="submit">{t("accountsPage.createAccount")}</button>
        </form>
      </FormCard>}
      <section className="record-panel">
        <h2>{t("accountsPage.yourAccounts")}</h2>
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
              <small>{t("accountsPage.viewDetails")}</small>
            </article>
          ))}
        </div>
      </section>
      <section className="record-panel">
        <h2>{t("accountsPage.expenseVisibility")}</h2>
        <div className="record-list">
          <article className="account-card-clickable" role="button" tabIndex={0} onClick={() => openExpenseVisibility("voucher")}><strong>{t("accountsPage.voucherExpenses")}</strong><span>{money(totalVoucherExpenses)}</span><small>{t("accountsPage.viewDetails")}</small></article>
          <article className="account-card-clickable" role="button" tabIndex={0} onClick={() => openExpenseVisibility("advance")}><strong>{t("accountsPage.labourAdvances")}</strong><span>{money(totalAdvances)}</span><small>{t("accountsPage.viewDetails")}</small></article>
          <article className="account-card-clickable" role="button" tabIndex={0} onClick={() => openExpenseVisibility("combined")}><strong>{t("accountsPage.totalBusinessExpenses")}</strong><span>{money(totalVoucherExpenses + totalAdvances)}</span><small>{t("accountsPage.viewDetails")}</small></article>
        </div>
      </section>
      <Summary
        label={t("accountsPage.netOperatingPosition")}
        value={money(activeSales.reduce((sum, item) => sum + item.amount, 0) - totalVoucherExpenses - totalAdvances)}
      />
      {selectedAccount && <div className="worker-dialog-backdrop worker-action-backdrop" role="presentation" onClick={() => setSelectedAccountId(null)}>
        <section className="worker-action-dialog account-ledger-dialog" role="dialog" aria-modal="true" aria-label={t("accountsPage.accountLedgerDetails")} onClick={(event) => event.stopPropagation()}>
          <header><h2>{t("accountsPage.ledgerTitle", { name: selectedAccount.name })}</h2><button aria-label={t("common.close")} type="button" onClick={() => setSelectedAccountId(null)}><X size={19} /></button></header>
          <div className="worker-action-form">
            {isSelectedPartner && partnerLedgerOverviewView ? <>
              <div className="account-ledger-breakdown account-ledger-breakdown--partner">
                <article><strong>{t("accountsPage.currentAccount")}</strong><b>{selectedAccount.name}</b></article>
                <article><strong>{t("accountsPage.currentPartnerBalance")}</strong><b>{money(ledgerCurrentBalance)}</b></article>
                <article><strong>{t("accountsPage.capitalInjected")}</strong><span>{money(partnerLedgerOverviewView.capitalInjected)}</span></article>
                <article className="account-ledger-breakdown__expenses-card">
                  <strong>{t("accountsPage.directExpensesPaid")}</strong>
                  <b>{money(partnerLedgerOverviewView.directExpensesPaid)}</b>
                  <small>{t("accountsPage.directVoucherExpensesPaid")}: {money(partnerLedgerOverviewView.directVoucherExpensesPaid)}</small>
                  <small>{t("accountsPage.directLabourAdvancesPaid")}: {money(partnerLedgerOverviewView.directLabourAdvancesPaid)}</small>
                </article>
                <article><strong>{t("accountsPage.transfersOut")}</strong><span>{money(partnerLedgerOverviewView.transfersOut)}</span></article>
                <article><strong>{t("accountsPage.transfersIn")}</strong><span>{money(partnerLedgerOverviewView.transfersIn)}</span></article>
                <article><strong>{t("accountsPage.moneyReturned")}</strong><span>{money(partnerLedgerOverviewView.moneyReturned)}</span></article>
                <article><strong>{t("accountsPage.adjustments")}</strong><span>{money(partnerLedgerOverviewView.adjustments)}</span></article>
              </div>
              <section className="account-ledger-reconciliation">
                <h3>{t("accountsPage.reconciliationTitle")}</h3>
                <div className="account-ledger-reconciliation__rows">
                  <div><span>{t("accountsPage.capitalInjected")}</span><strong>{money(partnerLedgerOverviewView.capitalInjected)}</strong></div>
                  <div><span>+ {t("accountsPage.directExpensesPaid")}</span><strong>{money(partnerLedgerOverviewView.directExpensesPaid)}</strong></div>
                  <div><span>+ {t("accountsPage.transfersOut")}</span><strong>{money(partnerLedgerOverviewView.transfersOut)}</strong></div>
                  <div><span>- {t("accountsPage.transfersIn")}</span><strong>{money(partnerLedgerOverviewView.transfersIn)}</strong></div>
                  <div><span>- {t("accountsPage.moneyReturned")}</span><strong>{money(partnerLedgerOverviewView.moneyReturned)}</strong></div>
                  <div><span>+/- {t("accountsPage.adjustments")}</span><strong>{money(partnerLedgerOverviewView.adjustments)}</strong></div>
                  <div className="account-ledger-reconciliation__total"><span>= {t("accountsPage.reconciliationComputed")}</span><strong>{money(partnerLedgerOverviewView.netBalance)}</strong></div>
                </div>
                {Math.abs(partnerLedgerOverviewView.netBalance - ledgerCurrentBalance) > 0.009 && <p className="worker-action-warning">{t("accountsPage.reconciliationComponentsWarning")}</p>}
              </section>
            </> : <div className="account-ledger-breakdown">
              <article><strong>{t("accountsPage.currentAccount")}</strong><span>{selectedAccount.name}</span></article>
              <article>
                <strong>{isSelectedPartner ? t("accountsPage.currentPartnerBalance") : t("accountsPage.currentBalance")}</strong>
                <b>{money(ledgerCurrentBalance)}</b>
              </article>
              {!isSelectedPartner && <>
                <article><strong>{t("accountsPage.voucherExpensesPaid")}</strong><span>{money(standardLedgerSummaryView?.expenses ?? 0)}</span></article>
                <article><strong>{t("accountsPage.labourAdvancesPaid")}</strong><span>{money(standardLedgerSummaryView?.advances ?? 0)}</span></article>
                <article><strong>{t("accountsPage.partnerSettlementsNet")}</strong><span>{money(standardLedgerSummaryView?.settlements ?? 0)}</span></article>
                <article><strong>{t("accountsPage.incomeFundsSales")}</strong><span>{money(standardLedgerSummaryView?.income ?? 0)}</span></article>
                <article><strong>{t("accountsPage.otherTransactions")}</strong><span>{money(standardLedgerSummaryView?.other ?? 0)}</span></article>
                <article><strong>{t("accountsPage.netBalance")}</strong><b>{money(standardLedgerSummaryView?.netBalance ?? 0)}</b></article>
              </>}
            </div>}
            {showLedgerWarning && <p className="worker-action-warning">{hasLedgerFilters ? t("accountsPage.filteredReconciliationWarning") : t("accountsPage.reconciliationWarning", { delta: money(ledgerReconciliationDelta) })}</p>}
            {!isSelectedPartner && <div className="account-ledger-breakdown">
              <>
                <article><strong>{t("accountsPage.voucherExpensesPaid")}</strong><span>{money(standardLedgerBreakdownView?.voucherExpensesPaid ?? 0)}</span></article>
                <article><strong>{t("accountsPage.salesReceived")}</strong><span>{money(standardLedgerBreakdownView?.salesReceived ?? 0)}</span></article>
                <article><strong>{t("accountsPage.labourAdvancesPaid")}</strong><span>{money(standardLedgerBreakdownView?.labourAdvancesPaid ?? 0)}</span></article>
                <article><strong>{t("accountsPage.partnerSettlementsSent")}</strong><span>{money(standardLedgerBreakdownView?.settlementsSent ?? 0)}</span></article>
                <article><strong>{t("accountsPage.partnerSettlementsReceived")}</strong><span>{money(standardLedgerBreakdownView?.settlementsReceived ?? 0)}</span></article>
                <article><strong>{t("accountsPage.contributions")}</strong><span>{money(standardLedgerBreakdownView?.contributions ?? 0)}</span></article>
                <article><strong>{t("accountsPage.withdrawals")}</strong><span>{money(standardLedgerBreakdownView?.withdrawals ?? 0)}</span></article>
                <article><strong>{t("accountsPage.netBalance")}</strong><b>{money(standardLedgerBreakdownView?.netBalance ?? 0)}</b></article>
              </>
            </div>}
            <div className="account-ledger-filters">
              <SearchInput placeholder={t("accountsPage.ledgerSearchPlaceholder")} value={ledgerSearch} onChange={setLedgerSearch} />
              <ClearableSelect value={ledgerType} clearValue="all" onChange={(value) => setLedgerType(value as typeof ledgerType)}>
                <option value="all">{t("accountsPage.allTypes")}</option>
                {!isSelectedPartner && <option value="sale">{t("accountsPage.saleCredit")}</option>}
                <option value="voucher">{t("accountsPage.voucherExpense")}</option>
                <option value="advance">{t("accountsPage.labourAdvance")}</option>
                <option value="settlement_sent">{t("accountsPage.settlementSent")}</option>
                <option value="settlement_received">{t("accountsPage.settlementReceived")}</option>
                <option value="contribution">{t("accountsPage.contribution")}</option>
                <option value="withdrawal">{t("accountsPage.withdrawal")}</option>
                {isSelectedPartner && <option value="adjustment">{t("accountsPage.adjustment")}</option>}
              </ClearableSelect>
              <input aria-label={t("accountsPage.ledgerFromDate")} type="date" value={ledgerFrom} onChange={(event) => setLedgerFrom(event.target.value)} />
              <input aria-label={t("accountsPage.ledgerToDate")} type="date" value={ledgerTo} onChange={(event) => setLedgerTo(event.target.value)} />
              <input aria-label={t("accountsPage.minimumAmount")} inputMode="decimal" placeholder={t("accountsPage.minimumAmount")} value={ledgerMinAmount} onChange={(event) => setLedgerMinAmount(event.target.value)} />
              <input aria-label={t("accountsPage.maximumAmount")} inputMode="decimal" placeholder={t("accountsPage.maximumAmount")} value={ledgerMaxAmount} onChange={(event) => setLedgerMaxAmount(event.target.value)} />
            </div>
            {showNoVisibleTransactionsWarning && <p className="worker-action-warning">{t("accountsPage.noVisibleTransactionsWarning")}</p>}
            <label className="account-ledger-toggle"><input type="checkbox" checked={showEmptyLedgerGroups} onChange={(event) => setShowEmptyLedgerGroups(event.target.checked)} />{t("accountsPage.showEmptyGroups")}</label>
            {isSelectedPartner
              ? (!visiblePartnerLedgerGroups.length ? <Empty>{t("accountsPage.noGroupedTransactions")}</Empty> : <div className="account-transaction-groups">
              {visiblePartnerLedgerGroups.map((group) => {
                const expanded = partnerLedgerGroupExpanded[group.groupKey];
                return <section className="account-transaction-group" key={group.groupKey}>
                  <button className="account-transaction-group__header" type="button" onClick={() => setPartnerLedgerGroupExpanded((current) => ({ ...current, [group.groupKey]: !current[group.groupKey] }))}>
                    <span className="account-transaction-group__title">{expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}{partnerLiabilityGroupTitle(group.groupKey)}</span>
                    <span className="account-transaction-group__meta"><strong>{money(partnerLiabilityGroupDisplayTotal(group.groupKey, group.totalAmount))}</strong><small>{t("accountsPage.transactionCount", { count: group.count })}</small></span>
                  </button>
                  {expanded && <>
                    <div className="attendance-import-table-wrap report-wide-table">
                      <table>
                        <thead><tr><th>{t("expensesPage.date")}</th><th>{t("partnerLedgerPage.type")}</th><th>{t("accountsPage.reference")}</th><th>{t("expensesPage.description")}</th><th>{t("accountsPage.debit")}</th><th>{t("accountsPage.credit")}</th><th>{t("accountsPage.runningBalance")}</th><th>{t("accountsPage.source")}</th></tr></thead>
                        <tbody>
                          {group.transactions.map((row) => <tr key={row.id}>
                            <td>{row.date}</td>
                            <td>{ledgerTypeLabel(row)}</td>
                            <td>{row.reference}</td>
                            <td>{row.description}{row.counterparty ? ` (${row.counterparty})` : ""}</td>
                            <td>{row.debit ? money(row.debit) : "-"}</td>
                            <td>{row.credit ? money(row.credit) : "-"}</td>
                            <td>{money(row.runningBalance ?? 0)}</td>
                            <td><button type="button" onClick={() => openSource(row)}>{t("accountsPage.open")}</button></td>
                          </tr>)}
                        </tbody>
                      </table>
                    </div>
                    <div className="report-mobile-cards">
                      {group.transactions.map((row) => <article className="report-mobile-card" key={`mobile-${row.id}`}>
                        <header><strong>{row.reference}</strong><b>{row.credit ? `+${money(row.credit)}` : `-${money(row.debit)}`}</b></header>
                        <span>{row.date} | {ledgerTypeLabel(row)}</span>
                        <p>{row.description}{row.counterparty ? ` (${row.counterparty})` : ""}</p>
                        <div className="report-mobile-card__balance"><span>{t("accountsPage.runningBalance")}</span><strong>{money(row.runningBalance ?? 0)}</strong></div>
                        <details>
                          <summary>{t("accountsPage.viewDetails")}</summary>
                          <dl>
                            <div><dt>{t("accountsPage.debit")}</dt><dd>{row.debit ? money(row.debit) : "-"}</dd></div>
                            <div><dt>{t("accountsPage.credit")}</dt><dd>{row.credit ? money(row.credit) : "-"}</dd></div>
                          </dl>
                          <button type="button" onClick={() => openSource(row)}>{t("accountsPage.open")}</button>
                        </details>
                      </article>)}
                    </div>
                  </>}
                </section>;
              })}
            </div>)
              : (!visibleLedgerGroups.length ? <Empty>{t("accountsPage.noGroupedTransactions")}</Empty> : <div className="account-transaction-groups">
              {visibleLedgerGroups.map((group) => {
                const expanded = ledgerGroupExpanded[group.groupKey];
                return <section className="account-transaction-group" key={group.groupKey}>
                  <button className="account-transaction-group__header" type="button" onClick={() => setLedgerGroupExpanded((current) => ({ ...current, [group.groupKey]: !current[group.groupKey] }))}>
                    <span className="account-transaction-group__title">{expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}{ledgerGroupTitle(group.groupKey)}</span>
                    <span className="account-transaction-group__meta"><strong>{money(group.totalAmount)}</strong><small>{t("accountsPage.transactionCount", { count: group.count })}</small></span>
                  </button>
                  {expanded && <>
                    <div className="attendance-import-table-wrap report-wide-table">
                      <table>
                        <thead><tr><th>{t("expensesPage.date")}</th><th>{t("partnerLedgerPage.type")}</th><th>{t("accountsPage.reference")}</th><th>{t("expensesPage.description")}</th><th>{t("accountsPage.debit")}</th><th>{t("accountsPage.credit")}</th><th>{t("accountsPage.runningBalance")}</th><th>{t("accountsPage.source")}</th></tr></thead>
                        <tbody>
                          {group.transactions.map((row) => <tr key={row.id}>
                            <td>{row.date}</td>
                            <td>{ledgerTypeLabel(row)}</td>
                            <td>{row.reference}</td>
                            <td>{row.description}{row.counterparty ? ` (${row.counterparty})` : ""}</td>
                            <td>{row.debit ? money(row.debit) : "-"}</td>
                            <td>{row.credit ? money(row.credit) : "-"}</td>
                            <td>{money(row.runningBalance ?? 0)}</td>
                            <td><button type="button" onClick={() => openSource(row)}>{t("accountsPage.open")}</button></td>
                          </tr>)}
                        </tbody>
                      </table>
                    </div>
                    <div className="report-mobile-cards">
                      {group.transactions.map((row) => <article className="report-mobile-card" key={`mobile-${row.id}`}>
                        <header><strong>{row.reference}</strong><b>{row.credit ? `+${money(row.credit)}` : `-${money(row.debit)}`}</b></header>
                        <span>{row.date} | {ledgerTypeLabel(row)}</span>
                        <p>{row.description}{row.counterparty ? ` (${row.counterparty})` : ""}</p>
                        <div className="report-mobile-card__balance"><span>{t("accountsPage.runningBalance")}</span><strong>{money(row.runningBalance ?? 0)}</strong></div>
                        <details>
                          <summary>{t("accountsPage.viewDetails")}</summary>
                          <dl>
                            <div><dt>{t("accountsPage.debit")}</dt><dd>{row.debit ? money(row.debit) : "-"}</dd></div>
                            <div><dt>{t("accountsPage.credit")}</dt><dd>{row.credit ? money(row.credit) : "-"}</dd></div>
                          </dl>
                          <button type="button" onClick={() => openSource(row)}>{t("accountsPage.openSource")}</button>
                        </details>
                      </article>)}
                    </div>
                  </>}
                </section>;
              })}
            </div>)}
            <footer><button type="button" onClick={() => setSelectedAccountId(null)}>{t("accountsPage.back")}</button></footer>
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
  const { t } = useTranslation();
  return (
    <section className="record-panel">
      <h2>{t("accountsPage.recentRecords")}</h2>
      {!rows.length ? <Empty>{empty}</Empty> : (
        <div className="record-list">
          {rows.map((row, index) => <article key={`${row[0]}-${index}`}>{row.map((cell, item) => item === 0 ? <strong key={cell}>{cell}</strong> : <span key={`${cell}-${item}`}>{cell}</span>)}{actions?.[index]}</article>)}
        </div>
      )}
    </section>
  );
}

export function ModulePage({
  module,
  workforceMode = "register",
  onAttendanceClose,
  onAdvanceClose,
}: {
  module: ModuleKey;
  workforceMode?: "register" | "attendance" | "advance";
  onAttendanceClose?: () => void;
  onAdvanceClose?: () => void;
}) {
  const { t } = useTranslation();
  const moduleTitle = workforceMode === "advance"
    ? t("layout.advances")
    : workforceMode === "attendance"
      ? t("layout.attendance")
      : t(`moduleTitles.${module}`);
  const moduleDescription = workforceMode === "advance"
    ? t("advancesPage.introDescription")
    : t(`moduleDescriptions.${module}`);

  return (
    <div className="dashboard-page">
      <SubpageHeader title={moduleTitle} />
      <main className="subpage module-workspace">
        <section className="workspace-intro">
          <div>
            <h2>{moduleTitle}</h2>
            <p>{moduleDescription}</p>
          </div>
          <span className="local-pill">{t("layout.databaseSynced")}</span>
        </section>
        {module === "workforce" && <WorkforceModule
          openAttendanceOnLoad={workforceMode === "attendance"}
          openAdvanceOnLoad={workforceMode === "advance"}
          onAttendanceClose={onAttendanceClose}
          onAdvanceClose={onAdvanceClose}
        />}
        {module === "expenses" && <ExpensesModule />}
        {module === "dispatch" && <DispatchModule />}
        {module === "sales" && <SalesModule />}
        {module === "accounts" && <AccountsModule />}
        {module === "partnerLedger" && <PartnerLedgerModule />}
      </main>
    </div>
  );
}
