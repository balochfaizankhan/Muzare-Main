import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, ChevronDown, ChevronRight, ChevronUp, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { SearchInput } from "../../components/SearchInput";
import { ClearableSelect } from "../../components/ClearableSelect";
import { ResponsiveMultiSelectField, ResponsiveSelectField } from "../../components/ResponsivePicker";
import { SubpageHeader } from "../../components/SubpageHeader";
import { defaultTransactionGroupExpansion, groupAccountTransactions, type AccountTransactionGroupKey } from "../../lib/accountTransactionGroups";
import { calculateAccountBalance } from "../../lib/accounting";
import { getCanonicalExpenseCategory } from "../../lib/expenseCategories";
import { buildInclusiveDateKeys, chunkAttendanceDateKeys, formatLocalDateKey, normalizeDateKey } from "../../lib/dateOnly";
import { formatMoney, formatNumber } from "../../lib/format";
import { getActiveLabourWageSettlements, getCashAffectingVouchers, getGeneralExpenseVouchers, getLabourWageSettlementAdvanceOffset, getLabourWageSettlementCashPaidAmount, isLabourWageSettlementVoucher } from "../../lib/labourWageSettlements";
import { translateExpenseCategory, translateExpenseSubcategory, translatePaymentType, translateSaleType, translateSalesStatus } from "../../lib/systemTranslations";
import { isActiveOperationalRecord } from "../../lib/operationalRecords";
import { getVoucherDisplayNumber } from "../../lib/vouchers";
import { getActiveVouchers, loadWorkspaceVouchers } from "../../lib/voucherCollections";
import { fetchBootstrap } from "../../lib/api";
import {
  buildPartnerLiabilityPositions,
  buildCanonicalPartnerLiabilityPosition,
  calculatePartnerLiabilityBalance,
  getPartnerBalanceState,
  getPartnerAccountingSnapshot,
  mergePartnerPositionWithCanonical,
  partnerLiabilityGroupDisplayTotal,
  defaultPartnerLiabilityGroupExpansion,
  groupPartnerLiabilityTransactions,
  resolvePartnerAccountId,
  resolvePartnerTransferAccountIdentity,
  type PartnerLiabilityLedgerGroupKey,
} from "../../lib/partnerAccounting";
import { resolveSaleType, saleProduceLabel } from "../../lib/dispatch-sales";
import {
  compareLabourers,
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
  type LabourWageSettlement,
  type WageRate,
} from "../../lib/offline-db";
import { buildAccountIdentityLookup, resolveCanonicalAccountId } from "../../lib/accountIdentity";
import { compareWageRates, getWageRateStatus, normalizeHalfDayRate, summarizeAttendanceWages } from "../../lib/wageRates";
import { deleteOperationalRecord } from "../../services/syncService";
import i18n from "../../i18n";
import { useCanonicalLabourFinancials } from "../../hooks/useCanonicalLabourFinancials";
import { useSyncState } from "../../hooks/useSyncState";

type Report = "attendance" | "advances" | "wage-rates" | "expenditures" | "sales" | "dispatch" | "partner-position" | "account-ledger";
type SortOrder = "desc" | "asc";
type SalesDateType = "saleDate" | "dispatchDate" | "deliveryDate" | "paymentDate" | "createdDate";
type DispatchDateType = "dispatchDate" | "saleDate" | "createdDate";
type SalesTypeFilter = "all" | "dispatch_sale" | "farm_direct_sale";
type ReportViewState = {
  attendance: "register" | "summary";
  advances: "summary" | "log";
  "wage-rates": "list";
  expenditures: "summary" | "log";
  sales: "list";
  dispatch: "list";
  "partner-position": "position" | "ledger";
  "account-ledger": "balances" | "ledger";
};
type ReportRow = {
  id: string;
  cells: ReactNode[];
  details: Array<[string, ReactNode]>;
  title: ReactNode;
  value?: ReactNode;
  meta?: ReactNode;
  onOpen?: () => void;
};
type AccountLedgerReportRow = {
  id: string;
  date: string;
  accountId: string;
  accountName: string;
  type: string;
  typeLabel: string;
  reference: string;
  description: string;
  debit: number;
  credit: number;
  memoAmount?: number;
  running: number;
  path: string;
  classification?: string;
  counterparty?: string;
  partnerLiabilityGroup?: PartnerLiabilityLedgerGroupKey;
};

type AdvanceReportLabourSection = {
  labourer: Labourer;
  paymentTypeLabel: string;
  groupLabel: string;
  transactionCount: number;
  total: number;
  settled: number;
  outstanding: number;
  lastAdvanceDate: string;
  sourceLabel: string;
  records: Advance[];
};

const reportOptions: Report[] = ["attendance", "advances", "wage-rates", "expenditures", "sales", "dispatch", "partner-position", "account-ledger"];
const defaultViews: ReportViewState = {
  attendance: "register",
  advances: "summary",
  "wage-rates": "list",
  expenditures: "summary",
  sales: "list",
  dispatch: "list",
  "partner-position": "position",
  "account-ledger": "balances",
};

const csvCell = (value: unknown) => `"${String(value ?? "").replaceAll("\"", "\"\"")}"`;
const money = formatMoney;
const inRange = (date: string, from: string, to: string) => {
  const dateKey = normalizeDateKey(date);
  const fromKey = normalizeDateKey(from);
  const toKey = normalizeDateKey(to);
  return (!fromKey || dateKey >= fromKey) && (!toKey || dateKey <= toKey);
};
const attendanceMark = (status?: Attendance["status"]) => status === "present" ? "P" : status === "half_day" ? "H" : status === "absent" ? "A" : "-";
const attendancePrintMark = (status?: Attendance["status"]) => status === "present" ? "P" : status === "half_day" ? "½" : status === "absent" ? "A" : "-";
const attendanceStatusClass = (status?: Attendance["status"]) => status ? `register-status register-status--${status}` : "register-status register-status--empty";
const attendancePayable = (status?: Attendance["status"]) => status === "present" ? 1 : status === "half_day" ? 0.5 : 0;
const formatShortDate = (date: string) => date.length >= 10 ? `${date.slice(8, 10)}/${date.slice(5, 7)}` : date;
const formatCsvDate = (date: string) => date.length >= 10 ? `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}` : date;
const formatRangeLabel = (from: string, to: string) => from && to ? `${from} - ${to}` : from ? `${i18n.t("reportsPage.fromDate")} ${from}` : to ? `${i18n.t("reportsPage.toDate")} ${to}` : i18n.t("reportsPage.allDates");
const settlementCardDateFormatter = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });
const settlementCardShortDateFormatter = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const printTimestampFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const formatSettlementCardDate = (value: string) => {
  if (!value) return value;
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return settlementCardDateFormatter.format(date);
};
const formatSettlementCardRange = (from: string, to: string) => {
  if (!from || !to) return `${formatSettlementCardDate(from || to)}${from && to ? ` – ${formatSettlementCardDate(to)}` : ""}`;
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return `${formatSettlementCardDate(from)} – ${formatSettlementCardDate(to)}`;
  const sameYear = start.getFullYear() === end.getFullYear();
  return sameYear
    ? `${settlementCardShortDateFormatter.format(start)} – ${settlementCardDateFormatter.format(end)}`
    : `${settlementCardDateFormatter.format(start)} – ${settlementCardDateFormatter.format(end)}`;
};
const normalizeText = (value?: string | null) => value?.trim() ?? "";
const paymentTypeDisplayLabel = (labourer?: Labourer | null) => translatePaymentType(labourer?.paymentType ?? "daily_wage");
const chunkArray = <T,>(items: T[], size: number) => {
  const chunks: T[][] = [];
  if (size <= 0) return chunks;
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
};
const dispatchReference = (dispatch: Pick<Dispatch, "serialNumber" | "dispatchNumber" | "id" | "date">) =>
  normalizeText(dispatch.serialNumber) || normalizeText(dispatch.dispatchNumber) || `DIS-${dispatch.date.replaceAll("-", "")}-${dispatch.id.slice(0, 3).toUpperCase()}`;
const invoiceReference = (sale: Pick<Sale, "invoiceNumber" | "id">) => normalizeText(sale.invoiceNumber) || "-";
const saleTypeLabel = (sale: Pick<Sale, "saleType" | "dispatchId">) => translateSaleType(resolveSaleType(sale));
const salePaymentStatus = (sale: Sale) => sale.paymentStatus ?? (sale.accountId ? "paid" : "unpaid");
const salePaymentsReceived = (sale: Sale) => {
  if (typeof sale.paymentReceived === "number") return sale.paymentReceived;
  const status = salePaymentStatus(sale);
  if (status === "paid") return sale.amount;
  if (status === "partial") return Math.min(sale.amount, sale.amount / 2);
  return 0;
};
const saleOutstanding = (sale: Sale) => Math.max(sale.amount - salePaymentsReceived(sale), 0);
const expenseLabel = (category?: string | null, subcategory?: string | null) =>
  `${getCanonicalExpenseCategory(category ?? "")} / ${subcategory ? translateExpenseSubcategory(subcategory) : "-"}`;
type VoucherReportLine = {
  id: string;
  voucherId: string;
  voucherNumber: string;
  date: string;
  accountId: string;
  category: string;
  subcategory: string;
  description: string;
  amount: number;
  remarks?: string;
  notes?: string;
};

const voucherReportItems = (voucher: Voucher): VoucherReportLine[] => {
  const voucherNumber = getVoucherDisplayNumber(voucher) || voucher.voucherNumber;
  if (voucher.items?.length) {
    return voucher.items.map((item) => ({
      id: `${voucher.id}:${item.id}`,
      voucherId: voucher.id,
      voucherNumber,
      date: voucher.date,
      accountId: voucher.accountId,
      category: getCanonicalExpenseCategory(item.categoryName ?? item.category),
      subcategory: item.subcategoryName ?? item.subcategory ?? "",
      description: item.description,
      amount: item.amount,
      remarks: item.remarks,
      notes: voucher.notes,
    }));
  }
  return [{
    id: `${voucher.id}:legacy`,
    voucherId: voucher.id,
    voucherNumber,
    date: voucher.date,
    accountId: voucher.accountId,
    category: getCanonicalExpenseCategory(voucher.category),
    subcategory: voucher.subcategory,
    description: voucher.description,
    amount: voucher.amount,
    notes: voucher.notes,
  }];
};

const reportDateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

function formatReportDateValue(value: string) {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return reportDateFormatter.format(date);
}

function formatAttendanceBlockRange(dates: string[]) {
  if (!dates.length) return "";
  const first = formatReportDateValue(dates[0]);
  const last = formatReportDateValue(dates[dates.length - 1]);
  return first === last ? first : `${first} – ${last}`;
}

function todayKey() {
  return formatLocalDateKey(new Date());
}

function startOfWeekKey() {
  const date = new Date();
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return formatLocalDateKey(date);
}

function monthStartKey() {
  const date = new Date();
  date.setDate(1);
  return formatLocalDateKey(date);
}

type SalesReportRecord = {
  sale: Sale;
  saleType: string;
  invoiceNumber: string;
  buyerName: string;
  product: string;
  plot: string;
  unit: string;
  paymentStatus: "paid" | "partial" | "unpaid";
  paymentsReceived: number;
  outstanding: number;
  dispatchReference: string;
  paymentAccount: string;
};

type DispatchReportRecord = {
  id: string;
  dispatch: Dispatch;
  dispatchNumber: string;
  product: string;
  quantity: number;
  unit: string;
  vehicle: string;
  driver: string;
  soldQuantity: number;
  remainingQuantity: number;
  linkedSales: Sale[];
  saleDate?: string;
};

function downloadCsv(filename: string, rows: unknown[][]) {
  const href = URL.createObjectURL(new Blob([rows.map((row) => row.map(csvCell).join(",")).join("\n")], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(href);
}

function buildDateColumns(from: string, to: string, rows: Attendance[]) {
  return buildInclusiveDateKeys(from, to, rows.map((row) => row.date));
}

const fallbackLabourForSort = (id: string, name: string) => ({ id, name, createdAt: "" });

function ReportTable({
  columns,
  empty,
  rows,
  mobileCards = true,
}: {
  columns: string[];
  empty: string;
  rows: ReportRow[];
  mobileCards?: boolean;
}) {
  const { t } = useTranslation();
  if (!rows.length) return <p className="empty-records">{empty}</p>;
  return <>
    <div className="attendance-import-table-wrap report-wide-table">
      <table className="report-data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>{t("reportsPage.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => <tr key={row.id}>
            {row.cells.map((cell, index) => <td key={`${row.id}:${index}`}>{cell}</td>)}
            <td>{row.onOpen && <button type="button" onClick={row.onOpen}>{t("reportsPage.open")}</button>}</td>
          </tr>)}
        </tbody>
      </table>
    </div>
    {mobileCards && <div className="report-mobile-cards">
      {rows.map((row) => <article className="report-mobile-card" key={`mobile:${row.id}`}>
        <header><strong>{row.title}</strong>{row.value && <b>{row.value}</b>}</header>
        {row.meta && <span>{row.meta}</span>}
        <details>
          <summary>{t("reportsPage.viewDetails")}</summary>
          <dl>{row.details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
          {row.onOpen && <button type="button" onClick={row.onOpen}>{t("reportsPage.openSource")}</button>}
        </details>
      </article>)}
    </div>}
  </>;
}

function Kpis({ values }: { values: Array<[string, ReactNode]> }) {
  return <div className="reports-kpis">{values.map(([label, value]) => <article key={label}><span>{label}</span><strong>{value}</strong></article>)}</div>;
}

function ReportDateField({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const openPicker = () => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    if (typeof input.showPicker === "function") {
      try {
        input.showPicker();
      } catch {
        input.click();
      }
    } else {
      input.click();
    }
  };
  return (
    <label className="reports-date-field" onPointerDown={(event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      openPicker();
    }}>
      <span className="sr-only">{label}</span>
      <CalendarDays size={16} aria-hidden="true" />
      <span className={`reports-date-field__value${value ? " is-filled" : ""}`}>
        {value ? formatReportDateValue(value) : placeholder}
      </span>
      <input ref={inputRef} aria-label={label} type="date" value={value} onChange={(event) => onChange(event.target.value)} onClick={(event) => event.stopPropagation()} />
    </label>
  );
}

function ReportShell({
  title,
  rangeLabel,
  sectionId,
  onPrint,
  onExport,
  onPdfExport,
  printLabel,
  exportLabel,
  pdfLabel,
  children,
}: {
  title: string;
  rangeLabel: string;
  sectionId: string;
  onPrint: () => void;
  onExport: () => void;
  onPdfExport?: () => void;
  printLabel?: string;
  exportLabel?: string;
  pdfLabel?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return <section className="record-panel reports-print-section" data-print-section={sectionId}>
    <header className="reports-view-header">
      <div>
        <h2>{title}</h2>
        <p>{rangeLabel}</p>
      </div>
      <div className="reports-actions">
        <button type="button" onClick={onExport}>{exportLabel ?? t("reportsPage.exportCsv")}</button>
        {onPdfExport ? <button type="button" onClick={onPdfExport}>{pdfLabel ?? "Export PDF"}</button> : null}
        <button type="button" onClick={onPrint}>{printLabel ?? t("reportsPage.print")}</button>
      </div>
    </header>
    {children}
  </section>;
}

export function Reports() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token, user } = useAuth();
  const sync = useSyncState();
  const [searchParams, setSearchParams] = useSearchParams();
  const bootstrapQuery = useQuery({
    queryKey: ["reports-bootstrap", user?.workspaceId, sync.farmId, sync.seasonId],
    queryFn: () => fetchBootstrap(token!),
    enabled: Boolean(token),
  });
  const canonicalFinancials = useCanonicalLabourFinancials();
  const requestedReport = searchParams.get("report");
  const normalizedRequestedReport = requestedReport === "combined-expenses" ? "expenditures" : requestedReport as Report | null;
  const [report, setReport] = useState<Report>(normalizedRequestedReport && reportOptions.includes(normalizedRequestedReport) ? normalizedRequestedReport : "attendance");
  const [views, setViews] = useState<ReportViewState>(defaultViews);
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [accountId, setAccountId] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [selectedLabourerIds, setSelectedLabourerIds] = useState<string[]>([]);
  const [category, setCategory] = useState("");
  const [subcategory, setSubcategory] = useState("");
  const [status, setStatus] = useState("");
  const [amountMin, setAmountMin] = useState("");
  const [amountMax, setAmountMax] = useState("");
  const [advanceSort, setAdvanceSort] = useState<SortOrder>("desc");
  const [expenseSort, setExpenseSort] = useState<SortOrder>("desc");
  const [salesDateType, setSalesDateType] = useState<SalesDateType>("saleDate");
  const [dispatchDateType, setDispatchDateType] = useState<DispatchDateType>("dispatchDate");
  const [buyerFilter, setBuyerFilter] = useState("");
  const [productFilter, setProductFilter] = useState("");
  const [vehicleFilter, setVehicleFilter] = useState("");
  const [paymentStatusFilter, setPaymentStatusFilter] = useState("");
  const [saleTypeFilter, setSaleTypeFilter] = useState<SalesTypeFilter>("all");
  const [showEmptyLedgerGroups, setShowEmptyLedgerGroups] = useState(false);
  const [reportGroupExpanded, setReportGroupExpanded] = useState<Record<AccountTransactionGroupKey, boolean>>(defaultTransactionGroupExpansion);
  const [partnerReportGroupExpanded, setPartnerReportGroupExpanded] = useState<Record<PartnerLiabilityLedgerGroupKey, boolean>>(defaultPartnerLiabilityGroupExpansion);
  const [attendanceRegisterExpandedLabourerId, setAttendanceRegisterExpandedLabourerId] = useState<string | null>(null);
  const [labourers, setLabourers] = useState<Labourer[]>([]);
  const [attendance, setAttendance] = useState<Attendance[]>([]);
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [_advances, setAdvances] = useState<Advance[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [wageRates, setWageRates] = useState<WageRate[]>([]);
  const [labourWageSettlements, setLabourWageSettlements] = useState<LabourWageSettlement[]>([]);
  const [entries, setEntries] = useState<PartnerEntry[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [dispatches, setDispatches] = useState<Dispatch[]>([]);
  const [selectedSaleRecord, setSelectedSaleRecord] = useState<SalesReportRecord | null>(null);
  const [selectedDispatchRecord, setSelectedDispatchRecord] = useState<DispatchReportRecord | null>(null);
  const [attendanceMoreFiltersOpen, setAttendanceMoreFiltersOpen] = useState(false);
  const [advanceMoreFiltersOpen, setAdvanceMoreFiltersOpen] = useState(false);
  const reportTabRefs = useRef<Partial<Record<Report, HTMLButtonElement | null>>>({});
  useEffect(() => {
    if (normalizedRequestedReport && reportOptions.includes(normalizedRequestedReport)) {
      setReport(normalizedRequestedReport);
    }
    const nextFrom = searchParams.get("from");
    const nextTo = searchParams.get("to");
    const nextGroup = searchParams.get("group");
    const nextLabourIds = searchParams.get("labourIds");
    if (nextFrom !== null) setFrom(nextFrom);
    if (nextTo !== null) setTo(nextTo);
    if (nextGroup !== null) setGroupFilter(nextGroup);
    if (nextLabourIds !== null) {
      setSelectedLabourerIds(nextLabourIds.split(",").map((item) => item.trim()).filter(Boolean));
    }
  }, [normalizedRequestedReport, requestedReport, searchParams]);
  const deleteSaleRecord = async (sale: Sale) => {
    if (!window.confirm(`Delete sale${sale.invoiceNumber ? ` ${sale.invoiceNumber}` : ""}?`)) return;
    await deleteOperationalRecord("sale", sale);
    setSales((current) => current.filter((item) => item.id !== sale.id));
    setSelectedSaleRecord(null);
    window.dispatchEvent(new CustomEvent("muzare-toast", { detail: t("reportsPage.saleDeletedSuccessfully") }));
  };

  useEffect(() => {
    let active = true;
    let requestSequence = 0;
    const loadScopedRecords = () => {
      const sequence = ++requestSequence;
      return Promise.all([
      workspaceRecords(offlineDb.labourers),
      workspaceRecords(offlineDb.attendance),
      loadWorkspaceVouchers({ includeGeneralFarmRecords: true, includeImportedAcrossSeasons: true }),
      workspaceRecords(offlineDb.advances),
      workspaceRecords(offlineDb.labourWageSettlements),
      workspaceRecords(offlineDb.wageRates, { includeDeleted: true }),
      workspaceRecords(offlineDb.accounts, { includeImportedAcrossSeasons: true }),
      workspaceRecords(offlineDb.partnerEntries),
      workspaceRecords(offlineDb.sales),
      workspaceRecords(offlineDb.dispatches),
    ]).then(([nextLabourers, nextAttendance, nextVouchers, nextAdvances, nextSettlements, nextWageRates, nextAccounts, nextEntries, nextSales, nextDispatches]) => {
      if (!active || sequence !== requestSequence) return;
      setLabourers(nextLabourers.sort(compareLabourers));
      setAttendance(nextAttendance);
      setVouchers(nextVouchers);
      setAdvances(nextAdvances);
      setLabourWageSettlements(nextSettlements);
      setWageRates(nextWageRates);
      setAccounts(nextAccounts);
      setEntries(nextEntries);
      setSales(nextSales);
      setDispatches(nextDispatches);
      });
    };
    const reloadScopedRecords = () => { void loadScopedRecords(); };
    void loadScopedRecords();
    window.addEventListener("muzare-local-data-change", reloadScopedRecords);
    window.addEventListener("muzare-data-refresh", reloadScopedRecords);
    return () => {
      active = false;
      window.removeEventListener("muzare-local-data-change", reloadScopedRecords);
      window.removeEventListener("muzare-data-refresh", reloadScopedRecords);
    };
  }, [bootstrapQuery.data?.activeFarmId, bootstrapQuery.data?.activeSeasonId, sync.farmId, sync.seasonId, user?.workspaceId]);

  useEffect(() => {
    if (normalizedRequestedReport && reportOptions.includes(normalizedRequestedReport)) setReport(normalizedRequestedReport);
  }, [normalizedRequestedReport]);

  useEffect(() => {
    const clearPrintTarget = () => {
      document.querySelectorAll(".reports-print-section.is-print-target").forEach((node) => node.classList.remove("is-print-target"));
    };
    window.addEventListener("afterprint", clearPrintTarget);
    return () => window.removeEventListener("afterprint", clearPrintTarget);
  }, []);

  const labourById = useMemo(() => new Map(labourers.map((labourer) => [labourer.id, labourer])), [labourers]);
  const accountById = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts]);
  const accountLookup = useMemo(() => buildAccountIdentityLookup(accounts), [accounts]);
  const accountName = (id?: string) => {
    const resolvedId = resolveCanonicalAccountId(id ?? null, accountLookup);
    return (resolvedId ? accountById.get(resolvedId) : accountById.get(id ?? ""))?.name ?? t("reportsPage.unknownAccount");
  };
  const labourName = (id: string) => labourById.get(id)?.name ?? t("reportsPage.unknownLabour");
  const advanceRecipientName = (record: {
    recipientDisplayName?: string | null;
    recipientName?: string | null;
    labourerId?: string | null;
  }) => record.recipientDisplayName || record.recipientName || (record.labourerId ? labourName(record.labourerId) : "Unresolved recipient");
  const advancePaymentSourceName = (record: {
    paymentSourceDisplayName?: string | null;
    sourceAccountName?: string | null;
    accountId?: string | null;
  }) => record.paymentSourceDisplayName || record.sourceAccountName || accountName(record.accountId ?? "");
  const ledgerGroupTitle = (groupKey: AccountTransactionGroupKey) => ({
    expenses: t("reportsPage.groupExpenses"),
    advances: t("reportsPage.groupAdvances"),
    settlements: t("reportsPage.groupSettlements"),
    income: t("reportsPage.groupIncome"),
    other: t("reportsPage.groupOther"),
  }[groupKey]);
  const partnerLiabilityGroupTitle = (groupKey: PartnerLiabilityLedgerGroupKey) => ({
    capital_injected: t("reportsPage.capitalInjected"),
    purchase_vouchers_paid: "Purchase vouchers paid",
    labour_advances_paid: "Labour advances paid",
    labour_wage_settlements: "Labour wage settlements",
    transfers_out: t("reportsPage.transfersOut"),
    transfers_in: t("reportsPage.transfersIn"),
    money_returned: t("reportsPage.moneyReturned"),
    adjustments: t("reportsPage.adjustments"),
    other: t("reportsPage.groupOther"),
  }[groupKey]);
  const labourGroups = useMemo(() => [...new Set(labourers.map((labourer) => labourer.group?.trim()).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b)), [labourers]);
  const term = search.trim().toLowerCase();
  const min = amountMin ? Number(amountMin) : null;
  const max = amountMax ? Number(amountMax) : null;
  const rangeLabel = formatRangeLabel(from, to);
  const ungroupedValue = "__ungrouped__";
  const matchesGroup = (labourer?: Labourer) => {
    if (!groupFilter) return true;
    if (groupFilter === ungroupedValue) return !(labourer?.group ?? "").trim();
    return (labourer?.group ?? "") === groupFilter;
  };
  const reportLabourOptions = useMemo(
    () => labourers.filter((labourer) => matchesGroup(labourer)).sort(compareLabourers),
    [groupFilter, labourers],
  );
  const matchesLabourFilter = (labourerId: string) => selectedLabourerIds.length === 0 || selectedLabourerIds.includes(labourerId);

  const matches = (date: string, values: unknown[], amount?: number) => inRange(date, from, to)
    && (min === null || amount === undefined || amount >= min)
    && (max === null || amount === undefined || amount <= max)
    && (!term || values.some((value) => String(value ?? "").toLowerCase().includes(term)));

  const clearFilters = () => {
    setSearch("");
    setFrom("");
    setTo("");
    setAccountId("");
    setGroupFilter("");
    setSelectedLabourerIds([]);
    setCategory("");
    setSubcategory("");
    setStatus("");
    setAmountMin("");
    setAmountMax("");
    setBuyerFilter("");
    setProductFilter("");
    setVehicleFilter("");
    setPaymentStatusFilter("");
    setSaleTypeFilter("all");
    setSalesDateType("saleDate");
    setDispatchDateType("dispatchDate");
    setAttendanceMoreFiltersOpen(false);
    setAdvanceMoreFiltersOpen(false);
  };

  useEffect(() => {
    setSelectedLabourerIds((current) => current.filter((id) => reportLabourOptions.some((labourer) => labourer.id === id)));
  }, [reportLabourOptions]);

  const applyTodayRange = () => {
    const value = todayKey();
    setFrom(value);
    setTo(value);
  };

  const applyWeekRange = () => {
    setFrom(startOfWeekKey());
    setTo(todayKey());
  };

  const applyMonthRange = () => {
    setFrom(monthStartKey());
    setTo(todayKey());
  };

  const labourFilterActive = (report === "attendance" || report === "advances" || report === "wage-rates") && selectedLabourerIds.length > 0;
  const filtered = Boolean(search || from || to || accountId || groupFilter || labourFilterActive || category || subcategory || status || amountMin || amountMax || buyerFilter || productFilter || vehicleFilter || paymentStatusFilter);
  const advancedFilterCount = useMemo(() => {
    if (report === "attendance") return Number(Boolean(groupFilter)) + Number(selectedLabourerIds.length > 0);
    if (report === "advances") return Number(Boolean(groupFilter)) + Number(selectedLabourerIds.length > 0) + Number(Boolean(accountId)) + Number(Boolean(amountMin)) + Number(Boolean(amountMax));
    return 0;
  }, [accountId, amountMax, amountMin, category, groupFilter, report, selectedLabourerIds.length, status]);
  const switchReport = (next: Report) => {
    setReport(next);
    setSearchParams((current) => {
      current.set("report", next);
      return current;
    });
  };
  useEffect(() => {
    reportTabRefs.current[report]?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [report]);
  const switchView = <T extends Report>(reportKey: T, nextView: ReportViewState[T]) => {
    setViews((current) => ({ ...current, [reportKey]: nextView }));
  };
  const openAccountLedger = (nextAccountId: string) => {
    setAccountId(nextAccountId);
    switchView("account-ledger", "ledger");
  };
  const printSection = (sectionId: string) => {
    document.querySelectorAll(".reports-print-section.is-print-target").forEach((node) => node.classList.remove("is-print-target"));
    const section = document.querySelector<HTMLElement>(`.reports-print-section[data-print-section="${sectionId}"]`);
    if (!section) return;
    const printRoot = document.documentElement;
    const cleanupPrintTarget = () => {
      section.classList.remove("is-print-target");
      printRoot.removeAttribute("data-muzare-print-section");
    };
    printRoot.setAttribute("data-muzare-print-section", sectionId);
    section.classList.add("is-print-target");
    window.addEventListener("afterprint", cleanupPrintTarget, { once: true });
    window.print();
  };

  const attendanceRegisterSwitch = (
    <div className="reports-attendance-switch" role="tablist" aria-label={t("reportsPage.title")}>
      <button className={views.attendance === "register" ? "is-active" : ""} type="button" onClick={() => switchView("attendance", "register")}>{t("reportsPage.register")}</button>
      <button className={views.attendance === "summary" ? "is-active" : ""} type="button" onClick={() => switchView("attendance", "summary")}>{t("reportsPage.summary")}</button>
    </div>
  );

  const renderAttendanceRegisterPrintPage = (page: typeof attendancePrintPages[number]) => {
    const labourLabel = attendanceRegisterLabourLabel;
    const labourGroupLabel = attendanceRegisterGroupLabel;
    const printRangeLabel = attendanceDates.length > 0 ? formatAttendanceBlockRange(attendanceDates) : rangeLabel;
    const shownDateRangeLabel = page.dateBlock.length > 0 ? formatAttendanceBlockRange(page.dateBlock) : "-";
    const dateColumnWidthClass = page.density === "normal" ? "attendance-register-print-page--normal" : page.density === "compact" ? "attendance-register-print-page--compact" : "attendance-register-print-page--ultra";
    return (
      <section key={page.id} className={`attendance-register-print-page ${dateColumnWidthClass}`}>
        <header className="attendance-register-print-header">
          <div className="attendance-register-print-brand">
            <strong>Muzare</strong>
            <span>Attendance Register</span>
          </div>
          <div className="attendance-register-print-title">
            <h2>{t("reportsPage.attendanceRegister")}</h2>
            <p>{printRangeLabel}</p>
          </div>
          <dl className="attendance-register-print-meta">
            <div><dt>Farm</dt><dd>{bootstrapFarm?.name ?? "All farms"}</dd></div>
            <div><dt>Season</dt><dd>{bootstrapSeason?.name ?? "All seasons"}</dd></div>
            <div><dt>Group</dt><dd>{labourGroupLabel}</dd></div>
            <div><dt>Labour</dt><dd>{labourLabel}</dd></div>
            <div><dt>Dates shown</dt><dd>{shownDateRangeLabel}</dd></div>
            <div><dt>Generated</dt><dd>{printGeneratedAt}</dd></div>
            <div><dt>By</dt><dd>{printGeneratedBy}</dd></div>
            <div><dt>Page</dt><dd>{page.pageNumber} of {page.totalPages}</dd></div>
          </dl>
        </header>
        <section className="attendance-register-print-summary">
          <article><span>Labour count</span><strong>{attendanceTotals.labourCount}</strong></article>
          <article><span>Present total</span><strong>{attendanceTotals.present}</strong></article>
          <article><span>Half-day total</span><strong>{attendanceTotals.halfDay}</strong></article>
          <article><span>Absent total</span><strong>{attendanceTotals.absent}</strong></article>
          <article><span>Payable days</span><strong>{formatNumber(attendanceTotals.payableDays)}</strong></article>
          <article><span>Attendance wages</span><strong>{money(attendanceTotals.wages)}</strong></article>
        </section>
        <section className="attendance-register-print-legend">
          <span><b>P</b> Present</span>
          <span><b>½</b> Half-day</span>
          <span><b>A</b> Absent</span>
          <span><b>-</b> No entry</span>
        </section>
        <div className="attendance-register-print-table-wrap">
          <table className="attendance-register-print-table report-data-table">
            <colgroup>
              <col style={{ width: "var(--attendance-col-index)" }} />
              <col style={{ width: "var(--attendance-col-name)" }} />
              <col style={{ width: "var(--attendance-col-group)" }} />
              <col style={{ width: "var(--attendance-col-stat)" }} />
              <col style={{ width: "var(--attendance-col-stat)" }} />
              <col style={{ width: "var(--attendance-col-stat)" }} />
              <col style={{ width: "var(--attendance-col-payable)" }} />
              <col style={{ width: "var(--attendance-col-wages)" }} />
              {page.dateBlock.map((date) => <col key={date} style={{ width: "var(--attendance-col-date)" }} />)}
            </colgroup>
            <thead>
              <tr>
                <th>#</th>
                <th>Labour Name</th>
                <th>Group</th>
                <th>P</th>
                <th>1/2</th>
                <th>A</th>
                <th>Payable Days</th>
                <th>Wages (SAR)</th>
                {page.dateBlock.map((date) => <th className="attendance-register-print-date-heading" key={date}><span>{formatShortDate(date)}</span></th>)}
              </tr>
            </thead>
            <tbody>
              {page.labourBlock.length > 0 ? page.labourBlock.map((item, index) => (
                <tr key={item.labourer.id}>
                  <th>{page.labourStartIndex + index + 1}</th>
                  <td>{item.labourer.name}</td>
                  <td>{item.labourer.group || "-"}</td>
                  <td>{item.present}</td>
                  <td>{item.halfDay}</td>
                  <td>{item.absent}</td>
                  <td>{formatNumber(item.payable)}</td>
                  <td>{formatNumber(item.wage)}</td>
                  {page.dateBlock.map((date) => {
                    const record = item.records.find((entry) => entry.date === date);
                    return (
                      <td key={date} className={attendanceStatusClass(record?.status)}>
                        {attendancePrintMark(record?.status)}
                      </td>
                    );
                  })}
                </tr>
              )) : (
                <tr>
                  <td className="attendance-register-print-empty" colSpan={8 + page.dateBlock.length}>No attendance records found for the selected filters.</td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr className="attendance-register-print-total-row">
                <th colSpan={3}>Full-period totals (shown labour)</th>
                <td>{formatNumber(page.pageTotals.present)}</td>
                <td>{formatNumber(page.pageTotals.halfDay)}</td>
                <td>{formatNumber(page.pageTotals.absent)}</td>
                <td>{formatNumber(page.pageTotals.payableDays)}</td>
                <td>{formatNumber(page.pageTotals.wages)}</td>
                {page.dateBlock.map((date, index) => <td key={`${page.id}:total:${date}:${index}`} />)}
              </tr>
              <tr className="attendance-register-print-daily-row">
                <th colSpan={8}>Daily payable totals (shown dates)</th>
                {page.dateTotals.map((total, index) => <td key={`${page.id}:${page.dateBlock[index]}`}>{formatNumber(total)}</td>)}
              </tr>
            </tfoot>
          </table>
        </div>
        <footer className="attendance-register-print-footer">
          <span>Muzare</span>
          <span>Page {page.pageNumber} of {page.totalPages}</span>
          <span>{printRangeLabel}</span>
        </footer>
      </section>
    );
  };

  const renderAdvanceReportPrintPage = () => (
    <section className="advance-report-print-page">
      <header className="advance-report-print-header">
        <div className="advance-report-print-brand">
          <strong>Muzare</strong>
          <span>Labour Advances Report</span>
        </div>
        <div className="advance-report-print-title">
          <h2>{t("reportsPage.advanceSummary")}</h2>
          <p>{rangeLabel}</p>
        </div>
        <dl className="advance-report-print-meta">
          <div><dt>Farm</dt><dd>{bootstrapFarm?.name ?? "All farms"}</dd></div>
          <div><dt>Season</dt><dd>{bootstrapSeason?.name ?? "All seasons"}</dd></div>
          <div><dt>Group</dt><dd>{advanceHeaderGroupLabel}</dd></div>
          <div><dt>Labour</dt><dd>{advanceHeaderLabourLabel}</dd></div>
          <div><dt>Paid from</dt><dd>{advanceHeaderSourceLabel}</dd></div>
          <div><dt>Generated</dt><dd>{advanceReportGeneratedAt}</dd></div>
          <div><dt>By</dt><dd>{printGeneratedBy}</dd></div>
        </dl>
      </header>
      <section className="advance-report-print-summary">
        <article><span>Total advances</span><strong>{money(advanceReportTotals.totalAdvances)}</strong></article>
        <article><span>Unique labourers</span><strong>{formatNumber(advanceReportTotals.uniqueLabourers)}</strong></article>
        <article><span>Transactions</span><strong>{formatNumber(advanceReportTotals.transactions)}</strong></article>
        <article><span>Adjusted in settlements</span><strong>{money(advanceReportTotals.adjustedInSettlements)}</strong></article>
        <article><span>Recovered / refunded</span><strong>{money(advanceReportTotals.recoveredAdvances)}</strong></article>
        <article><span>Outstanding advances</span><strong>{money(advanceReportTotals.outstandingAdvances)}</strong></article>
        <article><span>Posted settlements</span><strong>{formatNumber(advanceReportTotals.postedSettlements)}</strong></article>
      </section>
      <div className="advance-report-print-note">
        <p>Labour advances are grouped by labourer. Each section shows the labour total and the transactions included in the selected period.</p>
      </div>
      <footer className="advance-report-print-footer advance-report-print-footer--summary">
        <span>Muzare</span>
        <span>Page 1 of {Math.max(1, advanceReportLabourSections.length + 1)}</span>
        <span>{advanceReportGeneratedAt}</span>
      </footer>
      <div className="advance-report-print-labours">
        {advanceReportLabourSections.length > 0 ? advanceReportLabourSections.map((section, index) => (
          <article key={section.labourer.id} className="advance-report-print-labour">
            <header className="advance-report-print-labour-header">
              <div>
                <h3>{section.labourer.name}</h3>
                <p>{section.paymentTypeLabel} · {section.groupLabel}</p>
              </div>
              <strong>Total: {money(section.total)}</strong>
            </header>
            <div className="advance-report-print-labour-meta">
              <span>Transactions: {formatNumber(section.transactionCount)}</span>
              <span>Adjusted in settlements: {money(section.settled)}</span>
              <span>Outstanding: {money(section.outstanding)}</span>
              <span>Last advance: {section.lastAdvanceDate || "-"}</span>
            </div>
            <table className="advance-report-print-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Source / Paid From</th>
                  <th>Description</th>
                  <th className="is-amount">Amount (SAR)</th>
                </tr>
              </thead>
              <tbody>
                {section.records.map((record) => (
                  <tr key={record.id}>
                    <td>{record.date}</td>
                    <td>{advancePaymentSourceName(record)}</td>
                    <td>{record.notes || "-"}</td>
                    <td className="is-amount">{formatNumber(record.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <footer className="advance-report-print-footer advance-report-print-footer--labour">
              <span>Muzare</span>
              <span>Page {index + 2} of {Math.max(1, advanceReportLabourSections.length + 1)}</span>
              <span>{advanceReportGeneratedAt}</span>
            </footer>
          </article>
        )) : (
          <div className="advance-report-print-empty">No advances found for the selected filters.</div>
        )}
      </div>
    </section>
  );

  const attendanceRows = attendance
    .filter((item) => {
      const labourer = labourById.get(item.labourerId);
      return matchesGroup(labourer)
        && matchesLabourFilter(item.labourerId)
        && (!status || item.status === status)
        && matches(item.date, [labourName(item.labourerId), labourer?.group, item.status]);
    })
    .sort((a, b) => a.date.localeCompare(b.date)
      || compareLabourers(
        labourById.get(a.labourerId) ?? fallbackLabourForSort(a.labourerId, labourName(a.labourerId)),
        labourById.get(b.labourerId) ?? fallbackLabourForSort(b.labourerId, labourName(b.labourerId)),
      ));
  const attendanceSummary = useMemo(() => labourers
    .filter((labourer) => matchesGroup(labourer))
    .filter((labourer) => matchesLabourFilter(labourer.id))
    .map((labourer) => {
      const summary = summarizeAttendanceWages(
        labourer.id,
        attendanceRows.filter((item) => item.labourerId === labourer.id),
        wageRates,
      );
      return {
        labourer,
        records: summary.records,
        present: summary.present,
        halfDay: summary.halfDay,
        absent: summary.absent,
        payable: summary.payable,
        wage: summary.totalWage,
        wageRateLabel: summary.wageRateLabel,
        missingRateDates: summary.missingRateDates,
      };
    })
    .filter((item) => item.records.length > 0), [attendanceRows, labourers, wageRates]);
  const wageRateReportRows = useMemo(() => wageRates
    .filter((rate) => {
      const labourer = labourById.get(rate.labourerId);
      return matchesGroup(labourer ?? undefined)
        && matchesLabourFilter(rate.labourerId)
        && matches(rate.effectiveFrom, [labourer?.name, labourer?.group, rate.notes, rate.rateType, getWageRateStatus(rate, todayKey())]);
    })
    .sort(compareWageRates), [labourById, matches, selectedLabourerIds, wageRates]);
  const attendanceDates = useMemo(() => buildDateColumns(from, to, attendanceRows), [attendanceRows, from, to]);
  const attendanceTotals = useMemo(() => ({
    labourCount: attendanceSummary.length,
    present: attendanceRows.filter((item) => item.status === "present").length,
    halfDay: attendanceRows.filter((item) => item.status === "half_day").length,
    absent: attendanceRows.filter((item) => item.status === "absent").length,
    payableDays: attendanceSummary.reduce((sum, item) => sum + item.payable, 0),
    wages: attendanceSummary.reduce((sum, item) => sum + item.wage, 0),
  }), [attendanceRows, attendanceSummary]);
  const attendanceDateTotals = useMemo(
    () => attendanceDates.map((date) => attendanceSummary.reduce(
      (sum, item) => sum + attendancePayable(item.records.find((record) => record.date === date)?.status),
      0,
    )),
    [attendanceDates, attendanceSummary],
  );
  const attendanceLabourPageCount = Math.max(Math.ceil(attendanceSummary.length / 35), 1);
  const attendanceLabourBlockSize = Math.max(Math.ceil(attendanceSummary.length / attendanceLabourPageCount), 1);
  const attendanceDateBlocks = useMemo(() => (attendanceDates.length > 0 ? chunkAttendanceDateKeys(attendanceDates) : [[]]), [attendanceDates]);
  const attendanceLabourBlocks = useMemo(() => (attendanceSummary.length > 0 ? chunkArray(attendanceSummary, attendanceLabourBlockSize) : [[]]), [attendanceLabourBlockSize, attendanceSummary]);
  const attendancePrintPages = useMemo(() => {
    const pages: Array<{
      id: string;
      dateBlock: string[];
      labourBlock: typeof attendanceSummary;
      dateBlockIndex: number;
      labourBlockIndex: number;
      labourStartIndex: number;
      pageNumber: number;
      density: "normal" | "compact" | "ultra";
      pageTotals: {
        present: number;
        halfDay: number;
        absent: number;
        payableDays: number;
        wages: number;
      };
      dateTotals: number[];
    }> = [];
    const totalPages = Math.max(attendanceDateBlocks.length * attendanceLabourBlocks.length, 1);
    let pageIndex = 0;
    attendanceDateBlocks.forEach((dateBlock, dateBlockIndex) => {
      attendanceLabourBlocks.forEach((labourBlock, labourBlockIndex) => {
        const density: "normal" | "compact" | "ultra" = dateBlock.length <= 20 ? "normal" : dateBlock.length <= 30 ? "compact" : "ultra";
        const pageTotals = labourBlock.reduce((acc, item) => {
          acc.present += item.present;
          acc.halfDay += item.halfDay;
          acc.absent += item.absent;
          acc.payableDays += item.payable;
          acc.wages += item.wage;
          return acc;
        }, { present: 0, halfDay: 0, absent: 0, payableDays: 0, wages: 0 });
        const dateTotals = dateBlock.map((date) => attendanceSummary.reduce(
          (sum, item) => sum + attendancePayable(item.records.find((record) => record.date === date)?.status),
          0,
        ));
        pages.push({
          id: `${dateBlockIndex}:${labourBlockIndex}`,
          dateBlock,
          labourBlock,
          dateBlockIndex,
          labourBlockIndex,
          labourStartIndex: labourBlockIndex * attendanceLabourBlockSize,
          pageNumber: pageIndex + 1,
          density,
          pageTotals,
          dateTotals,
        });
        pageIndex += 1;
      });
    });
    if (!pages.length) {
      pages.push({
        id: "0:0",
        dateBlock: [],
        labourBlock: [],
        dateBlockIndex: 0,
        labourBlockIndex: 0,
        labourStartIndex: 0,
        pageNumber: 1,
        density: "normal",
        pageTotals: { present: 0, halfDay: 0, absent: 0, payableDays: 0, wages: 0 },
        dateTotals: [],
      });
    }
    return pages.map((page, index) => ({ ...page, pageNumber: index + 1, totalPages }));
  }, [attendanceDateBlocks, attendanceLabourBlockSize, attendanceLabourBlocks, attendanceSummary]);
  const bootstrapFarm = bootstrapQuery.data?.farms.find((farm) => farm.id === bootstrapQuery.data?.activeFarmId) ?? null;
  const bootstrapSeason = bootstrapQuery.data?.seasons.find((season) => season.id === bootstrapQuery.data?.activeSeasonId) ?? null;
  const printGeneratedAt = useMemo(() => printTimestampFormatter.format(new Date()), [attendanceTotals, attendanceDates.length, report, from, to, groupFilter, selectedLabourerIds.join(","), bootstrapQuery.dataUpdatedAt, user?.displayName, user?.email]);
  const printGeneratedBy = user?.displayName ?? user?.email ?? "Unknown";
  const selectedLabourNames = selectedLabourerIds.map((id) => labourById.get(id)?.name).filter(Boolean).join(", ");
  const attendanceRegisterGroupLabel = groupFilter === ungroupedValue ? t("reportsPage.ungrouped") : groupFilter || t("reportsPage.allGroups");
  const attendanceRegisterLabourLabel = selectedLabourNames || t("reportsPage.allLabour");

  useEffect(() => {
    setAttendanceRegisterExpandedLabourerId((current) => current && attendanceSummary.some((item) => item.labourer.id === current) ? current : null);
  }, [attendanceSummary]);

  const replacedLegacySourceIds = useMemo(() => new Set(canonicalFinancials.data?.replacedLegacySourceIds ?? []), [canonicalFinancials.data?.replacedLegacySourceIds]);
  const canonicalAdvanceRows = useMemo(() => (canonicalFinancials.data?.advancePositions ?? []).map((item) => ({
    id: item.voucherId,
    workspaceId: canonicalFinancials.workspaceId,
    farmId: canonicalFinancials.farmId,
    seasonId: canonicalFinancials.seasonId,
    labourerId: item.labourerId ?? "",
    labourGroupId: item.labourGroupId ?? undefined,
    recipientDisplayName: item.recipientDisplayName ?? item.recipientName,
    recipientName: item.recipientName,
    date: item.advanceDate,
    amount: item.originalAmount,
    accountId: item.fundingAccountId ?? "",
    paymentSourceDisplayName: item.paymentSourceDisplayName ?? item.fundingAccountName ?? undefined,
    sourceAccountName: item.fundingAccountName ?? undefined,
    notes: item.description,
    createdAt: `${item.advanceDate}T00:00:00.000Z`,
    updatedAt: `${item.advanceDate}T00:00:00.000Z`,
    voucherNumber: item.voucherNumber,
    canonicalVoucherId: item.canonicalVoucherId ?? null,
    appliedAmount: item.appliedAmount,
    recoveredAmount: item.recoveredAmount,
    outstandingAmount: item.outstandingAmount,
    status: item.status === "VOIDED" ? "VOIDED" : "POSTED",
    reviewRequired: item.needsReview,
    reviewReason: item.reviewReason,
    canonical: true as const,
  })), [canonicalFinancials.data?.advancePositions, canonicalFinancials.farmId, canonicalFinancials.seasonId, canonicalFinancials.workspaceId]);
  const legacyAdvanceRows = useMemo(() => [], []);
  const advanceRows = useMemo(() => [...canonicalAdvanceRows, ...legacyAdvanceRows]
    .filter((item) => {
      const labourer = labourById.get(item.labourerId);
      return matchesGroup(labourer ?? undefined)
        && matchesLabourFilter(item.labourerId)
        && (!accountId || resolveCanonicalAccountId(item.accountId, accountLookup) === accountId)
        && matches(item.date, [advanceRecipientName(item), labourName(item.labourerId), labourer?.group, advancePaymentSourceName(item), item.notes, item.sourceAccountName, item.voucherNumber], item.amount);
    })
    .sort((a, b) => advanceSort === "desc" ? b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt) : a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt)), [accountId, accountLookup, advancePaymentSourceName, advanceRecipientName, advanceSort, canonicalAdvanceRows, labourById, labourName, legacyAdvanceRows, matches, selectedLabourerIds]);
  const advanceSummary = useMemo(() => labourers
    .filter((labourer) => matchesGroup(labourer))
    .filter((labourer) => matchesLabourFilter(labourer.id))
    .map((labourer) => {
      const records = advanceRows.filter((item) => item.labourerId === labourer.id);
      const total = records.reduce((sum, item) => sum + item.amount, 0);
      const applied = records.reduce((sum, item) => sum + item.appliedAmount, 0);
      const recovered = records.reduce((sum, item) => sum + item.recoveredAmount, 0);
      const outstanding = records.reduce((sum, item) => sum + item.outstandingAmount, 0);
      return { labourer, records, total, applied, recovered, outstanding };
    })
    .filter((item) => item.records.length > 0), [advanceRows, attendanceSummary, labourers]);
  const labourGroupOptions = useMemo(() => labourGroups.map((group) => ({ value: group, label: group })), [labourGroups]);
  const reportLabourOptionsWithLabel = useMemo(
    () => reportLabourOptions.map((labourer) => ({ value: labourer.id, label: labourer.name, secondary: labourer.group || t("reportsPage.ungrouped") })),
    [reportLabourOptions, t],
  );
  const accountOptions = useMemo(() => accounts.map((account) => ({ value: account.id, label: account.name, secondary: account.type })), [accounts]);
  const activeSettlements = useMemo(
    () => getActiveLabourWageSettlements(labourWageSettlements)
      .filter((settlement) => !from || settlement.settlementDate >= from)
      .filter((settlement) => !to || settlement.settlementDate <= to),
    [from, labourWageSettlements, to],
  );
  const activeAdvanceReportRows = useMemo(() => advanceRows.filter((item) => item.status !== "VOIDED"), [advanceRows]);
  const advanceReportTotals = useMemo(() => ({
    totalAdvances: activeAdvanceReportRows.reduce((sum, item) => sum + item.amount, 0),
    uniqueLabourers: new Set(activeAdvanceReportRows.map((item) => item.labourerId || item.labourGroupId || item.recipientName)).size,
    transactions: activeAdvanceReportRows.length,
    adjustedInSettlements: activeAdvanceReportRows.reduce((sum, item) => sum + item.appliedAmount, 0),
    recoveredAdvances: activeAdvanceReportRows.reduce((sum, item) => sum + item.recoveredAmount, 0),
    outstandingAdvances: activeAdvanceReportRows.reduce((sum, item) => sum + item.outstandingAmount, 0),
    postedSettlements: activeSettlements.length,
  }), [activeAdvanceReportRows, activeSettlements.length]);
  const advanceReportLabourSections = useMemo<AdvanceReportLabourSection[]>(() => advanceSummary.map((item) => {
    const records = item.records.slice().sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
    const lastAdvanceDate = records[0]?.date ?? "";
    const sourceNames = [...new Set(records.map((record) => advancePaymentSourceName(record)).filter(Boolean))];
    const sourceLabel = sourceNames.length > 1 ? "Multiple payment sources" : sourceNames[0] ?? "-";
    return {
      labourer: item.labourer,
      paymentTypeLabel: paymentTypeDisplayLabel(item.labourer),
      groupLabel: item.labourer.group?.trim() || "-",
      transactionCount: records.length,
      total: item.total,
      settled: item.applied + item.recovered,
      outstanding: item.outstanding,
      lastAdvanceDate,
      sourceLabel: sourceLabel || "-",
      records,
    };
  }), [advancePaymentSourceName, advanceSummary]);
  const advanceHeaderGroupLabel = groupFilter === ungroupedValue ? t("reportsPage.ungrouped") : groupFilter || t("reportsPage.allGroups");
  const advanceHeaderLabourLabel = selectedLabourerIds.length > 0 ? selectedLabourerIds.map((id) => labourById.get(id)?.name).filter(Boolean).join(", ") : t("reportsPage.allLabour");
  const advanceHeaderSourceLabel = accountId ? accountName(accountId) : t("reportsPage.allAccounts");
  const advanceReportGeneratedAt = useMemo(() => printTimestampFormatter.format(new Date()), [advanceReportTotals.adjustedInSettlements, advanceReportTotals.outstandingAdvances, advanceReportTotals.postedSettlements, advanceReportTotals.totalAdvances, advanceReportTotals.transactions, advanceReportTotals.uniqueLabourers]);
  const activeVouchers = useMemo(() => getActiveVouchers(vouchers), [vouchers]);
  const legacyOnlyVouchers = useMemo(() => activeVouchers.filter((item) => !replacedLegacySourceIds.has(item.id)), [activeVouchers, replacedLegacySourceIds]);
  const generalExpenseVouchers = useMemo(() => getGeneralExpenseVouchers(legacyOnlyVouchers, activeSettlements), [activeSettlements, legacyOnlyVouchers]);
  const cashAffectingVouchers = useMemo(() => getCashAffectingVouchers(legacyOnlyVouchers, activeSettlements), [activeSettlements, legacyOnlyVouchers]);

  const voucherBaseRows = useMemo(() => generalExpenseVouchers
    .filter((item) => {
      const lines = voucherReportItems(item);
      return (!accountId || item.accountId === accountId)
        && matches(item.date, [
          getVoucherDisplayNumber(item) || item.voucherNumber,
          item.description,
          item.notes,
          accountName(item.accountId),
          ...lines.flatMap((line) => [line.category, line.subcategory, line.description, line.remarks ?? "", String(line.amount)]),
        ], item.amount);
    }),
  [accountId, accountName, generalExpenseVouchers, matches]);
  const voucherRows = useMemo(() => voucherBaseRows
    .filter((item) => {
      const lines = voucherReportItems(item);
      return (!category || lines.some((line) => line.category === category))
        && (!subcategory || lines.some((line) => (line.subcategory ?? "") === subcategory));
    })
    .sort((a, b) => expenseSort === "desc" ? b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt) : a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt)),
  [category, expenseSort, subcategory, voucherBaseRows]);
  const voucherReportLineRows = useMemo(() => voucherRows.flatMap((item) => voucherReportItems(item)), [voucherRows]);
  const canonicalExpenseRows = useMemo(() => (canonicalFinancials.data?.expenses ?? [])
    .filter((item) => item.active
      && inRange(item.date, from, to)
      && (!category || category === "Labour wages")
      && (!subcategory || subcategory === "Canonical labour due")
      && matches(item.date, [item.dueNumber, item.recipientName, item.description, item.status], item.amount))
    .sort((a, b) => expenseSort === "desc" ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date)),
  [canonicalFinancials.data?.expenses, category, expenseSort, from, matches, subcategory, to]);
  const canonicalExpenseIds = useMemo(() => new Set(canonicalExpenseRows.map((item) => item.id)), [canonicalExpenseRows]);
  const canonicalExpenseAccountRows = useMemo(() => (canonicalFinancials.data?.expenseAccountAttributions ?? [])
    .filter((item) => canonicalExpenseIds.has(item.dueId)),
  [canonicalExpenseIds, canonicalFinancials.data?.expenseAccountAttributions]);
  const canonicalExpenseAccountsByDue = useMemo(() => {
    const grouped = new Map<string, typeof canonicalExpenseAccountRows>();
    for (const row of canonicalExpenseAccountRows) grouped.set(row.dueId, [...(grouped.get(row.dueId) ?? []), row]);
    return grouped;
  }, [canonicalExpenseAccountRows]);
  const expenseAccountTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const item of voucherReportLineRows) {
      const name = accountName(item.accountId);
      totals.set(name, (totals.get(name) ?? 0) + item.amount);
    }
    for (const item of canonicalExpenseAccountRows) totals.set(item.accountName, (totals.get(item.accountName) ?? 0) + item.amount);
    return [...totals.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [canonicalExpenseAccountRows, voucherReportLineRows]);
  const totalRecognizedExpenses = voucherRows.reduce((sum, item) => sum + item.amount, 0) + canonicalExpenseRows.reduce((sum, item) => sum + item.amount, 0);
  const voucherCategories = useMemo(
    () => [...new Set(voucherBaseRows.flatMap((item) => voucherReportItems(item).map((line) => line.category)).filter(Boolean))].sort(),
    [voucherBaseRows],
  );
  const voucherSubcategories = useMemo(
    () => [...new Set(voucherBaseRows
      .flatMap((item) => voucherReportItems(item))
      .filter((line) => !category || line.category === category)
      .map((line) => line.subcategory)
      .filter(Boolean))].sort(),
    [category, voucherBaseRows],
  );

  useEffect(() => {
    if (!subcategory) return;
    if (!voucherSubcategories.includes(subcategory)) setSubcategory("");
  }, [subcategory, voucherSubcategories]);

  const partnerRows = entries
    .filter((item) => isActiveOperationalRecord(item)
      && (!accountId || item.accountId === accountId || item.fromAccountId === accountId || item.toAccountId === accountId)
      && matches(item.date, [item.partnerName, item.fromPartner, item.toPartner, item.type, item.notes], item.amount))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const saleRows = sales
    .filter((item) => isActiveOperationalRecord(item)
      && (!accountId || item.accountId === accountId)
      && (!saleTypeFilter || saleTypeFilter === "all" || resolveSaleType(item) === saleTypeFilter)
      && matches(item.date, [item.buyerName, item.invoiceNumber, saleProduceLabel(item), saleTypeLabel(item), item.dispatchDate, item.vehicleNumber, accountName(item.accountId), item.paymentDate], item.amount))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const salesByDispatchKey = useMemo(() => {
    const map = new Map<string, Sale[]>();
    for (const sale of sales.filter((item) => isActiveOperationalRecord(item) && item.dispatchId && item.dispatchItemId)) {
      const key = `${sale.dispatchId}:${sale.dispatchItemId}`;
      const current = map.get(key) ?? [];
      current.push(sale);
      map.set(key, current);
    }
    return map;
  }, [sales]);
  const salesReportRows = useMemo(() => sales
    .filter((item) => isActiveOperationalRecord(item))
    .map((sale) => {
      const record: SalesReportRecord = {
        sale,
        saleType: saleTypeLabel(sale),
        invoiceNumber: invoiceReference(sale),
        buyerName: normalizeText(sale.buyerName) || t("reportsPage.unassignedBuyer"),
        product: saleProduceLabel(sale),
        plot: normalizeText(sale.plotName) || "-",
        unit: normalizeText(sale.unit) || t("reportsPage.defaultSalesUnit"),
        paymentStatus: salePaymentStatus(sale),
        paymentsReceived: salePaymentsReceived(sale),
        outstanding: saleOutstanding(sale),
        dispatchReference: sale.dispatchId ? `DSP ${sale.dispatchDate ?? sale.dispatchId.slice(0, 8)}` : "-",
        paymentAccount: accountName(sale.accountId),
      };
      return record;
    })
    .filter((item) => {
      const dateValue = salesDateType === "dispatchDate"
        ? item.sale.dispatchDate ?? ""
        : salesDateType === "deliveryDate"
          ? item.sale.deliveryDate ?? ""
          : salesDateType === "paymentDate"
            ? item.sale.paymentDate ?? ""
            : salesDateType === "createdDate"
              ? item.sale.createdAt.slice(0, 10)
              : item.sale.date;
      return inRange(dateValue || item.sale.date, from, to)
        && (min === null || item.sale.amount >= min)
        && (max === null || item.sale.amount <= max)
        && (!buyerFilter || item.buyerName.toLowerCase().includes(buyerFilter.trim().toLowerCase()))
        && (!productFilter || item.product.toLowerCase().includes(productFilter.trim().toLowerCase()))
        && (!paymentStatusFilter || item.paymentStatus === paymentStatusFilter)
        && (saleTypeFilter === "all" || resolveSaleType(item.sale) === saleTypeFilter)
        && matches(dateValue || item.sale.date, [
          item.saleType,
          item.invoiceNumber,
          item.buyerName,
          item.product,
          item.plot,
          item.sale.quantity,
          item.sale.remarks,
          item.dispatchReference,
          item.paymentAccount,
          item.sale.paymentDate,
        ], item.sale.amount);
    })
    .sort((a, b) => b.sale.date.localeCompare(a.sale.date) || b.sale.createdAt.localeCompare(a.sale.createdAt)), [accountName, buyerFilter, from, max, matches, min, paymentStatusFilter, productFilter, saleTypeFilter, sales, salesDateType, t, to]);
  const dispatchReportRows = useMemo(() => dispatches
    .filter((item) => isActiveOperationalRecord(item))
    .flatMap((dispatch) => (dispatch.items ?? []).map((dispatchItem) => {
      const key = `${dispatch.id}:${dispatchItem.id}`;
      const linkedSales = (salesByDispatchKey.get(key) ?? []).filter((sale) => isActiveOperationalRecord(sale)).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
      const soldQuantity = linkedSales.reduce((sum, sale) => sum + sale.quantity, 0);
      const quantity = dispatchItem.cartons;
      return {
        id: key,
        dispatch,
        dispatchNumber: dispatchReference(dispatch),
        product: normalizeText(dispatchItem.dateTypeName) || normalizeText(dispatch.produceType) || t("reportsPage.unknownProduct"),
        quantity,
        unit: normalizeText(dispatch.unit) || t("reportsPage.defaultDispatchUnit"),
        vehicle: normalizeText(dispatch.vehicleNumber) || t("reportsPage.unknownVehicle"),
        driver: normalizeText(dispatch.driverName) || "-",
        soldQuantity,
        remainingQuantity: Math.max(quantity - soldQuantity, 0),
        linkedSales,
        saleDate: linkedSales[0]?.date,
      } satisfies DispatchReportRecord;
    }))
    .filter((item) => {
      const dateValue = dispatchDateType === "saleDate"
          ? item.saleDate ?? ""
          : dispatchDateType === "createdDate"
            ? item.dispatch.createdAt.slice(0, 10)
            : item.dispatch.date;
      return inRange(dateValue || item.dispatch.date, from, to)
        && (!productFilter || item.product.toLowerCase().includes(productFilter.trim().toLowerCase()))
        && (!vehicleFilter || item.vehicle.toLowerCase().includes(vehicleFilter.trim().toLowerCase()) || item.driver.toLowerCase().includes(vehicleFilter.trim().toLowerCase()))
        && matches(dateValue || item.dispatch.date, [
          item.dispatchNumber,
          item.product,
          item.vehicle,
          item.driver,
          item.dispatch.notes,
          item.dispatch.remarks,
        ], item.linkedSales.reduce((sum, sale) => sum + sale.amount, 0));
    })
    .sort((a, b) => b.dispatch.date.localeCompare(a.dispatch.date) || a.dispatchNumber.localeCompare(b.dispatchNumber)), [dispatchDateType, dispatches, from, matches, productFilter, salesByDispatchKey, to, vehicleFilter, t]);

  // Canonical cash effects are supplied by the shared server read model. A
  // stable source id suppresses only the corresponding IndexedDB mirror.
  const canonicalLabourAccountEntries = canonicalFinancials.data?.accountEntries ?? [];
  const representedCanonicalAdvanceVoucherIds = new Set(canonicalLabourAccountEntries.filter((entry) => entry.economicNature === "ADVANCE").map((entry) => entry.voucherId));
  const accountingAdvanceRows = canonicalAdvanceRows.filter((advance) => !advance.canonicalVoucherId || !representedCanonicalAdvanceVoucherIds.has(advance.canonicalVoucherId));
  const positions = useMemo(() => accounts
    .filter((account) => !accountId || account.id === accountId)
    .map((account) => {
      const voucherExpenses = cashAffectingVouchers.filter((item) => resolveCanonicalAccountId(item.accountId, accountLookup) === account.id).reduce((sum, item) => sum + item.amount, 0);
      const labourAdvances = accountingAdvanceRows.filter((item) => resolveCanonicalAccountId(item.accountId, accountLookup) === account.id).reduce((sum, item) => sum + item.amount, 0);
      const contributions = partnerRows.filter((item) => item.type === "contribution" && resolveCanonicalAccountId(item.accountId, accountLookup) === account.id).reduce((sum, item) => sum + item.amount, 0);
      const withdrawals = partnerRows.filter((item) => item.type === "withdrawal" && resolveCanonicalAccountId(item.accountId, accountLookup) === account.id).reduce((sum, item) => sum + item.amount, 0);
      const settlementsSent = partnerRows.filter((item) => item.type === "settlement" && resolveCanonicalAccountId(item.fromAccountId, accountLookup) === account.id).reduce((sum, item) => sum + item.amount, 0);
      const settlementsReceived = partnerRows.filter((item) => item.type === "settlement" && resolveCanonicalAccountId(item.toAccountId, accountLookup) === account.id).reduce((sum, item) => sum + item.amount, 0);
      const salesReceived = saleRows.filter((item) => resolveCanonicalAccountId(item.accountId, accountLookup) === account.id).reduce((sum, item) => sum + item.amount, 0);
      const canonicalLabourCashEffect = canonicalLabourAccountEntries.filter((entry) => entry.accountId === account.id).reduce((sum, entry) => sum + entry.balanceEffect, 0);
      return {
        account,
        voucherExpenses,
        labourAdvances,
        contributions,
        withdrawals,
        settlementsSent,
        settlementsReceived,
        salesReceived,
        net: calculateAccountBalance(account, saleRows, cashAffectingVouchers, accountingAdvanceRows, partnerRows, activeSettlements, accounts) + canonicalLabourCashEffect,
      };
    }), [accountId, accountingAdvanceRows, accounts, activeSettlements, canonicalLabourAccountEntries, cashAffectingVouchers, partnerRows, saleRows]);
  const partnerLiabilityPositions = useMemo(() => {
    const merged = buildPartnerLiabilityPositions(accounts, cashAffectingVouchers, [], partnerRows, saleRows, [])
      .map((item) => {
        const canonical = item.account?.id ? canonicalFinancials.data?.partnerPositions.find((entry) => entry.accountId === item.account!.id) : undefined;
        return mergePartnerPositionWithCanonical(item, canonical);
      });
    const representedAccountIds = new Set(merged.map((item) => item.account?.id ?? item.key));
    for (const canonical of canonicalFinancials.data?.partnerPositions ?? []) {
      if (representedAccountIds.has(canonical.accountId)) continue;
      merged.push(buildCanonicalPartnerLiabilityPosition(canonical, accounts.find((item) => item.id === canonical.accountId) ?? null));
    }
    return merged.filter((item) => !accountId || (item.account?.id ?? item.key) === accountId);
  }, [accountId, accountingAdvanceRows, accounts, activeSettlements, canonicalFinancials.data, cashAffectingVouchers, partnerRows, saleRows]);
  const selectedAccountRecord = accountId ? accounts.find((item) => item.id === accountId) ?? null : null;
  const canonicalAccountLedgerEntries = selectedAccountRecord?.type === "partner"
    ? canonicalFinancials.data?.partnerLedger ?? []
    : canonicalLabourAccountEntries;
  const selectedPartnerSnapshot = useMemo(() => {
    if (selectedAccountRecord?.type !== "partner") return null;
    const legacy = getPartnerAccountingSnapshot(selectedAccountRecord, saleRows, cashAffectingVouchers, [], partnerRows, [], accounts);
    const canonical = canonicalFinancials.data?.partnerPositions.find((item) => item.accountId === selectedAccountRecord.id);
    if (!canonical) return legacy;
    const merged = mergePartnerPositionWithCanonical(legacy, canonical);
    return {
      ...legacy,
      directExpensesPaid: merged.directExpensesPaid,
      labourAdvancesPaid: merged.labourAdvancesPaid,
      totalLabourAdvancesPaid: merged.totalLabourAdvancesPaid,
      settledAdvances: merged.settledAdvances,
      outstandingLabourAdvances: merged.outstandingLabourAdvances,
      labourWageSettlements: merged.labourWageSettlements,
      labourSettlementCashPaid: merged.labourSettlementCashPaid,
      moneyReturned: merged.moneyReturned,
      farmOwesPartner: merged.currentPartnerBalance,
      currentPartnerBalance: merged.currentPartnerBalance,
      reconciliationDifference: merged.reconciliationDifference,
      reconciliationDelta: merged.reconciliationDelta,
      isConsistent: merged.isConsistent,
    };
  }, [accounts, canonicalFinancials.data?.partnerPositions, cashAffectingVouchers, partnerRows, saleRows, selectedAccountRecord]);

  const accountLedgerRows = useMemo(() => {
    const rows: Array<Omit<AccountLedgerReportRow, "running">> = [];
    for (const voucher of cashAffectingVouchers) {
    const account = accountById.get(resolveCanonicalAccountId(voucher.accountId, accountLookup) ?? voucher.accountId);
      const isPartner = account?.type === "partner";
      const settlementVoucher = isLabourWageSettlementVoucher(voucher);
      const settlementRecord = settlementVoucher
        ? activeSettlements.find((item) => item.id === voucher.settlementId || item.id === voucher.id)
        : null;
      const nonCashApplied = settlementRecord ? getLabourWageSettlementAdvanceOffset(settlementRecord) : 0;
      const cashPaid = settlementRecord ? getLabourWageSettlementCashPaidAmount(settlementRecord) : 0;
      rows.push({
        id: `voucher:${voucher.id}`,
        date: voucher.date,
        accountId: voucher.accountId,
        accountName: accountName(voucher.accountId),
        type: "voucher",
        typeLabel: settlementVoucher ? "Non-cash labour advance settlement" : t("reportsPage.voucherExpense"),
        reference: settlementVoucher ? (settlementRecord?.settlementNumber ?? getVoucherDisplayNumber(voucher) ?? voucher.voucherNumber) : (getVoucherDisplayNumber(voucher) || voucher.voucherNumber),
        description: settlementVoucher ? `Non-cash labour advance settlement — advances applied ${money(nonCashApplied)}${cashPaid ? `, cash paid ${money(cashPaid)}` : ""}` : voucher.description,
        debit: 0,
        credit: 0,
        memoAmount: settlementVoucher ? nonCashApplied : undefined,
        path: settlementVoucher ? `/workspace/wage-settlements?recordId=${voucher.settlementId ?? voucher.id}` : `/workspace/expenses?recordId=${voucher.id}`,
        classification: settlementVoucher ? "labour_wage_settlement_memo" : "voucher",
        partnerLiabilityGroup: isPartner ? (settlementVoucher ? undefined : "purchase_vouchers_paid") : undefined,
      });
    }
    for (const advance of accountingAdvanceRows) {
      const account = accountById.get(resolveCanonicalAccountId(advance.accountId, accountLookup) ?? "");
      const isPartner = account?.type === "partner";
      rows.push({ id: `advance:${advance.id}`, date: advance.date, accountId: resolveCanonicalAccountId(advance.accountId, accountLookup) ?? advance.accountId ?? "", accountName: accountName(advance.accountId), type: "advance", typeLabel: t("reportsPage.labourAdvance"), reference: advance.id.slice(0, 8), description: `${labourName(advance.labourerId)}${advance.notes ? ` - ${advance.notes}` : ""}`, debit: isPartner ? 0 : advance.amount, credit: isPartner ? advance.amount : 0, path: `/workspace/labour-advances?recordId=${advance.id}`, classification: "advance", partnerLiabilityGroup: isPartner ? "labour_advances_paid" : undefined });
    }
    for (const voucher of canonicalAccountLedgerEntries) {
      const account = accountById.get(voucher.accountId);
      const informational = voucher.informational === true;
      rows.push({
        id: `labour-payment-voucher:${voucher.id}`,
        date: voucher.date,
        accountId: voucher.accountId,
        accountName: account?.name ?? "Payment account",
        type: "labour_payment_voucher",
        typeLabel: voucher.nature.toLowerCase().replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()),
        reference: voucher.voucherNumber,
        description: voucher.description,
        debit: informational ? 0 : voucher.transactionType === "debit" ? voucher.amount : 0,
        credit: informational ? 0 : voucher.transactionType === "credit" ? voucher.amount : 0,
        memoAmount: informational ? voucher.amount : undefined,
        path: "/workspace/labour-payments/vouchers",
        classification: voucher.nature === "REFUND_RECOVERY" ? "income" : voucher.nature === "REVERSAL" ? "other" : "settlement",
        partnerLiabilityGroup: account?.type === "partner" ? (voucher.economicNature === "ADVANCE" ? "labour_advances_paid" : voucher.economicNature === "REFUND_RECOVERY" ? "money_returned" : voucher.economicNature === "ADVANCE_APPLICATION" ? undefined : "labour_wage_settlements") : undefined,
      });
    }
    for (const sale of saleRows) rows.push({
      id: `sale:${sale.id}`,
      date: sale.date,
      accountId: resolveCanonicalAccountId(sale.accountId, accountLookup) ?? sale.accountId ?? "",
      accountName: accountName(sale.accountId),
      type: accountById.get(resolveCanonicalAccountId(sale.accountId, accountLookup) ?? "")?.type === "partner" ? "adjustment" : "sale",
      typeLabel: accountById.get(resolveCanonicalAccountId(sale.accountId, accountLookup) ?? "")?.type === "partner" ? t("reportsPage.adjustment") : t("reportsPage.sale"),
      reference: sale.dispatchDate ? `DSP ${sale.dispatchDate}` : sale.id.slice(0, 8),
      description: `${sale.buyerName ?? t("reportsPage.unassignedBuyer")} - ${saleProduceLabel(sale)}${sale.vehicleNumber ? ` - ${sale.vehicleNumber}` : ""}`,
      debit: accountById.get(resolveCanonicalAccountId(sale.accountId, accountLookup) ?? "")?.type === "partner" ? sale.amount : 0,
      credit: accountById.get(resolveCanonicalAccountId(sale.accountId, accountLookup) ?? "")?.type === "partner" ? 0 : sale.amount,
      path: `/workspace/sales?recordId=${sale.id}`,
      classification: accountById.get(resolveCanonicalAccountId(sale.accountId, accountLookup) ?? "")?.type === "partner" ? "adjustment" : "sale",
      partnerLiabilityGroup: accountById.get(resolveCanonicalAccountId(sale.accountId, accountLookup) ?? "")?.type === "partner" ? "adjustments" : undefined,
    });
    for (const entry of partnerRows) {
      if (entry.type === "contribution" || entry.type === "withdrawal") {
        const partnerAccountId = resolvePartnerAccountId(entry, accounts);
        const partnerAccount = partnerAccountId ? accountById.get(partnerAccountId) : null;
        if (partnerAccountId) {
          rows.push({ id: `partner:${entry.id}:partner`, date: entry.date, accountId: partnerAccountId, accountName: accountName(partnerAccountId), type: entry.type, typeLabel: entry.type === "contribution" ? t("reportsPage.capitalInjected") : t("reportsPage.moneyReturned"), reference: entry.id.slice(0, 8), description: `${entry.partnerName ?? accountName(partnerAccountId)}${entry.notes ? ` - ${entry.notes}` : ""}`, debit: entry.type === "withdrawal" ? entry.amount : 0, credit: entry.type === "contribution" ? entry.amount : 0, path: `/workspace/partner-ledger?recordId=${entry.id}`, classification: entry.type, counterparty: accountName(entry.accountId), partnerLiabilityGroup: entry.type === "contribution" ? "capital_injected" : "money_returned" });
        }
        if (entry.accountId && accountById.get(entry.accountId)?.type !== "partner") {
          rows.push({ id: `partner:${entry.id}:cash`, date: entry.date, accountId: resolveCanonicalAccountId(entry.accountId, accountLookup) ?? entry.accountId ?? "", accountName: accountName(entry.accountId), type: entry.type, typeLabel: entry.type === "contribution" ? t("reportsPage.contribution") : t("reportsPage.withdrawal"), reference: entry.id.slice(0, 8), description: `${entry.partnerName ?? partnerAccount?.name ?? "-"}${entry.notes ? ` - ${entry.notes}` : ""}`, debit: entry.type === "withdrawal" ? entry.amount : 0, credit: entry.type === "contribution" ? entry.amount : 0, path: `/workspace/partner-ledger?recordId=${entry.id}`, classification: entry.type });
        }
      }
      if (entry.type === "settlement") {
        const fromAccountId = resolvePartnerTransferAccountIdentity(entry as Record<string, unknown>, "from", accountLookup).canonicalAccountId;
        const toAccountId = resolvePartnerTransferAccountIdentity(entry as Record<string, unknown>, "to", accountLookup).canonicalAccountId;
        rows.push({ id: `settlement:${entry.id}:sent`, date: entry.date, accountId: fromAccountId ?? entry.fromAccountId ?? "", accountName: accountName(fromAccountId ?? entry.fromAccountId), type: "settlement_sent", typeLabel: t("reportsPage.settlementSent"), reference: entry.id.slice(0, 8), description: `${entry.fromPartner ?? "-"} → ${entry.toPartner ?? "-"}`, debit: accountById.get(fromAccountId ?? "")?.type === "partner" ? 0 : entry.amount, credit: accountById.get(fromAccountId ?? "")?.type === "partner" ? entry.amount : 0, path: `/workspace/partner-ledger?recordId=${entry.id}`, classification: "settlement_sent", counterparty: entry.toPartner, partnerLiabilityGroup: accountById.get(fromAccountId ?? "")?.type === "partner" ? "transfers_out" : undefined });
        rows.push({ id: `settlement:${entry.id}:received`, date: entry.date, accountId: toAccountId ?? entry.toAccountId ?? "", accountName: accountName(toAccountId ?? entry.toAccountId), type: "settlement_received", typeLabel: t("reportsPage.settlementReceived"), reference: entry.id.slice(0, 8), description: `${entry.fromPartner ?? "-"} → ${entry.toPartner ?? "-"}`, debit: accountById.get(toAccountId ?? "")?.type === "partner" ? entry.amount : 0, credit: accountById.get(toAccountId ?? "")?.type === "partner" ? 0 : entry.amount, path: `/workspace/partner-ledger?recordId=${entry.id}`, classification: "settlement_received", counterparty: entry.fromPartner, partnerLiabilityGroup: accountById.get(toAccountId ?? "")?.type === "partner" ? "transfers_in" : undefined });
      }
    }
    const running = new Map<string, number>();
    return rows
      .filter((item) => !accountId || item.accountId === accountId)
      .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
      .map((item) => {
        const next = (running.get(item.accountId) ?? 0) + item.credit - item.debit;
        running.set(item.accountId, next);
        return { ...item, running: next, accountName: item.accountName || accountName(item.accountId) };
      });
  }, [accountId, accountName, accountById, accountingAdvanceRows, accounts, canonicalAccountLedgerEntries, cashAffectingVouchers, labourName, partnerRows, saleRows, t]);
  const groupedAccountLedgerRows = useMemo(() => groupAccountTransactions(accountLedgerRows), [accountLedgerRows]);
  const groupedPartnerLedgerRows = useMemo(
    () => selectedAccountRecord?.type === "partner" ? groupPartnerLiabilityTransactions(accountLedgerRows) : [],
    [accountLedgerRows, selectedAccountRecord],
  );
  const visibleAccountLedgerGroups = useMemo(() => groupedAccountLedgerRows.filter((group) => showEmptyLedgerGroups || group.count > 0), [groupedAccountLedgerRows, showEmptyLedgerGroups]);
  const visiblePartnerLedgerGroups = useMemo(() => groupedPartnerLedgerRows.filter((group) => showEmptyLedgerGroups || group.count > 0), [groupedPartnerLedgerRows, showEmptyLedgerGroups]);
  const rawPartnerAccountLedgerSummary = useMemo(() => {
    const summary = {
      capitalInjected: 0,
      directExpensesPaid: 0,
      transfersIn: 0,
      transfersOut: 0,
      moneyReturned: 0,
      adjustments: 0,
    };
    if (selectedAccountRecord?.type !== "partner") return { ...summary, netBalance: 0 };
    const settlementSnapshot = selectedPartnerSnapshot;
    for (const group of groupedPartnerLedgerRows) {
      if (group.groupKey === "capital_injected") summary.capitalInjected += group.totalAmount;
      if (group.groupKey === "purchase_vouchers_paid") summary.directExpensesPaid += group.totalAmount;
      if (group.groupKey === "labour_advances_paid") summary.directExpensesPaid += settlementSnapshot?.totalLabourAdvancesPaid ?? 0;
      if (group.groupKey === "labour_wage_settlements") summary.directExpensesPaid += group.totalAmount;
      if (group.groupKey === "transfers_in") summary.transfersIn += Math.abs(group.totalAmount);
      if (group.groupKey === "transfers_out") summary.transfersOut += Math.abs(group.totalAmount);
      if (group.groupKey === "money_returned") summary.moneyReturned += -group.totalAmount;
      if (group.groupKey === "adjustments") summary.adjustments += group.totalAmount;
    }
    return {
      ...summary,
      netBalance: settlementSnapshot?.farmOwesPartner ?? (summary.capitalInjected + summary.directExpensesPaid + summary.transfersOut - summary.transfersIn - summary.moneyReturned + summary.adjustments),
    };
  }, [groupedPartnerLedgerRows, selectedAccountRecord, selectedPartnerSnapshot]);
  const rawStandardAccountLedgerSummary = useMemo(() => {
    const summary = { expenses: 0, advances: 0, settlements: 0, income: 0, other: 0 };
    for (const group of groupedAccountLedgerRows) {
      if (group.groupKey === "expenses") summary.expenses += group.debitTotal;
      if (group.groupKey === "advances") summary.advances += group.debitTotal;
      if (group.groupKey === "settlements") summary.settlements += group.totalAmount;
      if (group.groupKey === "income") summary.income += group.totalAmount;
      if (group.groupKey === "other") summary.other += group.totalAmount;
    }
    return { ...summary, netBalance: summary.income - summary.expenses - summary.advances + summary.settlements + summary.other };
  }, [groupedAccountLedgerRows]);
  const accountLedgerSummary = selectedAccountRecord?.type === "partner" ? rawPartnerAccountLedgerSummary : rawStandardAccountLedgerSummary;
  const currentLedgerBalance = selectedAccountRecord ? positions.find((item) => item.account.id === selectedAccountRecord.id)?.net ?? 0 : accountLedgerSummary.netBalance;
  const reportLedgerDelta = Math.round((currentLedgerBalance - accountLedgerSummary.netBalance) * 100) / 100;
  const showReportLedgerWarning = selectedAccountRecord && Math.abs(reportLedgerDelta) > 0.009;
  const showReportNoVisibleTransactionsWarning = selectedAccountRecord && accountLedgerRows.length === 0 && Math.abs(currentLedgerBalance) > 0.009;
  const isPartnerLedgerReport = selectedAccountRecord?.type === "partner";
  const rawPartnerAccountLedgerOverview = useMemo(() => {
    const overview = {
      openingBalance: 0,
      capitalInjected: 0,
      purchaseVouchersPaid: 0,
      labourAdvancesPaid: 0,
      outstandingLabourAdvances: 0,
      labourWageSettlements: 0,
      labourSettlementCashPaid: 0,
      labourSettlementNonCashApplied: 0,
      directExpensesPaid: 0,
      transfersIn: 0,
      transfersOut: 0,
      moneyReturned: 0,
      adjustments: 0,
    };
    if (selectedAccountRecord?.type !== "partner") return { ...overview, netBalance: 0 };
    for (const row of accountLedgerRows) {
      if (row.partnerLiabilityGroup === "capital_injected") overview.capitalInjected += row.credit;
      if (row.partnerLiabilityGroup === "purchase_vouchers_paid") overview.purchaseVouchersPaid += row.credit - row.debit;
      if (row.partnerLiabilityGroup === "labour_advances_paid") overview.labourAdvancesPaid += row.credit - row.debit;
      if (row.partnerLiabilityGroup === "labour_wage_settlements") overview.labourWageSettlements += row.credit - row.debit;
      if (row.partnerLiabilityGroup === "transfers_in") overview.transfersIn += Math.max(row.debit, row.credit);
      if (row.partnerLiabilityGroup === "transfers_out") overview.transfersOut += Math.max(row.debit, row.credit);
      if (row.partnerLiabilityGroup === "money_returned") overview.moneyReturned += row.debit;
      if (row.partnerLiabilityGroup === "adjustments") overview.adjustments += row.credit - row.debit;
    }
    const settlementSnapshot = selectedPartnerSnapshot;
    overview.labourAdvancesPaid = settlementSnapshot?.totalLabourAdvancesPaid ?? overview.labourAdvancesPaid;
    overview.outstandingLabourAdvances = settlementSnapshot?.outstandingLabourAdvances ?? overview.outstandingLabourAdvances;
    overview.labourWageSettlements = settlementSnapshot?.labourWageSettlements ?? overview.labourWageSettlements;
    overview.labourSettlementCashPaid = settlementSnapshot?.labourSettlementCashPaid ?? overview.labourSettlementCashPaid;
    overview.labourSettlementNonCashApplied = settlementSnapshot?.labourSettlementNonCashApplied ?? overview.labourSettlementNonCashApplied;
    overview.directExpensesPaid = overview.purchaseVouchersPaid
      + (settlementSnapshot?.totalLabourAdvancesPaid ?? overview.labourAdvancesPaid)
      + (settlementSnapshot?.labourWageSettlements ?? overview.labourWageSettlements);
    return {
      ...overview,
      netBalance: settlementSnapshot?.farmOwesPartner ?? calculatePartnerLiabilityBalance(overview),
    };
  }, [accountLedgerRows, selectedAccountRecord, selectedPartnerSnapshot]);
  const partnerAccountLedgerOverviewView = isPartnerLedgerReport
    ? rawPartnerAccountLedgerOverview as {
        capitalInjected: number;
        purchaseVouchersPaid: number;
        labourAdvancesPaid: number;
        outstandingLabourAdvances: number;
        labourWageSettlements: number;
        labourSettlementCashPaid: number;
        labourSettlementNonCashApplied: number;
        directExpensesPaid: number;
        transfersIn: number;
        transfersOut: number;
        moneyReturned: number;
        adjustments: number;
        netBalance: number;
      }
    : null;
  const standardAccountLedgerSummaryView = !isPartnerLedgerReport
    ? accountLedgerSummary as {
        expenses: number;
        advances: number;
        settlements: number;
        income: number;
        other: number;
        netBalance: number;
      }
    : null;

  const exportAttendanceRegister = () => {
    const rows = [
      [
        "Serial",
        t("reportsPage.labourName"),
        t("reportsPage.group"),
        t("reportsPage.present"),
        t("reportsPage.halfDay"),
        t("reportsPage.absent"),
        t("reportsPage.payableDays"),
        "Wages SAR",
        ...attendanceDates.map(formatCsvDate),
      ],
      ...attendanceSummary.map((item, index) => [
        index + 1,
        item.labourer.name,
        item.labourer.group ?? "",
        item.present,
        item.halfDay,
        item.absent,
        formatNumber(item.payable),
        formatNumber(item.wage),
        ...attendanceDates.map((date) => attendancePrintMark(item.records.find((record) => record.date === date)?.status)),
      ]),
      [
        "Grand Total",
        "",
        "",
        attendanceTotals.present,
        attendanceTotals.halfDay,
        attendanceTotals.absent,
        formatNumber(attendanceTotals.payableDays),
        formatNumber(attendanceTotals.wages),
        ...attendanceDates.map(() => ""),
      ],
      [
        "Daily Total Presents",
        "",
        "",
        "",
        "",
        "",
        "",
        ...attendanceDateTotals.map((total) => formatNumber(total)),
      ],
    ];
    downloadCsv("attendance-register.csv", rows);
  };
  const exportAttendanceSummary = () => downloadCsv("attendance-summary.csv", [
    [t("reportsPage.labour"), t("reportsPage.present"), t("reportsPage.halfDay"), t("reportsPage.absent"), t("reportsPage.payableDays"), t("reportsPage.totalWages")],
    ...attendanceSummary.map((item) => [item.labourer.name, item.present, item.halfDay, item.absent, formatNumber(item.payable), item.wage]),
  ]);
  const exportAdvanceSummaryCsv = () => downloadCsv("labour-advances-summary.csv", [
    ["Serial", "Labour / Group", "Recipient Type", "Group", "Payment Sources", "Total Advances SAR", "Adjusted in Settlements SAR", "Recovered / Refunded SAR", "Outstanding Advances SAR", "Transaction Count", "Last Advance Date"],
    ...advanceReportLabourSections.map((section, index) => [
      index + 1,
      section.labourer.name,
      section.paymentTypeLabel,
      section.groupLabel,
      section.sourceLabel,
      section.total,
      section.settled,
      section.records.reduce((sum, record) => sum + ("recoveredAmount" in record ? Number(record.recoveredAmount ?? 0) : 0), 0),
      section.outstanding,
      section.transactionCount,
      section.lastAdvanceDate,
    ]),
  ]);
  const exportAdvanceDetailCsv = () => downloadCsv("labour-advances-detail.csv", [
    ["Serial", "Labour / Group", "Recipient Type", "Group", "Date", "Source / Paid From", "Description", "Advance Amount SAR", "Recovered SAR", "Status", "Voucher Number"],
    ...advanceRows.map((item, index) => {
      const labourer = labourById.get(item.labourerId);
      return [
        index + 1,
        advanceRecipientName(item),
        paymentTypeDisplayLabel(labourer),
        labourer?.group?.trim() || "-",
        item.date,
        advancePaymentSourceName(item),
        item.notes || "-",
        item.amount,
        item.recoveredAmount,
        item.status,
        item.voucherNumber,
      ];
    }),
  ]);
  const exportAdvanceCsv = () => (views.advances === "summary" ? exportAdvanceSummaryCsv() : exportAdvanceDetailCsv());
  const exportExpenseSummary = () => {
    const categoryTotals = [...new Set(voucherReportLineRows.map((item) => item.category))].map((name) => [translateExpenseCategory(name), voucherReportLineRows.filter((item) => item.category === name).reduce((sum, item) => sum + item.amount, 0)]);
    if (canonicalExpenseRows.length) categoryTotals.push(["Labour wages", canonicalExpenseRows.reduce((sum, item) => sum + item.amount, 0)]);
    const accountTotals = expenseAccountTotals;
    downloadCsv("expense-summary.csv", [
      [t("reportsPage.dateRange"), rangeLabel],
      [],
      [t("reportsPage.category"), t("reportsPage.total")],
      ...categoryTotals,
      [],
      [t("reportsPage.account"), t("reportsPage.total")],
      ...accountTotals,
      [],
      [t("reportsPage.total"), totalRecognizedExpenses],
    ]);
  };
  const exportExpenseLog = () => downloadCsv("expense-log.csv", [
    [t("reportsPage.voucher"), t("reportsPage.date"), t("reportsPage.description"), t("reportsPage.category"), t("reportsPage.account"), t("reportsPage.amount")],
    ...voucherRows.flatMap((voucher) => voucherReportItems(voucher).map((item, index) => [index === 0 ? (getVoucherDisplayNumber(voucher) || voucher.voucherNumber) : "", index === 0 ? voucher.date : "", item.description, expenseLabel(item.category, item.subcategory), index === 0 ? accountName(voucher.accountId) : "", item.amount])),
    ...canonicalExpenseRows.map((item) => {
      const sources = canonicalExpenseAccountsByDue.get(item.id) ?? [];
      return [item.dueNumber ?? item.id, item.date, item.description, "Labour wages", sources.map((source) => `${source.accountName} — ${money(source.amount)}`).join("; ") || "Unattributed", item.amount];
    }),
  ]);
  const exportPartnerPosition = () => downloadCsv("partner-position.csv", [
    [t("reportsPage.partner"), t("reportsPage.openingBalance"), t("reportsPage.capitalInjected"), "Purchase vouchers", "Total labour advances paid", "Settled through wage settlements", "Outstanding labour advances", "Labour settlements cash paid", t("reportsPage.transfersOut"), t("reportsPage.transfersIn"), t("reportsPage.moneyReturned"), t("reportsPage.adjustments"), t("reportsPage.currentPartnerBalance")],
    ...partnerLiabilityPositions.map((item) => [item.name, item.openingBalance, item.capitalInjected, item.purchaseVouchersPaid, item.totalLabourAdvancesPaid, item.labourSettlementNonCashApplied, item.outstandingLabourAdvances, item.labourSettlementCashPaid, item.transfersOut, item.transfersIn, item.moneyReturned, item.adjustments, item.currentPartnerBalance]),
  ]);
  const exportPartnerLedger = () => downloadCsv("partner-ledger.csv", [
    [t("reportsPage.date"), t("reportsPage.partner"), t("reportsPage.type"), t("reportsPage.amount"), t("reportsPage.notes")],
    ...partnerRows.map((item) => [item.date, item.partnerName ?? `${item.fromPartner ?? "-"} → ${item.toPartner ?? "-"}`, item.type, item.amount, item.notes || "-"]),
  ]);
  const exportAccountBalances = () => downloadCsv("account-balances.csv", [
    [t("reportsPage.account"), t("reportsPage.voucherExpenses"), t("reportsPage.labourAdvance"), t("reportsPage.totalCredit"), t("reportsPage.totalDebit"), t("reportsPage.closingBalance")],
    ...positions.map((item) => [item.account.name, item.voucherExpenses, item.labourAdvances, item.salesReceived + item.contributions + item.settlementsReceived, item.withdrawals + item.settlementsSent, item.net]),
  ]);
  const exportAccountLedger = () => {
    const rows: unknown[][] = [[t("reportsPage.account"), selectedAccountRecord?.name ?? t("reportsPage.allAccounts")], [t("reportsPage.netPosition"), currentLedgerBalance], []];
    const groups = selectedAccountRecord?.type === "partner" ? visiblePartnerLedgerGroups : visibleAccountLedgerGroups;
    for (const group of groups) {
      rows.push([selectedAccountRecord?.type === "partner" ? partnerLiabilityGroupTitle(group.groupKey as PartnerLiabilityLedgerGroupKey) : ledgerGroupTitle(group.groupKey as AccountTransactionGroupKey), selectedAccountRecord?.type === "partner" ? partnerLiabilityGroupDisplayTotal(group.groupKey as PartnerLiabilityLedgerGroupKey, group.totalAmount) : group.totalAmount, t("reportsPage.transactions"), group.count]);
      rows.push([t("reportsPage.date"), t("reportsPage.account"), t("reportsPage.type"), t("reportsPage.reference"), t("reportsPage.description"), t("reportsPage.debit"), t("reportsPage.credit"), t("reportsPage.runningBalance")]);
      rows.push(...group.transactions.map((item) => [item.date, item.accountName, item.typeLabel, item.reference, item.description, item.debit, item.credit, item.running]));
      rows.push([]);
    }
    downloadCsv("account-ledger.csv", rows);
  };
  const exportSalesReport = () => downloadCsv("sales-report.csv", [
    [t("reportsPage.dateType"), t(`reportsPage.salesDateTypes.${salesDateType}`)],
    [t("reportsPage.dateRange"), rangeLabel],
    [],
    [t("reportsPage.totalSalesAmount"), salesReportRows.reduce((sum, item) => sum + item.sale.amount, 0)],
    [t("reportsPage.totalQuantitySold"), salesReportRows.reduce((sum, item) => sum + item.sale.quantity, 0)],
    [t("reportsPage.totalInvoices"), salesReportRows.length],
    [t("reportsPage.outstandingReceivables"), salesReportRows.reduce((sum, item) => sum + item.outstanding, 0)],
    [],
    [t("reportsPage.saleType"), t("reportsPage.saleDate"), t("reportsPage.invoiceNumber"), t("reportsPage.buyerName"), t("reportsPage.plot"), t("reportsPage.dispatchReference"), t("reportsPage.product"), t("reportsPage.quantity"), t("reportsPage.unit"), t("reportsPage.rate"), t("reportsPage.amount"), t("expensesPage.paymentAccount"), t("reportsPage.paymentDate"), t("reportsPage.paymentStatus"), t("reportsPage.remarks")],
    ...salesReportRows.map((item) => [item.saleType, item.sale.date, item.invoiceNumber, item.buyerName, item.plot, item.dispatchReference, item.product, item.sale.quantity, item.unit, item.sale.unitPrice, item.sale.amount, item.paymentAccount, item.sale.paymentDate || "-", translateSalesStatus(item.paymentStatus), item.sale.remarks || "-"]),
  ]);
  const exportDispatchReport = () => downloadCsv("dispatch-report.csv", [
    [t("reportsPage.dateType"), t(`reportsPage.dispatchDateTypes.${dispatchDateType}`)],
    [t("reportsPage.dateRange"), rangeLabel],
    [],
    [t("reportsPage.totalDispatches"), new Set(dispatchReportRows.map((item) => item.dispatch.id)).size],
    [t("reportsPage.totalQuantity"), dispatchReportRows.reduce((sum, item) => sum + item.quantity, 0)],
    [t("reportsPage.soldQuantity"), dispatchReportRows.reduce((sum, item) => sum + item.soldQuantity, 0)],
    [t("reportsPage.remainingQuantity"), dispatchReportRows.reduce((sum, item) => sum + item.remainingQuantity, 0)],
    [],
    [t("reportsPage.dispatchDate"), t("reportsPage.dispatchNumber"), t("reportsPage.product"), t("reportsPage.quantity"), t("reportsPage.unit"), t("reportsPage.vehicle"), t("reportsPage.driver"), t("reportsPage.linkedSale"), t("reportsPage.soldQuantity"), t("reportsPage.remainingQuantity"), t("reportsPage.remarks")],
    ...dispatchReportRows.map((item) => [item.dispatch.date, item.dispatchNumber, item.product, item.quantity, item.unit, item.vehicle, item.driver, item.linkedSales.map((sale) => invoiceReference(sale)).join(", ") || "-", item.soldQuantity, item.remainingQuantity, item.dispatch.remarks || item.dispatch.notes || "-"]),
  ]);

  return <div className="dashboard-page">
    <SubpageHeader title={t("reportsPage.title")} />
    <main className="subpage module-workspace reports-page">
      <section className="record-panel reports-tabs" aria-label={t("reportsPage.title")}>
        {reportOptions.map((item) => <button ref={(node) => { reportTabRefs.current[item] = node; }} className={report === item ? "is-active" : ""} type="button" key={item} onClick={() => switchReport(item)}>{t(`reportsPage.tabs.${item}`)}</button>)}
      </section>
      <section className="record-panel reports-filter-panel">
        <div className="reports-filter-heading">
          <h2>{t("reportsPage.filters")}</h2>
          {filtered && <button type="button" onClick={clearFilters}>{t("reportsPage.clearFilters")}</button>}
        </div>
        <div className="reports-filters">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder={
              report === "attendance"
                ? `${t("reportsPage.labour")} / ${t("reportsPage.group")}`
              : report === "advances"
                  ? "Search advances"
                  : report === "sales"
                    ? `${t("reportsPage.invoiceNumber")} / ${t("reportsPage.buyerName")} / ${t("reportsPage.product")} / ${t("reportsPage.quantity")}`
                    : report === "dispatch"
                      ? `${t("reportsPage.dispatchNumber")} / ${t("reportsPage.product")} / ${t("reportsPage.vehicle")} / ${t("reportsPage.remarks")}`
                  : t("reportsPage.searchPlaceholder")
            }
          />
          <div className="reports-date-row">
            <ReportDateField
              label={t("reportsPage.fromDate")}
              placeholder={t("reportsPage.fromDate")}
              value={from}
              onChange={setFrom}
            />
            <ReportDateField
              label={t("reportsPage.toDate")}
              placeholder={t("reportsPage.toDate")}
              value={to}
              onChange={setTo}
            />
          </div>
          <div className="reports-range-actions" aria-label={t("reportsPage.quickDateRanges")}>
            <button type="button" onClick={applyTodayRange}>{t("reportsPage.quickToday")}</button>
            <button type="button" onClick={applyWeekRange}>{t("reportsPage.quickThisWeek")}</button>
            <button type="button" onClick={applyMonthRange}>{t("reportsPage.quickThisMonth")}</button>
            <button type="button" onClick={clearFilters}>{t("reportsPage.quickClear")}</button>
          </div>
          {(report === "attendance" || report === "advances") && <details className="reports-more-filters" open={report === "attendance" ? attendanceMoreFiltersOpen : advanceMoreFiltersOpen}>
            <summary onClick={(event) => {
              event.preventDefault();
              if (report === "attendance") setAttendanceMoreFiltersOpen((current) => !current);
              else setAdvanceMoreFiltersOpen((current) => !current);
            }}>
              <span>More filters</span>
              {advancedFilterCount > 0 ? <b>{advancedFilterCount}</b> : null}
              {(report === "attendance" ? attendanceMoreFiltersOpen : advanceMoreFiltersOpen) ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </summary>
            <div className={`reports-more-filters__body${report === "attendance" ? " reports-more-filters__body--attendance" : " reports-more-filters__body--advances"}`}>
              {report === "attendance" && <>
                <ResponsiveSelectField
                  ariaLabel={t("reportsPage.group")}
                  title="Select labour group"
                  value={groupFilter}
                  onChange={setGroupFilter}
                  placeholder={t("reportsPage.allGroups")}
                  allLabel={t("reportsPage.allGroups")}
                  searchPlaceholder="Search groups"
                  clearValue=""
                  options={[...labourGroupOptions, { value: ungroupedValue, label: t("reportsPage.ungrouped") }]}
                />
                <ResponsiveMultiSelectField
                  ariaLabel={t("reportsPage.labour")}
                  title="Select labour"
                  selectedIds={selectedLabourerIds}
                  onChange={setSelectedLabourerIds}
                  placeholder={t("common.allLabour")}
                  allLabel={t("reportsPage.allLabour")}
                  searchPlaceholder="Search labour"
                  noResultsLabel={t("common.noMatchingLabour")}
                  options={reportLabourOptionsWithLabel}
                />
              </>}
              {report === "advances" && <>
                <ResponsiveSelectField
                  ariaLabel={t("reportsPage.group")}
                  title="Select labour group"
                  value={groupFilter}
                  onChange={setGroupFilter}
                  placeholder={t("reportsPage.allGroups")}
                  allLabel={t("reportsPage.allGroups")}
                  searchPlaceholder="Search groups"
                  clearValue=""
                  options={[...labourGroupOptions, { value: ungroupedValue, label: t("reportsPage.ungrouped") }]}
                />
                <ResponsiveMultiSelectField
                  ariaLabel={t("reportsPage.labour")}
                  title="Select labour"
                  selectedIds={selectedLabourerIds}
                  onChange={setSelectedLabourerIds}
                  placeholder={t("common.allLabour")}
                  allLabel={t("reportsPage.allLabour")}
                  searchPlaceholder="Search labour"
                  noResultsLabel={t("common.noMatchingLabour")}
                  options={reportLabourOptionsWithLabel}
                />
                <ResponsiveSelectField
                  ariaLabel={t("reportsPage.account")}
                  title="Paid from account"
                  value={accountId}
                  onChange={setAccountId}
                  placeholder="All accounts"
                  allLabel="All accounts"
                  searchPlaceholder="Search accounts"
                  clearValue=""
                  options={accountOptions}
                />
                <label className="reports-filter-group">
                  <span>Minimum Amount</span>
                  <input aria-label={t("reportsPage.minimumAmount")} inputMode="decimal" placeholder={t("reportsPage.minimumAmount")} value={amountMin} onChange={(event) => setAmountMin(event.target.value)} />
                </label>
                <label className="reports-filter-group">
                  <span>Maximum Amount</span>
                  <input aria-label={t("reportsPage.maximumAmount")} inputMode="decimal" placeholder={t("reportsPage.maximumAmount")} value={amountMax} onChange={(event) => setAmountMax(event.target.value)} />
                </label>
              </>}
            </div>
          </details>}
          {(report === "sales" || report === "dispatch") && <ClearableSelect allowClear={false} aria-label={t("reportsPage.dateType")} value={report === "sales" ? salesDateType : dispatchDateType} onChange={(value) => report === "sales" ? setSalesDateType(value as SalesDateType) : setDispatchDateType(value as DispatchDateType)}>
            {report === "sales"
              ? (["saleDate", "dispatchDate", "deliveryDate", "paymentDate", "createdDate"] as SalesDateType[]).map((item) => <option key={item} value={item}>{t(`reportsPage.salesDateTypes.${item}`)}</option>)
              : (["dispatchDate", "saleDate", "createdDate"] as DispatchDateType[]).map((item) => <option key={item} value={item}>{t(`reportsPage.dispatchDateTypes.${item}`)}</option>)}
          </ClearableSelect>}

          {report === "attendance" && views.attendance === "summary" && <ResponsiveSelectField ariaLabel={t("reportsPage.status")} title="Select attendance status" value={status} onChange={setStatus} placeholder={t("reportsPage.allStatuses")} allLabel={t("reportsPage.allStatuses")} searchPlaceholder="Search status" clearValue="" options={[
            { value: "present", label: t("reportsPage.present") },
            { value: "half_day", label: t("reportsPage.halfDay") },
            { value: "absent", label: t("reportsPage.absent") },
          ]} />}

          {report === "advances" && views.advances === "log" && <ClearableSelect clearValue="desc" aria-label={t("reportsPage.advanceSort")} value={advanceSort} onChange={(value) => setAdvanceSort(value as SortOrder)}>
            <option value="desc">{t("advancesPage.newestFirst")}</option>
            <option value="asc">{t("advancesPage.oldestFirst")}</option>
          </ClearableSelect>}

          {report === "expenditures" && <>
            <ClearableSelect aria-label={t("reportsPage.account")} value={accountId} onChange={setAccountId}>
              <option value="">{t("reportsPage.allAccounts")}</option>
              {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
            </ClearableSelect>
            <ClearableSelect aria-label={t("reportsPage.category")} value={category} onChange={setCategory}>
              <option value="">{t("reportsPage.allCategories")}</option>
              {voucherCategories.map((item) => <option key={item} value={item}>{translateExpenseCategory(item)}</option>)}
            </ClearableSelect>
            <ClearableSelect aria-label={t("reportsPage.subcategory")} value={subcategory} onChange={setSubcategory}>
              <option value="">{t("reportsPage.allSubcategories")}</option>
              {voucherSubcategories.map((item) => <option key={item} value={item}>{translateExpenseSubcategory(item)}</option>)}
            </ClearableSelect>
            {views.expenditures === "log" && <ClearableSelect clearValue="desc" aria-label={t("reportsPage.expenseSort")} value={expenseSort} onChange={(value) => setExpenseSort(value as SortOrder)}>
              <option value="desc">{t("advancesPage.newestFirst")}</option>
              <option value="asc">{t("advancesPage.oldestFirst")}</option>
            </ClearableSelect>}
            <input aria-label={t("reportsPage.minimumAmount")} inputMode="decimal" placeholder={t("reportsPage.minimumAmount")} value={amountMin} onChange={(event) => setAmountMin(event.target.value)} />
            <input aria-label={t("reportsPage.maximumAmount")} inputMode="decimal" placeholder={t("reportsPage.maximumAmount")} value={amountMax} onChange={(event) => setAmountMax(event.target.value)} />
          </>}

          {report === "sales" && <>
            <ClearableSelect aria-label={t("reportsPage.saleType")} clearValue="all" value={saleTypeFilter} onChange={(value) => setSaleTypeFilter(value as SalesTypeFilter)}>
              <option value="all">{t("reportsPage.allSaleTypes")}</option>
              <option value="dispatch_sale">{translateSaleType("dispatch_sale")}</option>
              <option value="farm_direct_sale">{translateSaleType("farm_direct_sale")}</option>
            </ClearableSelect>
          </>}

          {report === "sales" && <>
            <input aria-label={t("reportsPage.buyer")} placeholder={t("reportsPage.buyer")} value={buyerFilter} onChange={(event) => setBuyerFilter(event.target.value)} />
            <input aria-label={t("reportsPage.productVariety")} placeholder={t("reportsPage.productVariety")} value={productFilter} onChange={(event) => setProductFilter(event.target.value)} />
            <input aria-label={t("reportsPage.minimumAmount")} inputMode="decimal" placeholder={t("reportsPage.minimumAmount")} value={amountMin} onChange={(event) => setAmountMin(event.target.value)} />
            <input aria-label={t("reportsPage.maximumAmount")} inputMode="decimal" placeholder={t("reportsPage.maximumAmount")} value={amountMax} onChange={(event) => setAmountMax(event.target.value)} />
            <ClearableSelect aria-label={t("reportsPage.paymentStatus")} value={paymentStatusFilter} onChange={setPaymentStatusFilter}>
              <option value="">{t("reportsPage.allPaymentStatuses")}</option>
              <option value="paid">{t("reportsPage.paymentStatuses.paid")}</option>
              <option value="partial">{t("reportsPage.paymentStatuses.partial")}</option>
              <option value="unpaid">{t("reportsPage.paymentStatuses.unpaid")}</option>
            </ClearableSelect>
          </>}

          {report === "dispatch" && <>
            <input aria-label={t("reportsPage.productVariety")} placeholder={t("reportsPage.productVariety")} value={productFilter} onChange={(event) => setProductFilter(event.target.value)} />
            <input aria-label={t("reportsPage.vehicle")} placeholder={t("reportsPage.vehicle")} value={vehicleFilter} onChange={(event) => setVehicleFilter(event.target.value)} />
          </>}

          {report === "partner-position" && <>
            <ClearableSelect aria-label={t("reportsPage.partner")} value={accountId} onChange={setAccountId}>
              <option value="">{t("reportsPage.allAccounts")}</option>
              {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
            </ClearableSelect>
            <input aria-label={t("reportsPage.minimumAmount")} inputMode="decimal" placeholder={t("reportsPage.minimumAmount")} value={amountMin} onChange={(event) => setAmountMin(event.target.value)} />
            <input aria-label={t("reportsPage.maximumAmount")} inputMode="decimal" placeholder={t("reportsPage.maximumAmount")} value={amountMax} onChange={(event) => setAmountMax(event.target.value)} />
          </>}

          {report === "account-ledger" && <>
            <ClearableSelect aria-label={t("reportsPage.account")} value={accountId} onChange={setAccountId}>
              <option value="">{t("reportsPage.allAccounts")}</option>
              {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
            </ClearableSelect>
            <input aria-label={t("reportsPage.minimumAmount")} inputMode="decimal" placeholder={t("reportsPage.minimumAmount")} value={amountMin} onChange={(event) => setAmountMin(event.target.value)} />
            <input aria-label={t("reportsPage.maximumAmount")} inputMode="decimal" placeholder={t("reportsPage.maximumAmount")} value={amountMax} onChange={(event) => setAmountMax(event.target.value)} />
          </>}
        </div>
      </section>

      {report === "attendance" && <>
        {views.attendance === "register" && <ReportShell
          title={t("reportsPage.attendanceRegister")}
          rangeLabel={rangeLabel}
          sectionId="attendance-register"
          onPrint={() => printSection("attendance-register-print")}
          onPdfExport={() => printSection("attendance-register-print")}
          onExport={exportAttendanceRegister}
          printLabel="Print Register"
          pdfLabel="Export PDF"
        >
          {attendanceRegisterSwitch}
          <div className="attendance-register-kpis">
            <Kpis values={[[t("reportsPage.labour"), attendanceTotals.labourCount], [t("reportsPage.present"), attendanceTotals.present], [t("reportsPage.halfDay"), attendanceTotals.halfDay], [t("reportsPage.absent"), attendanceTotals.absent], [t("reportsPage.totalWages"), money(attendanceTotals.wages)]]} />
          </div>
          <div className="attendance-register-mobile-list">
            {attendanceSummary.map((item) => {
              const expanded = attendanceRegisterExpandedLabourerId === item.labourer.id;
              const summaryText = `Present ${item.present} • Half-day ${item.halfDay} • Payable ${formatNumber(item.payable)}`;
              return (
                <article className="attendance-register-mobile-card" key={item.labourer.id}>
                  <button
                    type="button"
                    className="attendance-register-mobile-card__summary"
                    aria-expanded={expanded}
                    onClick={() => setAttendanceRegisterExpandedLabourerId((current) => current === item.labourer.id ? null : item.labourer.id)}
                  >
                    <div className="attendance-register-mobile-card__copy">
                      <strong>{item.labourer.name}</strong>
                      <span>{summaryText}</span>
                    </div>
                    <b>{money(item.wage)}</b>
                  </button>
                  {expanded && (
                    <div className="attendance-register-mobile-card__details">
                      <div className="attendance-register-mobile-card__chips">
                        {attendanceDates.map((date) => {
                          const record = item.records.find((entry) => entry.date === date);
                          return (
                            <span key={date} className={`attendance-register-mobile-card__chip ${attendanceStatusClass(record?.status)}`}>
                              <strong>{formatShortDate(date)}</strong>
                              <small>{attendanceMark(record?.status)}</small>
                            </span>
                          );
                        })}
                      </div>
                      <div className="attendance-register-mobile-card__meta">
                        <span>{t("reportsPage.wageRate")}</span>
                        <strong>{item.missingRateDates.length > 0
                          ? t("wageRatesPage.missingRateWarning")
                          : item.wageRateLabel === "Mixed"
                            ? t("reportsPage.mixedRates")
                            : item.wageRateLabel
                              ? money(Number(item.wageRateLabel))
                              : t("wageRatesPage.noCurrentRate")}</strong>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
          <p className="reports-scroll-hint">Swipe horizontally to view dates.</p>
          <div className="attendance-register-preview">
            <div className="reports-register-shell">
              <p>{t("reportsPage.rangeShown", { range: rangeLabel })}</p>
              <ul>
                <li>{t("reportsPage.groupShown", { group: groupFilter === ungroupedValue ? t("reportsPage.ungrouped") : groupFilter || t("reportsPage.allGroups") })}</li>
                <li>{t("reportsPage.labourCountShown", { count: attendanceSummary.length })}</li>
              </ul>
            </div>
            <div className="attendance-import-table-wrap register-table-wrap">
              <table className="report-data-table attendance-register-table attendance-register-report">
                <thead>
                  <tr>
                    <th>{t("reportsPage.labour")}</th>
                    <th>{t("reportsPage.present")}</th>
                    <th>{t("reportsPage.halfDay")}</th>
                    <th>{t("reportsPage.payableDays")}</th>
                    {attendanceDates.map((date) => <th key={date}>{formatShortDate(date)}</th>)}
                    <th>{t("reportsPage.wageRate")}</th>
                    <th>{t("reportsPage.grossWages")}</th>
                  </tr>
                </thead>
                <tbody>
                  {attendanceSummary.map((item) => <tr key={item.labourer.id}>
                    <th>{item.labourer.name}</th>
                    <td>{item.present}</td>
                    <td>{item.halfDay}</td>
                    <td>{formatNumber(item.payable)}</td>
                    {attendanceDates.map((date) => {
                      const record = item.records.find((entry) => entry.date === date);
                      return (
                        <td key={date} className={attendanceStatusClass(record?.status)}>
                          {attendanceMark(record?.status)}
                        </td>
                      );
                    })}
                    <td>{item.missingRateDates.length > 0
                      ? t("wageRatesPage.missingRateWarning")
                      : item.wageRateLabel === "Mixed"
                        ? t("reportsPage.mixedRates")
                        : item.wageRateLabel
                          ? money(Number(item.wageRateLabel))
                          : t("wageRatesPage.noCurrentRate")}</td>
                    <td>{money(item.wage)}</td>
                  </tr>)}
                </tbody>
                <tfoot>
                  <tr>
                    <th>{t("reportsPage.payableDays")}</th>
                    <td />
                    <td />
                    <td>{formatNumber(attendanceTotals.payableDays)}</td>
                    {attendanceDateTotals.map((total, index) => <td key={attendanceDates[index]}>{formatNumber(total)}</td>)}
                    <td />
                    <td>{money(attendanceTotals.wages)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </ReportShell>}
        <section className="record-panel reports-print-section reports-print-only" data-print-section="attendance-register-print" aria-hidden="true">
          <div className="attendance-register-print-template">
            {attendancePrintPages.map(renderAttendanceRegisterPrintPage)}
          </div>
        </section>
        {views.attendance === "summary" && <ReportShell title={t("reportsPage.attendanceSummary")} rangeLabel={rangeLabel} sectionId="attendance-summary" onPrint={() => printSection("attendance-summary")} onExport={exportAttendanceSummary}>
          {attendanceRegisterSwitch}
          <div className="attendance-register-kpis">
            <Kpis values={[[t("reportsPage.labour"), attendanceTotals.labourCount], [t("reportsPage.present"), attendanceTotals.present], [t("reportsPage.halfDay"), attendanceTotals.halfDay], [t("reportsPage.absent"), attendanceTotals.absent], [t("reportsPage.totalWages"), money(attendanceTotals.wages)]]} />
          </div>
          <ReportTable empty={t("reportsPage.noRecords")} columns={[t("reportsPage.labour"), t("reportsPage.present"), t("reportsPage.halfDay"), t("reportsPage.absent"), t("reportsPage.payableDays"), t("reportsPage.totalWages")]} rows={attendanceSummary.map((item) => ({ id: item.labourer.id, title: item.labourer.name, value: money(item.wage), meta: `${t("reportsPage.payableDays")}: ${formatNumber(item.payable)}`, cells: [item.labourer.name, item.present, item.halfDay, item.absent, formatNumber(item.payable), money(item.wage)], details: [[t("reportsPage.present"), item.present], [t("reportsPage.halfDay"), item.halfDay], [t("reportsPage.absent"), item.absent]] }))} />
        </ReportShell>}
      </>}

      {report === "advances" && <>
        <section className="reports-subtabs reports-advance-switch" aria-label={t("reportsPage.summary")}>
          <button className={views.advances === "summary" ? "is-active" : ""} type="button" onClick={() => switchView("advances", "summary")}>{t("reportsPage.summary")}</button>
          <button className={views.advances === "log" ? "is-active" : ""} type="button" onClick={() => switchView("advances", "log")}>{t("reportsPage.log")}</button>
        </section>
        {views.advances === "summary" && <ReportShell title={t("reportsPage.advanceSummary")} rangeLabel={rangeLabel} sectionId="advance-summary" onPrint={() => printSection("advance-report-print")} onExport={exportAdvanceCsv} printLabel="Export PDF">
          <Kpis values={[
            ["Total advances", money(advanceReportTotals.totalAdvances)],
            ["Unique labourers", formatNumber(advanceReportTotals.uniqueLabourers)],
            ["Transactions", formatNumber(advanceReportTotals.transactions)],
            ["Adjusted in settlements", money(advanceReportTotals.adjustedInSettlements)],
            ["Outstanding advances", money(advanceReportTotals.outstandingAdvances)],
            ["Posted settlements", formatNumber(advanceReportTotals.postedSettlements)],
          ]} />
          {activeSettlements.length > 0 && <div className="reports-summary-list">
            {activeSettlements.map((settlement) => (
              <article key={settlement.id} className="reports-advance-settlement-card">
                <div className="reports-advance-settlement-card__text">
                  <strong>{settlement.settlementNumber}</strong>
                  <span>{formatSettlementCardRange(settlement.fromDate, settlement.toDate)}</span>
                </div>
                <strong className="reports-advance-settlement-card__amount">Adjusted {money(settlement.settledAdvanceAmount)}</strong>
              </article>
            ))}
          </div>}
          <ReportTable empty={t("reportsPage.noRecords")} columns={[t("reportsPage.labour"), t("reportsPage.transactions"), t("reportsPage.total"), t("reportsPage.netBalance")]} rows={advanceSummary.map((item) => ({ id: item.labourer.id, title: item.labourer.name, value: money(item.total), meta: `${item.records.length} ${t("reportsPage.transactions")} · ${t("reportsPage.netBalance")}: ${money(item.outstanding)}`, cells: [item.labourer.name, item.records.length, money(item.total), money(item.outstanding)], details: [[t("reportsPage.account"), [...new Set(item.records.map((record) => advancePaymentSourceName(record)))].join(", ")], [t("reportsPage.status"), item.labourer.active === false ? t("reportsPage.inactive") : t("reportsPage.active")]] }))} />
        </ReportShell>}
        {views.advances === "log" && <ReportShell title={t("reportsPage.advanceLog")} rangeLabel={rangeLabel} sectionId="advance-log" onPrint={() => printSection("advance-report-print")} onExport={exportAdvanceCsv} printLabel="Export PDF">
          <ReportTable empty={t("reportsPage.noRecords")} columns={[t("reportsPage.date"), t("reportsPage.labour"), "Advance amount", "Recovered", t("reportsPage.account"), "Status", t("reportsPage.reference")]} rows={advanceRows.map((item) => ({ id: item.id, title: advanceRecipientName(item), value: money(item.amount), meta: `${item.date} · ${advancePaymentSourceName(item)}`, cells: [item.date, advanceRecipientName(item), money(item.amount), money(item.recoveredAmount), advancePaymentSourceName(item), item.status, item.voucherNumber], details: [[t("reportsPage.labour"), advanceRecipientName(item)], [t("reportsPage.account"), advancePaymentSourceName(item)], ["Advance amount", money(item.amount)], ["Recovered", money(item.recoveredAmount)], ["Status", item.status], [t("reportsPage.notes"), item.notes || "-"], [t("reportsPage.reference"), item.voucherNumber]], onOpen: () => navigate(`/workspace/labour-advances?recordId=${item.id}`) }))} />
        </ReportShell>}
        <section className="record-panel reports-print-section reports-print-only" data-print-section="advance-report-print" aria-hidden="true">
          <div className="advance-report-print-template">
            {renderAdvanceReportPrintPage()}
          </div>
        </section>
      </>}

      {report === "wage-rates" && <ReportShell title={t("wageRatesPage.reportTitle")} rangeLabel={rangeLabel} sectionId="wage-rates" onPrint={() => printSection("wage-rates")} onExport={() => downloadCsv("wage-rates.csv", [
        [t("reportsPage.labour"), t("wageRatesPage.effectiveFrom"), t("wageRatesPage.effectiveTo"), t("wageRatesPage.dailyRate"), t("wageRatesPage.halfDayRate"), t("common.status")],
        ...wageRateReportRows.map((rate) => [
          labourName(rate.labourerId),
          rate.effectiveFrom,
          rate.effectiveTo || "",
          rate.dailyRate,
          normalizeHalfDayRate(rate),
          t(`wageRatesPage.status.${getWageRateStatus(rate, todayKey())}`),
        ]),
      ])}>
        <Kpis values={[[t("reportsPage.labour"), new Set(wageRateReportRows.map((rate) => rate.labourerId)).size], [t("wageRatesPage.activeRates"), wageRateReportRows.filter((rate) => getWageRateStatus(rate, todayKey()) === "active").length], [t("wageRatesPage.upcomingRates"), wageRateReportRows.filter((rate) => getWageRateStatus(rate, todayKey()) === "upcoming").length]]} />
        <ReportTable
          empty={t("wageRatesPage.noHistory")}
          columns={[t("reportsPage.labour"), t("wageRatesPage.effectiveFrom"), t("wageRatesPage.effectiveTo"), t("wageRatesPage.dailyRate"), t("wageRatesPage.halfDayRate"), t("common.status")]}
          rows={wageRateReportRows.map((rate) => ({
            id: rate.id,
            title: labourName(rate.labourerId),
            value: money(rate.dailyRate),
            meta: `${t("wageRatesPage.halfDayRate")}: ${money(normalizeHalfDayRate(rate))}`,
            cells: [
              labourName(rate.labourerId),
              rate.effectiveFrom,
              rate.effectiveTo || "-",
              money(rate.dailyRate),
              money(normalizeHalfDayRate(rate)),
              t(`wageRatesPage.status.${getWageRateStatus(rate, todayKey())}`),
            ],
            details: [[t("wageRatesPage.rateType"), rate.rateType], [t("reportsPage.notes"), rate.notes || "-"]],
          }))}
        />
      </ReportShell>}

      {report === "expenditures" && <>
        <section className="record-panel reports-subtabs">
          <button className={views.expenditures === "summary" ? "is-active" : ""} type="button" onClick={() => switchView("expenditures", "summary")}>{t("reportsPage.summary")}</button>
          <button className={views.expenditures === "log" ? "is-active" : ""} type="button" onClick={() => switchView("expenditures", "log")}>{t("reportsPage.log")}</button>
        </section>
        {views.expenditures === "summary" && <ReportShell title={t("reportsPage.expenseSummary")} rangeLabel={rangeLabel} sectionId="expense-summary" onPrint={() => printSection("expense-summary")} onExport={exportExpenseSummary}>
          <Kpis values={[[t("reportsPage.totalExpenses"), money(totalRecognizedExpenses)], [t("reportsPage.vouchers"), new Set([...voucherRows.map((item) => getVoucherDisplayNumber(item) || item.voucherNumber), ...canonicalExpenseRows.map((item) => item.dueNumber ?? item.id)]).size], [t("reportsPage.categories"), new Set([...voucherReportLineRows.map((item) => item.category), ...(canonicalExpenseRows.length ? ["Labour wages"] : [])]).size], [t("reportsPage.account"), expenseAccountTotals.length]]} />
          <div className="reports-breakdowns">
            <div>
              <h3>{t("reportsPage.byCategory")}</h3>
              <div className="reports-summary-list">
                {[...new Set(voucherReportLineRows.map((item) => item.category))].map((name) => <article key={name}><span>{translateExpenseCategory(name)}</span><strong>{money(voucherReportLineRows.filter((item) => item.category === name).reduce((sum, item) => sum + item.amount, 0))}</strong></article>)}
                {canonicalExpenseRows.length ? <article><span>Labour wages</span><strong>{money(canonicalExpenseRows.reduce((sum, item) => sum + item.amount, 0))}</strong></article> : null}
              </div>
            </div>
            <div>
              <h3>{t("reportsPage.byAccount")}</h3>
              <div className="reports-summary-list">
                {expenseAccountTotals.map(([name, value]) => <article key={name}><span>{name}</span><strong>{money(value)}</strong></article>)}
              </div>
            </div>
          </div>
        </ReportShell>}
        {views.expenditures === "log" && <ReportShell title={t("reportsPage.expenseLog")} rangeLabel={rangeLabel} sectionId="expense-log" onPrint={() => printSection("expense-log")} onExport={exportExpenseLog}>
          <ReportTable empty={t("reportsPage.noRecords")} columns={[t("reportsPage.voucher"), t("reportsPage.date"), t("reportsPage.description"), t("reportsPage.category"), t("reportsPage.account"), t("reportsPage.amount")]} rows={[...voucherRows.map((item) => {
            const lines = voucherReportItems(item);
            const firstLine = lines[0];
            return {
              id: item.id,
              title: getVoucherDisplayNumber(item) || item.voucherNumber,
              value: money(item.amount),
              meta: item.date,
              cells: [
                getVoucherDisplayNumber(item) || item.voucherNumber,
                item.date,
                lines.length > 1 ? `${firstLine?.description ?? item.description} +${lines.length - 1} ${t("expensesPage.moreItems")}` : item.description,
                firstLine ? expenseLabel(firstLine.category, firstLine.subcategory) : expenseLabel(item.category, item.subcategory),
                accountName(item.accountId),
                money(item.amount),
              ],
              details: [...lines.map((line, index) => [`${t("expensesPage.itemNumber", { number: index + 1 })}`, `${line.description} • ${expenseLabel(line.category, line.subcategory)} • ${money(line.amount)}`] as [string, ReactNode]), [t("reportsPage.account"), accountName(item.accountId)] as [string, ReactNode]],
              onOpen: () => navigate(`/workspace/expenses?recordId=${item.id}`),
            };
          }), ...canonicalExpenseRows.map((item) => {
            const sources = canonicalExpenseAccountsByDue.get(item.id) ?? [];
            const sourceLabel = sources.map((source) => `${source.accountName} — ${money(source.amount)}`).join("; ") || "Unattributed";
            return { id: item.id, title: item.dueNumber ?? item.recipientName, value: money(item.amount), meta: item.date, cells: [item.dueNumber ?? "-", item.date, item.description, "Labour wages", sourceLabel, money(item.amount)], details: [["Status", item.status], ["Recipient", item.recipientName], ...sources.map((source) => [source.settlementType.replaceAll("_", " "), `${source.accountName} — ${money(source.amount)}`] as [string, ReactNode])] as [string, ReactNode][] };
          })]} />
        </ReportShell>}
      </>}

      {report === "sales" && <ReportShell title={t("reportsPage.salesReport")} rangeLabel={`${t(`reportsPage.salesDateTypes.${salesDateType}`)} • ${rangeLabel}`} sectionId="sales-report" onPrint={() => printSection("sales-report")} onExport={exportSalesReport}>
        <Kpis values={[
          [t("reportsPage.totalSalesAmount"), money(salesReportRows.reduce((sum, item) => sum + item.sale.amount, 0))],
          [t("reportsPage.totalQuantitySold"), formatNumber(salesReportRows.reduce((sum, item) => sum + item.sale.quantity, 0))],
          [t("reportsPage.totalInvoices"), salesReportRows.length],
          [t("reportsPage.outstandingReceivables"), money(salesReportRows.reduce((sum, item) => sum + item.outstanding, 0))],
        ]} />
        <ReportTable empty={t("reportsPage.noRecords")} columns={[t("reportsPage.saleType"), t("reportsPage.saleDate"), t("reportsPage.invoiceNumber"), t("reportsPage.buyerName"), t("reportsPage.plot"), t("reportsPage.dispatchReference"), t("reportsPage.product"), t("reportsPage.quantity"), t("reportsPage.unit"), t("reportsPage.rate"), t("reportsPage.amount"), t("expensesPage.paymentAccount"), t("reportsPage.paymentDate"), t("reportsPage.paymentStatus"), t("reportsPage.remarks")]} rows={salesReportRows.map((item) => ({
          id: item.sale.id,
          title: item.invoiceNumber === "-" ? item.product : item.invoiceNumber,
          value: money(item.sale.amount),
          meta: `${item.sale.date} | ${item.buyerName}`,
          cells: [item.saleType, item.sale.date, item.invoiceNumber, item.buyerName, item.plot, item.dispatchReference, item.product, formatNumber(item.sale.quantity), item.unit, money(item.sale.unitPrice), money(item.sale.amount), item.paymentAccount, item.sale.paymentDate || "-", translateSalesStatus(item.paymentStatus), item.sale.remarks || "-"],
            details: [
              [t("reportsPage.saleType"), item.saleType],
            [t("reportsPage.dispatchReference"), item.dispatchReference],
            [t("reportsPage.paymentsReceived"), money(item.paymentsReceived)],
            [t("reportsPage.outstanding"), money(item.outstanding)],
          ],
          onOpen: () => setSelectedSaleRecord(item),
        }))} />
      </ReportShell>}

      {report === "dispatch" && <ReportShell title={t("reportsPage.dispatchReport")} rangeLabel={`${t(`reportsPage.dispatchDateTypes.${dispatchDateType}`)} • ${rangeLabel}`} sectionId="dispatch-report" onPrint={() => printSection("dispatch-report")} onExport={exportDispatchReport}>
        <Kpis values={[
          [t("reportsPage.totalDispatches"), new Set(dispatchReportRows.map((item) => item.dispatch.id)).size],
          [t("reportsPage.totalQuantity"), formatNumber(dispatchReportRows.reduce((sum, item) => sum + item.quantity, 0))],
          [t("reportsPage.soldQuantity"), formatNumber(dispatchReportRows.reduce((sum, item) => sum + item.soldQuantity, 0))],
          [t("reportsPage.remainingQuantity"), formatNumber(dispatchReportRows.reduce((sum, item) => sum + item.remainingQuantity, 0))],
        ]} />
        <ReportTable empty={t("reportsPage.noRecords")} columns={[t("reportsPage.dispatchDate"), t("reportsPage.dispatchNumber"), t("reportsPage.product"), t("reportsPage.quantity"), t("reportsPage.unit"), t("reportsPage.vehicle"), t("reportsPage.driver"), t("reportsPage.linkedSale"), t("reportsPage.soldQuantity"), t("reportsPage.remainingQuantity"), t("reportsPage.remarks")]} rows={dispatchReportRows.map((item) => ({
          id: item.id,
          title: item.dispatchNumber,
          value: `${formatNumber(item.quantity)} ${item.unit}`,
          meta: `${item.dispatch.date} | ${item.product}`,
          cells: [item.dispatch.date, item.dispatchNumber, item.product, formatNumber(item.quantity), item.unit, item.vehicle, item.driver, item.linkedSales.map((sale) => invoiceReference(sale)).join(", ") || "-", formatNumber(item.soldQuantity), formatNumber(item.remainingQuantity), item.dispatch.remarks || item.dispatch.notes || "-"],
          details: [
            [t("reportsPage.soldQuantity"), formatNumber(item.soldQuantity)],
            [t("reportsPage.remainingQuantity"), formatNumber(item.remainingQuantity)],
            [t("reportsPage.linkedSale"), item.linkedSales.map((sale) => invoiceReference(sale)).join(", ") || "-"],
          ],
          onOpen: () => setSelectedDispatchRecord(item),
        }))} />
      </ReportShell>}

      {report === "partner-position" && <>
        <section className="record-panel reports-subtabs">
          <button className={views["partner-position"] === "position" ? "is-active" : ""} type="button" onClick={() => switchView("partner-position", "position")}>{t("reportsPage.position")}</button>
          <button className={views["partner-position"] === "ledger" ? "is-active" : ""} type="button" onClick={() => switchView("partner-position", "ledger")}>{t("reportsPage.ledger")}</button>
        </section>
        {views["partner-position"] === "position" && <ReportShell title={t("reportsPage.partnerPositionTitle")} rangeLabel={rangeLabel} sectionId="partner-position" onPrint={() => printSection("partner-position")} onExport={exportPartnerPosition}>
          <ReportTable empty={t("reportsPage.noRecords")} columns={[t("reportsPage.partner"), "Purchase vouchers", "Funds given", "Funds received", "Direct labour payments", "Outstanding labour advances", t("reportsPage.currentPartnerBalance")]} rows={partnerLiabilityPositions.map((item) => ({ id: item.key, title: item.name, value: money(item.currentPartnerBalance), meta: getPartnerBalanceState(item.currentPartnerBalance) === "partner_holds_business_money" ? t("reportsPage.partnerHoldsBusinessMoney") : t("reportsPage.farmOwesPartner"), cells: [item.name, money(item.purchaseVouchersPaid), money(item.transfersOut), money(item.transfersIn), money(item.labourSettlementCashPaid), money(item.outstandingLabourAdvances), money(item.currentPartnerBalance)], details: [[t("reportsPage.adjustments"), money(item.adjustments)], ["Funds given", money(item.transfersOut)], ["Funds received", money(item.transfersIn)], ["Total labour advances paid", money(item.totalLabourAdvancesPaid)], ["Direct labour payments", money(item.labourSettlementCashPaid)], ["Settled through wages", money(item.settledAdvances)], ["Outstanding labour advances", money(item.outstandingLabourAdvances)], [t("reportsPage.moneyReturned"), money(item.moneyReturned)]] }))} />
        </ReportShell>}
        {views["partner-position"] === "ledger" && <ReportShell title={t("reportsPage.partnerLedger")} rangeLabel={rangeLabel} sectionId="partner-ledger" onPrint={() => printSection("partner-ledger")} onExport={exportPartnerLedger}>
          <ReportTable empty={t("reportsPage.noRecords")} columns={[t("reportsPage.date"), t("reportsPage.partner"), t("reportsPage.type"), t("reportsPage.amount"), t("reportsPage.notes")]} rows={partnerRows.map((item) => ({ id: item.id, title: item.partnerName ?? `${item.fromPartner ?? "-"} → ${item.toPartner ?? "-"}`, value: money(item.amount), meta: item.date, cells: [item.date, item.partnerName ?? `${item.fromPartner ?? "-"} → ${item.toPartner ?? "-"}`, item.type, money(item.amount), item.notes || "-"], details: [[t("reportsPage.type"), item.type], [t("reportsPage.notes"), item.notes || "-"]], onOpen: () => navigate(`/workspace/partner-ledger?recordId=${item.id}`) }))} />
        </ReportShell>}
      </>}

      {report === "account-ledger" && <>
        <section className="record-panel reports-subtabs">
          <button className={views["account-ledger"] === "balances" ? "is-active" : ""} type="button" onClick={() => switchView("account-ledger", "balances")}>{t("reportsPage.balances")}</button>
          <button className={views["account-ledger"] === "ledger" ? "is-active" : ""} type="button" onClick={() => switchView("account-ledger", "ledger")}>{t("reportsPage.ledger")}</button>
        </section>
        {views["account-ledger"] === "balances" && <ReportShell title={t("reportsPage.accountBalances")} rangeLabel={rangeLabel} sectionId="account-balances" onPrint={() => printSection("account-balances")} onExport={exportAccountBalances}>
          <div className="reports-kpis">{positions.map((item) => <article className="account-card-clickable" key={item.account.id} role="button" tabIndex={0} onClick={() => openAccountLedger(item.account.id)} onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              openAccountLedger(item.account.id);
            }
          }}><span>{item.account.name}</span><strong>{money(item.net)}</strong><small>{t("reportsPage.viewLedger")}</small></article>)}</div>
        </ReportShell>}
        {views["account-ledger"] === "ledger" && <ReportShell title={t("reportsPage.accountLedgerTitle")} rangeLabel={rangeLabel} sectionId="account-ledger" onPrint={() => printSection("account-ledger")} onExport={exportAccountLedger}>
          {isPartnerLedgerReport && partnerAccountLedgerOverviewView
            ? <>
              <div className="account-ledger-breakdown account-ledger-breakdown--partner">
                <article><strong>{t("reportsPage.account")}</strong><b>{selectedAccountRecord?.name ?? t("reportsPage.allAccounts")}</b></article>
                <article><strong>{t("reportsPage.currentPartnerBalance")}</strong><b>{money(currentLedgerBalance)}</b></article>
                <article><strong>{t("reportsPage.capitalInjected")}</strong><span>{money(partnerAccountLedgerOverviewView.capitalInjected)}</span></article>
                <article className="account-ledger-breakdown__expenses-card">
                  <strong>{t("reportsPage.directExpensesPaid")}</strong>
                  <b>{money(partnerAccountLedgerOverviewView.directExpensesPaid)}</b>
                  <small>Purchase vouchers: {money(partnerAccountLedgerOverviewView.purchaseVouchersPaid)}</small>
                  <small>Labour advances: {money(partnerAccountLedgerOverviewView.labourAdvancesPaid)}</small>
                </article>
                <article><strong>{t("reportsPage.transfersOut")}</strong><span>{money(partnerAccountLedgerOverviewView.transfersOut)}</span></article>
                <article><strong>{t("reportsPage.transfersIn")}</strong><span>{money(partnerAccountLedgerOverviewView.transfersIn)}</span></article>
                <article><strong>{t("reportsPage.moneyReturned")}</strong><span>{money(partnerAccountLedgerOverviewView.moneyReturned)}</span></article>
                <article><strong>{t("reportsPage.adjustments")}</strong><span>{money(partnerAccountLedgerOverviewView.adjustments)}</span></article>
              </div>
              <section className="account-ledger-reconciliation">
                <h3>{t("reportsPage.reconciliationTitle")}</h3>
                <div className="account-ledger-reconciliation__rows">
                  <div><span>{t("reportsPage.capitalInjected")}</span><strong>{money(partnerAccountLedgerOverviewView.capitalInjected)}</strong></div>
                  <div><span>+ {t("reportsPage.directExpensesPaid")}</span><strong>{money(partnerAccountLedgerOverviewView.directExpensesPaid)}</strong></div>
                  <div><span>+ {t("reportsPage.transfersOut")}</span><strong>{money(partnerAccountLedgerOverviewView.transfersOut)}</strong></div>
                  <div><span>- {t("reportsPage.transfersIn")}</span><strong>{money(partnerAccountLedgerOverviewView.transfersIn)}</strong></div>
                  <div><span>- {t("reportsPage.moneyReturned")}</span><strong>{money(partnerAccountLedgerOverviewView.moneyReturned)}</strong></div>
                  <div><span>+/- {t("reportsPage.adjustments")}</span><strong>{money(partnerAccountLedgerOverviewView.adjustments)}</strong></div>
                  <div className="account-ledger-reconciliation__total"><span>= {t("reportsPage.reconciliationComputed")}</span><strong>{money(partnerAccountLedgerOverviewView.netBalance)}</strong></div>
                </div>
                {Math.abs(partnerAccountLedgerOverviewView.netBalance - currentLedgerBalance) > 0.009 && <p className="worker-action-warning">{t("reportsPage.reconciliationComponentsWarning")}</p>}
              </section>
            </>
            : <Kpis values={[
              [t("reportsPage.account"), selectedAccountRecord?.name ?? t("reportsPage.allAccounts")],
              [t("reportsPage.currentBalance"), money(currentLedgerBalance)],
              [t("reportsPage.voucherExpenses"), money(standardAccountLedgerSummaryView?.expenses ?? 0)],
              [t("reportsPage.labourAdvance"), money(standardAccountLedgerSummaryView?.advances ?? 0)],
              [t("reportsPage.settlements"), money(standardAccountLedgerSummaryView?.settlements ?? 0)],
              [t("reportsPage.incomeFundsSales"), money(standardAccountLedgerSummaryView?.income ?? 0)],
              [t("reportsPage.netPosition"), money(standardAccountLedgerSummaryView?.netBalance ?? 0)],
            ]} />}
          {showReportLedgerWarning && <p className="worker-action-warning">{t("reportsPage.groupedReconciliationWarning", { delta: money(reportLedgerDelta) })}</p>}
          {showReportNoVisibleTransactionsWarning && <p className="worker-action-warning">{t("reportsPage.noVisibleTransactionsWarning")}</p>}
          <label className="account-ledger-toggle"><input type="checkbox" checked={showEmptyLedgerGroups} onChange={(event) => setShowEmptyLedgerGroups(event.target.checked)} />{t("reportsPage.showEmptyGroups")}</label>
          {isPartnerLedgerReport
            ? (!visiblePartnerLedgerGroups.length ? <p className="empty-records">{t("reportsPage.noRecords")}</p> : <div className="account-transaction-groups">
            {visiblePartnerLedgerGroups.map((group) => {
              const expanded = partnerReportGroupExpanded[group.groupKey];
              return <section className="account-transaction-group" key={group.groupKey}>
                <button className="account-transaction-group__header" type="button" onClick={() => setPartnerReportGroupExpanded((current) => ({ ...current, [group.groupKey]: !current[group.groupKey] }))}>
                  <span className="account-transaction-group__title">{expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}{partnerLiabilityGroupTitle(group.groupKey)}</span>
                  <span className="account-transaction-group__meta"><strong>{money(partnerLiabilityGroupDisplayTotal(group.groupKey, group.totalAmount))}</strong><small>{t("reportsPage.transactionCount", { count: group.count })}</small></span>
                </button>
                {expanded && <ReportTable empty={t("reportsPage.noRecords")} columns={[t("reportsPage.date"), t("reportsPage.account"), t("reportsPage.type"), t("reportsPage.reference"), t("reportsPage.debit"), t("reportsPage.credit"), t("reportsPage.runningBalance")]} rows={group.transactions.map((item) => ({ id: item.id, title: item.reference, value: item.memoAmount !== undefined ? money(item.memoAmount) : (item.credit ? `+${money(item.credit)}` : `-${money(item.debit)}`), meta: `${item.date} | ${item.accountName}`, cells: [item.date, item.accountName, item.typeLabel, item.reference, item.memoAmount !== undefined ? "-" : (item.debit ? money(item.debit) : "-"), item.memoAmount !== undefined ? money(item.memoAmount) : (item.credit ? money(item.credit) : "-"), money(item.running)], details: [[t("reportsPage.description"), item.description], [t("reportsPage.runningBalance"), money(item.running)], ...(item.memoAmount !== undefined ? [["Memo", "Non-cash labour advance settlement"] as [string, ReactNode]] : [])], onOpen: () => navigate(item.path) }))} />}
              </section>;
            })}
          </div>)
            : (!visibleAccountLedgerGroups.length ? <p className="empty-records">{t("reportsPage.noRecords")}</p> : <div className="account-transaction-groups">
            {visibleAccountLedgerGroups.map((group) => {
              const expanded = reportGroupExpanded[group.groupKey];
              return <section className="account-transaction-group" key={group.groupKey}>
                <button className="account-transaction-group__header" type="button" onClick={() => setReportGroupExpanded((current) => ({ ...current, [group.groupKey]: !current[group.groupKey] }))}>
                  <span className="account-transaction-group__title">{expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}{ledgerGroupTitle(group.groupKey)}</span>
                  <span className="account-transaction-group__meta"><strong>{money(group.totalAmount)}</strong><small>{t("reportsPage.transactionCount", { count: group.count })}</small></span>
                </button>
                {expanded && <ReportTable empty={t("reportsPage.noRecords")} columns={[t("reportsPage.date"), t("reportsPage.account"), t("reportsPage.type"), t("reportsPage.reference"), t("reportsPage.debit"), t("reportsPage.credit"), t("reportsPage.runningBalance")]} rows={group.transactions.map((item) => ({ id: item.id, title: item.reference, value: item.memoAmount !== undefined ? money(item.memoAmount) : (item.credit ? `+${money(item.credit)}` : `-${money(item.debit)}`), meta: `${item.date} | ${item.accountName}`, cells: [item.date, item.accountName, item.typeLabel, item.reference, item.memoAmount !== undefined ? "-" : (item.debit ? money(item.debit) : "-"), item.memoAmount !== undefined ? money(item.memoAmount) : (item.credit ? money(item.credit) : "-"), money(item.running)], details: [[t("reportsPage.description"), item.description], [t("reportsPage.runningBalance"), money(item.running)], ...(item.memoAmount !== undefined ? [["Memo", "Non-cash labour advance settlement"] as [string, ReactNode]] : [])], onOpen: () => navigate(item.path) }))} />}
              </section>;
            })}
          </div>)}
        </ReportShell>}
      </>}

      {selectedSaleRecord && <div className="worker-dialog-backdrop" role="presentation" onClick={() => setSelectedSaleRecord(null)}>
        <section className="worker-dialog worker-dialog--record-detail account-ledger-dialog" role="dialog" aria-modal="true" aria-label={t("reportsPage.salesDetailTitle")} onClick={(event) => event.stopPropagation()}>
          <header className="worker-dialog__header">
            <h2>{t("reportsPage.salesDetailTitle")}</h2>
            <button type="button" onClick={() => setSelectedSaleRecord(null)}><X size={18} /></button>
          </header>
          <div className="worker-dialog__body">
            <dl className="worker-stats">
              <div><dt>{t("reportsPage.invoiceNumber")}</dt><dd>{selectedSaleRecord.invoiceNumber}</dd></div>
              <div><dt>{t("reportsPage.buyerName")}</dt><dd>{selectedSaleRecord.buyerName}</dd></div>
              <div><dt>{t("reportsPage.saleType")}</dt><dd>{selectedSaleRecord.saleType}</dd></div>
              <div><dt>{t("reportsPage.saleDate")}</dt><dd>{selectedSaleRecord.sale.date}</dd></div>
              <div><dt>{t("reportsPage.dispatchDate")}</dt><dd>{selectedSaleRecord.sale.dispatchDate ?? "-"}</dd></div>
              <div><dt>{t("reportsPage.deliveryDate")}</dt><dd>{selectedSaleRecord.sale.deliveryDate ?? "-"}</dd></div>
              <div><dt>{t("reportsPage.paymentDate")}</dt><dd>{selectedSaleRecord.sale.paymentDate ?? "-"}</dd></div>
              <div><dt>{t("reportsPage.plot")}</dt><dd>{selectedSaleRecord.plot}</dd></div>
              <div><dt>{t("reportsPage.product")}</dt><dd>{selectedSaleRecord.product}</dd></div>
              <div><dt>{t("reportsPage.quantity")}</dt><dd>{formatNumber(selectedSaleRecord.sale.quantity)} {selectedSaleRecord.unit}</dd></div>
              <div><dt>{t("reportsPage.rate")}</dt><dd>{money(selectedSaleRecord.sale.unitPrice)}</dd></div>
              <div><dt>{t("reportsPage.totalAmount")}</dt><dd>{money(selectedSaleRecord.sale.amount)}</dd></div>
              <div><dt>{t("expensesPage.paymentAccount")}</dt><dd>{selectedSaleRecord.paymentAccount}</dd></div>
              <div><dt>{t("reportsPage.paymentsReceived")}</dt><dd>{money(selectedSaleRecord.paymentsReceived)}</dd></div>
              <div><dt>{t("reportsPage.outstanding")}</dt><dd>{money(selectedSaleRecord.outstanding)}</dd></div>
              <div><dt>{t("reportsPage.paymentStatus")}</dt><dd>{translateSalesStatus(selectedSaleRecord.paymentStatus)}</dd></div>
              <div><dt>{t("reportsPage.remarks")}</dt><dd>{selectedSaleRecord.sale.remarks || "-"}</dd></div>
            </dl>
            <div className="reports-detail-links">
              <button type="button" onClick={() => navigate(`/workspace/sales?recordId=${selectedSaleRecord.sale.id}`)}>{t("reportsPage.view")}</button>
              <button type="button" onClick={() => navigate(`/workspace/sales?recordId=${selectedSaleRecord.sale.id}&mode=edit`)}>{t("reportsPage.edit")}</button>
              <button type="button" onClick={() => void deleteSaleRecord(selectedSaleRecord.sale)}>{t("reportsPage.delete")}</button>
              <button type="button" onClick={() => printSection("sales-report")}>{t("reportsPage.print")}</button>
              {selectedSaleRecord.sale.dispatchId && <button type="button" onClick={() => {
                const linked = dispatchReportRows.find((item) => item.dispatch.id === selectedSaleRecord.sale.dispatchId && item.linkedSales.some((sale) => sale.id === selectedSaleRecord.sale.id));
                if (linked) setSelectedDispatchRecord(linked);
              }}>{t("reportsPage.openLinkedDispatch")}</button>}
            </div>
          </div>
        </section>
      </div>}

      {selectedDispatchRecord && <div className="worker-dialog-backdrop" role="presentation" onClick={() => setSelectedDispatchRecord(null)}>
        <section className="worker-dialog worker-dialog--record-detail account-ledger-dialog" role="dialog" aria-modal="true" aria-label={t("reportsPage.dispatchDetailTitle")} onClick={(event) => event.stopPropagation()}>
          <header className="worker-dialog__header">
            <h2>{t("reportsPage.dispatchDetailTitle")}</h2>
            <button type="button" onClick={() => setSelectedDispatchRecord(null)}><X size={18} /></button>
          </header>
          <div className="worker-dialog__body">
            <dl className="worker-stats">
              <div><dt>{t("reportsPage.dispatchNumber")}</dt><dd>{selectedDispatchRecord.dispatchNumber}</dd></div>
              <div><dt>{t("reportsPage.dispatchDate")}</dt><dd>{selectedDispatchRecord.dispatch.date}</dd></div>
              <div><dt>{t("reportsPage.product")}</dt><dd>{selectedDispatchRecord.product}</dd></div>
              <div><dt>{t("reportsPage.quantity")}</dt><dd>{formatNumber(selectedDispatchRecord.quantity)} {selectedDispatchRecord.unit}</dd></div>
              <div><dt>{t("reportsPage.vehicle")}</dt><dd>{selectedDispatchRecord.vehicle}</dd></div>
              <div><dt>{t("reportsPage.driver")}</dt><dd>{selectedDispatchRecord.driver}</dd></div>
              <div><dt>{t("reportsPage.soldQuantity")}</dt><dd>{formatNumber(selectedDispatchRecord.soldQuantity)}</dd></div>
              <div><dt>{t("reportsPage.remainingQuantity")}</dt><dd>{formatNumber(selectedDispatchRecord.remainingQuantity)}</dd></div>
              <div><dt>{t("reportsPage.remarks")}</dt><dd>{selectedDispatchRecord.dispatch.remarks || selectedDispatchRecord.dispatch.notes || "-"}</dd></div>
            </dl>
            {selectedDispatchRecord.linkedSales.length > 0 && <div className="reports-linked-records">
              <h3>{t("reportsPage.linkedSales")}</h3>
              {selectedDispatchRecord.linkedSales.map((sale) => <button key={sale.id} type="button" className="reports-linked-record" onClick={() => {
                const linked = salesReportRows.find((item) => item.sale.id === sale.id);
                if (linked) setSelectedSaleRecord(linked);
              }}>{invoiceReference(sale)} • {normalizeText(sale.buyerName) || t("reportsPage.unassignedBuyer")} • {money(sale.amount)}</button>)}
            </div>}
            <div className="reports-detail-links">
              <button type="button" onClick={() => navigate(`/workspace/dispatch?recordId=${selectedDispatchRecord.dispatch.id}`)}>{t("reportsPage.view")}</button>
              <button type="button" onClick={() => navigate(`/workspace/dispatch?recordId=${selectedDispatchRecord.dispatch.id}`)}>{t("reportsPage.edit")}</button>
              <button type="button" onClick={() => printSection("dispatch-report")}>{t("reportsPage.print")}</button>
            </div>
          </div>
        </section>
      </div>}
    </main>
  </div>;
}
