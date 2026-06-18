import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { SearchInput } from "../../components/SearchInput";
import { SubpageHeader } from "../../components/SubpageHeader";
import { defaultTransactionGroupExpansion, groupAccountTransactions, type AccountTransactionGroupKey } from "../../lib/accountTransactionGroups";
import { calculateAccountBalance } from "../../lib/accounting";
import { formatMoney, formatNumber } from "../../lib/format";
import {
  buildPartnerLiabilityPositions,
  defaultPartnerLiabilityGroupExpansion,
  groupPartnerLiabilityTransactions,
  resolvePartnerAccountId,
  type PartnerLiabilityLedgerGroupKey,
} from "../../lib/partnerAccounting";
import { saleProduceLabel } from "../../lib/dispatch-sales";
import {
  offlineDb,
  workspaceRecords,
  type Account,
  type Advance,
  type Attendance,
  type Labourer,
  type PartnerEntry,
  type Sale,
  type Voucher,
} from "../../lib/offline-db";

type Report = "attendance" | "advances" | "expenditures" | "partner-position" | "account-ledger";
type SortOrder = "desc" | "asc";
type ReportViewState = {
  attendance: "register" | "summary";
  advances: "summary" | "log";
  expenditures: "summary" | "log";
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
  running: number;
  path: string;
  classification?: string;
  counterparty?: string;
  partnerLiabilityGroup?: PartnerLiabilityLedgerGroupKey;
};

const reportOptions: Report[] = ["attendance", "advances", "expenditures", "partner-position", "account-ledger"];
const defaultViews: ReportViewState = {
  attendance: "register",
  advances: "summary",
  expenditures: "summary",
  "partner-position": "position",
  "account-ledger": "balances",
};

const csvCell = (value: unknown) => `"${String(value ?? "").replaceAll("\"", "\"\"")}"`;
const money = formatMoney;
const inRange = (date: string, from: string, to: string) => (!from || date >= from) && (!to || date <= to);
const attendanceMark = (status?: Attendance["status"]) => status === "present" ? "P" : status === "half_day" ? "H" : status === "absent" ? "A" : "-";
const formatShortDate = (date: string) => date.length >= 10 ? `${date.slice(8, 10)}/${date.slice(5, 7)}` : date;
const formatRangeLabel = (from: string, to: string) => from && to ? `${from} - ${to}` : from ? `From ${from}` : to ? `To ${to}` : "All dates";

function downloadCsv(filename: string, rows: unknown[][]) {
  const href = URL.createObjectURL(new Blob([rows.map((row) => row.map(csvCell).join(",")).join("\n")], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(href);
}

function buildDateColumns(from: string, to: string, rows: Attendance[]) {
  if (from && to && from <= to) {
    const dates: string[] = [];
    const cursor = new Date(`${from}T00:00:00`);
    const end = new Date(`${to}T00:00:00`);
    while (cursor <= end) {
      dates.push(cursor.toISOString().slice(0, 10));
      cursor.setDate(cursor.getDate() + 1);
    }
    return dates;
  }
  return [...new Set(rows.map((row) => row.date))].sort();
}

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

function ReportShell({
  title,
  rangeLabel,
  sectionId,
  onPrint,
  onExport,
  children,
}: {
  title: string;
  rangeLabel: string;
  sectionId: string;
  onPrint: () => void;
  onExport: () => void;
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
        <button type="button" onClick={onExport}>{t("reportsPage.exportCsv")}</button>
        <button type="button" onClick={onPrint}>{t("reportsPage.print")}</button>
      </div>
    </header>
    {children}
  </section>;
}

export function Reports() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedReport = searchParams.get("report");
  const normalizedRequestedReport = requestedReport === "combined-expenses" ? "expenditures" : requestedReport as Report | null;
  const [report, setReport] = useState<Report>(normalizedRequestedReport && reportOptions.includes(normalizedRequestedReport) ? normalizedRequestedReport : "attendance");
  const [views, setViews] = useState<ReportViewState>(defaultViews);
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [accountId, setAccountId] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("");
  const [amountMin, setAmountMin] = useState("");
  const [amountMax, setAmountMax] = useState("");
  const [advanceSort, setAdvanceSort] = useState<SortOrder>("desc");
  const [expenseSort, setExpenseSort] = useState<SortOrder>("desc");
  const [showEmptyLedgerGroups, setShowEmptyLedgerGroups] = useState(false);
  const [reportGroupExpanded, setReportGroupExpanded] = useState<Record<AccountTransactionGroupKey, boolean>>(defaultTransactionGroupExpansion);
  const [partnerReportGroupExpanded, setPartnerReportGroupExpanded] = useState<Record<PartnerLiabilityLedgerGroupKey, boolean>>(defaultPartnerLiabilityGroupExpansion);
  const [labourers, setLabourers] = useState<Labourer[]>([]);
  const [attendance, setAttendance] = useState<Attendance[]>([]);
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [advances, setAdvances] = useState<Advance[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [entries, setEntries] = useState<PartnerEntry[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);

  useEffect(() => {
    void Promise.all([
      workspaceRecords(offlineDb.labourers),
      workspaceRecords(offlineDb.attendance),
      workspaceRecords(offlineDb.vouchers, { includeGeneralFarmRecords: true }),
      workspaceRecords(offlineDb.advances),
      workspaceRecords(offlineDb.accounts),
      workspaceRecords(offlineDb.partnerEntries),
      workspaceRecords(offlineDb.sales),
    ]).then(([nextLabourers, nextAttendance, nextVouchers, nextAdvances, nextAccounts, nextEntries, nextSales]) => {
      setLabourers(nextLabourers);
      setAttendance(nextAttendance);
      setVouchers(nextVouchers);
      setAdvances(nextAdvances);
      setAccounts(nextAccounts);
      setEntries(nextEntries);
      setSales(nextSales);
    });
  }, []);

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
  const accountName = (id?: string) => accountById.get(id ?? "")?.name ?? t("reportsPage.unknownAccount");
  const labourName = (id: string) => labourById.get(id)?.name ?? t("reportsPage.unknownLabour");
  const ledgerGroupTitle = (groupKey: AccountTransactionGroupKey) => ({
    expenses: t("reportsPage.groupExpenses"),
    advances: t("reportsPage.groupAdvances"),
    settlements: t("reportsPage.groupSettlements"),
    income: t("reportsPage.groupIncome"),
    other: t("reportsPage.groupOther"),
  }[groupKey]);
  const partnerLiabilityGroupTitle = (groupKey: PartnerLiabilityLedgerGroupKey) => ({
    capital_injected: t("reportsPage.capitalInjected"),
    direct_expenses_paid: t("reportsPage.directExpensesPaid"),
    transfers_in: t("reportsPage.transfersIn"),
    transfers_out: t("reportsPage.transfersOut"),
    money_returned: t("reportsPage.moneyReturned"),
    adjustments: t("reportsPage.adjustments"),
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
    setCategory("");
    setStatus("");
    setAmountMin("");
    setAmountMax("");
  };

  const filtered = Boolean(search || from || to || accountId || groupFilter || category || status || amountMin || amountMax);
  const switchReport = (next: Report) => {
    setReport(next);
    setSearchParams((current) => {
      current.set("report", next);
      return current;
    });
  };
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
    section.classList.add("is-print-target");
    window.print();
  };

  const attendanceRows = attendance
    .filter((item) => {
      const labourer = labourById.get(item.labourerId);
      return matchesGroup(labourer)
        && (!status || item.status === status)
        && matches(item.date, [labourName(item.labourerId), labourer?.group, item.status]);
    })
    .sort((a, b) => a.date.localeCompare(b.date) || labourName(a.labourerId).localeCompare(labourName(b.labourerId)));
  const attendanceSummary = useMemo(() => labourers
    .filter((labourer) => matchesGroup(labourer))
    .map((labourer) => {
      const records = attendanceRows.filter((item) => item.labourerId === labourer.id);
      const present = records.filter((item) => item.status === "present").length;
      const halfDay = records.filter((item) => item.status === "half_day").length;
      const absent = records.filter((item) => item.status === "absent").length;
      const payable = present + halfDay * 0.5;
      return { labourer, records, present, halfDay, absent, payable, wage: payable * labourer.dailyWage };
    })
    .filter((item) => item.records.length > 0), [attendanceRows, labourers]);
  const attendanceDates = useMemo(() => buildDateColumns(from, to, attendanceRows), [attendanceRows, from, to]);

  const advanceRows = useMemo(() => advances
    .filter((item) => {
      const labourer = labourById.get(item.labourerId);
      return matchesGroup(labourer)
        && (!accountId || item.accountId === accountId)
        && matches(item.date, [labourName(item.labourerId), labourer?.group, accountName(item.accountId), item.notes, item.sourceAccountName], item.amount);
    })
    .sort((a, b) => advanceSort === "desc" ? b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt) : a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt)), [accountId, accountName, advanceSort, advances, labourById, labourName, matches]);
  const advanceSummary = useMemo(() => labourers
    .filter((labourer) => matchesGroup(labourer))
    .map((labourer) => {
      const records = advanceRows.filter((item) => item.labourerId === labourer.id);
      const total = records.reduce((sum, item) => sum + item.amount, 0);
      const payable = attendanceSummary.find((item) => item.labourer.id === labourer.id)?.wage ?? 0;
      return { labourer, records, total, outstanding: payable - total };
    })
    .filter((item) => item.records.length > 0), [advanceRows, attendanceSummary, labourers]);

  const voucherRows = useMemo(() => vouchers
    .filter((item) => (!accountId || item.accountId === accountId)
      && (!category || item.category === category)
      && matches(item.date, [item.voucherNumber, item.category, item.subcategory, item.description, item.notes, accountName(item.accountId)], item.amount))
    .sort((a, b) => expenseSort === "desc" ? b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt) : a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt)), [accountId, accountName, category, expenseSort, matches, vouchers]);
  const voucherCategories = [...new Set(vouchers.map((item) => item.category).filter(Boolean))].sort();

  const partnerRows = entries
    .filter((item) => !item.deletedAt
      && (!accountId || item.accountId === accountId || item.fromAccountId === accountId || item.toAccountId === accountId)
      && matches(item.date, [item.partnerName, item.fromPartner, item.toPartner, item.type, item.notes], item.amount))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const saleRows = sales
    .filter((item) => (!accountId || item.accountId === accountId)
      && matches(item.date, [item.buyerName, saleProduceLabel(item), item.dispatchDate, item.vehicleNumber, accountName(item.accountId)], item.amount))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));

  const positions = useMemo(() => accounts
    .filter((account) => !accountId || account.id === accountId)
    .map((account) => {
      const voucherExpenses = voucherRows.filter((item) => item.accountId === account.id).reduce((sum, item) => sum + item.amount, 0);
      const labourAdvances = advanceRows.filter((item) => item.accountId === account.id).reduce((sum, item) => sum + item.amount, 0);
      const contributions = partnerRows.filter((item) => item.type === "contribution" && item.accountId === account.id).reduce((sum, item) => sum + item.amount, 0);
      const withdrawals = partnerRows.filter((item) => item.type === "withdrawal" && item.accountId === account.id).reduce((sum, item) => sum + item.amount, 0);
      const settlementsSent = partnerRows.filter((item) => item.type === "settlement" && item.fromAccountId === account.id).reduce((sum, item) => sum + item.amount, 0);
      const settlementsReceived = partnerRows.filter((item) => item.type === "settlement" && item.toAccountId === account.id).reduce((sum, item) => sum + item.amount, 0);
      const salesReceived = saleRows.filter((item) => item.accountId === account.id).reduce((sum, item) => sum + item.amount, 0);
      return {
        account,
        voucherExpenses,
        labourAdvances,
        contributions,
        withdrawals,
        settlementsSent,
        settlementsReceived,
        salesReceived,
        net: calculateAccountBalance(account, saleRows, voucherRows, advanceRows, partnerRows),
      };
    }), [accountId, accounts, advanceRows, partnerRows, saleRows, voucherRows]);
  const partnerLiabilityPositions = useMemo(
    () => buildPartnerLiabilityPositions(accounts, voucherRows, advanceRows, partnerRows, saleRows)
      .filter((item) => !accountId || item.account?.id === accountId),
    [accountId, accounts, voucherRows, advanceRows, partnerRows, saleRows],
  );
  const selectedAccountRecord = accountId ? accounts.find((item) => item.id === accountId) ?? null : null;

  const accountLedgerRows = useMemo(() => {
    const rows: Array<Omit<AccountLedgerReportRow, "running">> = [];
    for (const voucher of voucherRows) {
      const account = accountById.get(voucher.accountId);
      const isPartner = account?.type === "partner";
      rows.push({ id: `voucher:${voucher.id}`, date: voucher.date, accountId: voucher.accountId, accountName: accountName(voucher.accountId), type: "voucher", typeLabel: t("reportsPage.voucherExpense"), reference: voucher.voucherNumber, description: voucher.description, debit: isPartner ? 0 : voucher.amount, credit: isPartner ? voucher.amount : 0, path: `/workspace/expenses?recordId=${voucher.id}`, classification: "voucher", partnerLiabilityGroup: isPartner ? "direct_expenses_paid" : undefined });
    }
    for (const advance of advanceRows) {
      const account = accountById.get(advance.accountId ?? "");
      const isPartner = account?.type === "partner";
      rows.push({ id: `advance:${advance.id}`, date: advance.date, accountId: advance.accountId ?? "", accountName: accountName(advance.accountId), type: "advance", typeLabel: t("reportsPage.labourAdvance"), reference: advance.id.slice(0, 8), description: `${labourName(advance.labourerId)}${advance.notes ? ` - ${advance.notes}` : ""}`, debit: isPartner ? 0 : advance.amount, credit: isPartner ? advance.amount : 0, path: `/workspace/labour-advances?recordId=${advance.id}`, classification: "advance", partnerLiabilityGroup: isPartner ? "direct_expenses_paid" : undefined });
    }
    for (const sale of saleRows) rows.push({
      id: `sale:${sale.id}`,
      date: sale.date,
      accountId: sale.accountId,
      accountName: accountName(sale.accountId),
      type: accountById.get(sale.accountId)?.type === "partner" ? "adjustment" : "sale",
      typeLabel: accountById.get(sale.accountId)?.type === "partner" ? t("reportsPage.adjustment") : t("reportsPage.sale"),
      reference: sale.dispatchDate ? `DSP ${sale.dispatchDate}` : sale.id.slice(0, 8),
      description: `${sale.buyerName} - ${saleProduceLabel(sale)}${sale.vehicleNumber ? ` - ${sale.vehicleNumber}` : ""}`,
      debit: accountById.get(sale.accountId)?.type === "partner" ? sale.amount : 0,
      credit: accountById.get(sale.accountId)?.type === "partner" ? 0 : sale.amount,
      path: `/workspace/sales?recordId=${sale.id}`,
      classification: accountById.get(sale.accountId)?.type === "partner" ? "adjustment" : "sale",
      partnerLiabilityGroup: accountById.get(sale.accountId)?.type === "partner" ? "adjustments" : undefined,
    });
    for (const entry of partnerRows) {
      if (entry.type === "contribution" || entry.type === "withdrawal") {
        const partnerAccountId = resolvePartnerAccountId(entry, accounts);
        const partnerAccount = partnerAccountId ? accountById.get(partnerAccountId) : null;
        if (partnerAccountId) {
          rows.push({ id: `partner:${entry.id}:partner`, date: entry.date, accountId: partnerAccountId, accountName: accountName(partnerAccountId), type: entry.type, typeLabel: entry.type === "contribution" ? t("reportsPage.capitalInjected") : t("reportsPage.moneyReturned"), reference: entry.id.slice(0, 8), description: `${entry.partnerName ?? accountName(partnerAccountId)}${entry.notes ? ` - ${entry.notes}` : ""}`, debit: entry.type === "withdrawal" ? entry.amount : 0, credit: entry.type === "contribution" ? entry.amount : 0, path: `/workspace/partner-ledger?recordId=${entry.id}`, classification: entry.type, counterparty: accountName(entry.accountId), partnerLiabilityGroup: entry.type === "contribution" ? "capital_injected" : "money_returned" });
        }
        if (entry.accountId && accountById.get(entry.accountId)?.type !== "partner") {
          rows.push({ id: `partner:${entry.id}:cash`, date: entry.date, accountId: entry.accountId, accountName: accountName(entry.accountId), type: entry.type, typeLabel: entry.type === "contribution" ? t("reportsPage.contribution") : t("reportsPage.withdrawal"), reference: entry.id.slice(0, 8), description: `${entry.partnerName ?? partnerAccount?.name ?? "-"}${entry.notes ? ` - ${entry.notes}` : ""}`, debit: entry.type === "withdrawal" ? entry.amount : 0, credit: entry.type === "contribution" ? entry.amount : 0, path: `/workspace/partner-ledger?recordId=${entry.id}`, classification: entry.type });
        }
      }
      if (entry.type === "settlement") {
        rows.push({ id: `settlement:${entry.id}:sent`, date: entry.date, accountId: entry.fromAccountId ?? "", accountName: accountName(entry.fromAccountId), type: "settlement_sent", typeLabel: t("reportsPage.settlementSent"), reference: entry.id.slice(0, 8), description: `${entry.fromPartner ?? "-"} → ${entry.toPartner ?? "-"}`, debit: entry.amount, credit: 0, path: `/workspace/partner-ledger?recordId=${entry.id}`, classification: "settlement_sent", counterparty: entry.toPartner, partnerLiabilityGroup: accountById.get(entry.fromAccountId ?? "")?.type === "partner" ? "transfers_out" : undefined });
        rows.push({ id: `settlement:${entry.id}:received`, date: entry.date, accountId: entry.toAccountId ?? "", accountName: accountName(entry.toAccountId), type: "settlement_received", typeLabel: t("reportsPage.settlementReceived"), reference: entry.id.slice(0, 8), description: `${entry.fromPartner ?? "-"} → ${entry.toPartner ?? "-"}`, debit: 0, credit: entry.amount, path: `/workspace/partner-ledger?recordId=${entry.id}`, classification: "settlement_received", counterparty: entry.fromPartner, partnerLiabilityGroup: accountById.get(entry.toAccountId ?? "")?.type === "partner" ? "transfers_in" : undefined });
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
  }, [accountId, accountName, advanceRows, labourName, partnerRows, saleRows, t, voucherRows]);
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
    for (const group of groupedPartnerLedgerRows) {
      if (group.groupKey === "capital_injected") summary.capitalInjected += group.totalAmount;
      if (group.groupKey === "direct_expenses_paid") summary.directExpensesPaid += group.totalAmount;
      if (group.groupKey === "transfers_in") summary.transfersIn += group.totalAmount;
      if (group.groupKey === "transfers_out") summary.transfersOut += -group.totalAmount;
      if (group.groupKey === "money_returned") summary.moneyReturned += -group.totalAmount;
      if (group.groupKey === "adjustments") summary.adjustments += group.totalAmount;
    }
    return {
      ...summary,
      netBalance: summary.capitalInjected + summary.directExpensesPaid + summary.transfersIn - summary.transfersOut - summary.moneyReturned + summary.adjustments,
    };
  }, [groupedPartnerLedgerRows, selectedAccountRecord]);
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
  const partnerAccountLedgerSummaryView = isPartnerLedgerReport
    ? accountLedgerSummary as {
        capitalInjected: number;
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
      ["Labour Name", ...attendanceDates.map(formatShortDate), "Total Days", "Wage Rate", "Gross Wages"],
      ...attendanceSummary.map((item) => [
        item.labourer.name,
        ...attendanceDates.map((date) => attendanceMark(item.records.find((record) => record.date === date)?.status)),
        formatNumber(item.payable),
        item.labourer.dailyWage,
        item.wage,
      ]),
    ];
    downloadCsv("attendance-register.csv", rows);
  };
  const exportAttendanceSummary = () => downloadCsv("attendance-summary.csv", [
    [t("reportsPage.labour"), t("reportsPage.present"), t("reportsPage.halfDay"), t("reportsPage.absent"), t("reportsPage.payableDays"), t("reportsPage.totalWages")],
    ...attendanceSummary.map((item) => [item.labourer.name, item.present, item.halfDay, item.absent, formatNumber(item.payable), item.wage]),
  ]);
  const exportAdvanceSummary = () => downloadCsv("labour-advances-summary.csv", [
    [t("reportsPage.labour"), t("reportsPage.transactions"), t("reportsPage.total"), t("reportsPage.netBalance")],
    ...advanceSummary.map((item) => [item.labourer.name, item.records.length, item.total, item.outstanding]),
  ]);
  const exportAdvanceLog = () => downloadCsv("labour-advances-log.csv", [
    [t("reportsPage.date"), t("reportsPage.labour"), t("reportsPage.amount"), t("reportsPage.account"), t("reportsPage.description"), t("reportsPage.reference")],
    ...advanceRows.map((item) => [item.date, labourName(item.labourerId), item.amount, accountName(item.accountId), item.notes || "-", item.id.slice(0, 8)]),
  ]);
  const exportExpenseSummary = () => {
    const categoryTotals = [...new Set(voucherRows.map((item) => item.category))].map((name) => [name, voucherRows.filter((item) => item.category === name).reduce((sum, item) => sum + item.amount, 0)]);
    const accountTotals = [...new Set(voucherRows.map((item) => accountName(item.accountId)))].map((name) => [name, voucherRows.filter((item) => accountName(item.accountId) === name).reduce((sum, item) => sum + item.amount, 0)]);
    downloadCsv("expense-summary.csv", [
      ["Date Range", rangeLabel],
      [],
      ["Category", "Total"],
      ...categoryTotals,
      [],
      ["Account", "Total"],
      ...accountTotals,
      [],
      ["Total", voucherRows.reduce((sum, item) => sum + item.amount, 0)],
    ]);
  };
  const exportExpenseLog = () => downloadCsv("expense-log.csv", [
    [t("reportsPage.voucher"), t("reportsPage.date"), t("reportsPage.description"), t("reportsPage.category"), t("reportsPage.account"), t("reportsPage.amount")],
    ...voucherRows.map((item) => [item.voucherNumber, item.date, item.description, `${item.category} / ${item.subcategory}`, accountName(item.accountId), item.amount]),
  ]);
  const exportPartnerPosition = () => downloadCsv("partner-position.csv", [
    [t("reportsPage.partner"), t("reportsPage.openingBalance"), t("reportsPage.capitalInjected"), t("reportsPage.directExpensesPaid"), t("reportsPage.transfersIn"), t("reportsPage.transfersOut"), t("reportsPage.moneyReturned"), t("reportsPage.adjustments"), t("reportsPage.currentPartnerBalance")],
    ...partnerLiabilityPositions.map((item) => [item.name, item.openingBalance, item.capitalInjected, item.directExpensesPaid, item.transfersIn, item.transfersOut, item.moneyReturned, item.adjustments, item.currentPartnerBalance]),
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
      rows.push([selectedAccountRecord?.type === "partner" ? partnerLiabilityGroupTitle(group.groupKey as PartnerLiabilityLedgerGroupKey) : ledgerGroupTitle(group.groupKey as AccountTransactionGroupKey), group.totalAmount, t("reportsPage.transactions"), group.count]);
      rows.push([t("reportsPage.date"), t("reportsPage.account"), t("reportsPage.type"), t("reportsPage.reference"), t("reportsPage.description"), t("reportsPage.debit"), t("reportsPage.credit"), t("reportsPage.runningBalance")]);
      rows.push(...group.transactions.map((item) => [item.date, item.accountName, item.typeLabel, item.reference, item.description, item.debit, item.credit, item.running]));
      rows.push([]);
    }
    downloadCsv("account-ledger.csv", rows);
  };

  return <div className="dashboard-page">
    <SubpageHeader title={t("reportsPage.title")} />
    <main className="subpage module-workspace reports-page">
      <section className="record-panel reports-tabs" aria-label={t("reportsPage.title")}>
        {reportOptions.map((item) => <button className={report === item ? "is-active" : ""} type="button" key={item} onClick={() => switchReport(item)}>{t(`reportsPage.tabs.${item}`)}</button>)}
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
                  ? `${t("reportsPage.labour")} / ${t("reportsPage.group")} / ${t("reportsPage.notes")}`
                  : t("reportsPage.searchPlaceholder")
            }
          />
          <input aria-label={t("reportsPage.fromDate")} type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          <input aria-label={t("reportsPage.toDate")} type="date" value={to} onChange={(event) => setTo(event.target.value)} />

          {report === "attendance" && <>
            <select aria-label={t("reportsPage.group")} value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}>
              <option value="">{t("reportsPage.allGroups")}</option>
              {labourGroups.map((group) => <option key={group} value={group}>{group}</option>)}
              <option value={ungroupedValue}>{t("reportsPage.ungrouped")}</option>
            </select>
            {views.attendance === "summary" && <select aria-label={t("reportsPage.status")} value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">{t("reportsPage.allStatuses")}</option>
              <option value="present">{t("reportsPage.present")}</option>
              <option value="half_day">{t("reportsPage.halfDay")}</option>
              <option value="absent">{t("reportsPage.absent")}</option>
            </select>}
          </>}

          {report === "advances" && <>
            <select aria-label={t("reportsPage.group")} value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}>
              <option value="">{t("reportsPage.allGroups")}</option>
              {labourGroups.map((group) => <option key={group} value={group}>{group}</option>)}
              <option value={ungroupedValue}>{t("reportsPage.ungrouped")}</option>
            </select>
            <select aria-label={t("reportsPage.account")} value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              <option value="">{t("reportsPage.allAccounts")}</option>
              {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
            </select>
            {views.advances === "log" && <select aria-label="Advance sort" value={advanceSort} onChange={(event) => setAdvanceSort(event.target.value as SortOrder)}>
              <option value="desc">{t("advancesPage.newestFirst")}</option>
              <option value="asc">{t("advancesPage.oldestFirst")}</option>
            </select>}
            <input aria-label={t("reportsPage.minimumAmount")} inputMode="decimal" placeholder={t("reportsPage.minimumAmount")} value={amountMin} onChange={(event) => setAmountMin(event.target.value)} />
            <input aria-label={t("reportsPage.maximumAmount")} inputMode="decimal" placeholder={t("reportsPage.maximumAmount")} value={amountMax} onChange={(event) => setAmountMax(event.target.value)} />
          </>}

          {report === "expenditures" && <>
            <select aria-label={t("reportsPage.account")} value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              <option value="">{t("reportsPage.allAccounts")}</option>
              {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
            </select>
            <select aria-label={t("reportsPage.category")} value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="">{t("reportsPage.allCategories")}</option>
              {voucherCategories.map((item) => <option key={item}>{item}</option>)}
            </select>
            {views.expenditures === "log" && <select aria-label="Expense sort" value={expenseSort} onChange={(event) => setExpenseSort(event.target.value as SortOrder)}>
              <option value="desc">{t("advancesPage.newestFirst")}</option>
              <option value="asc">{t("advancesPage.oldestFirst")}</option>
            </select>}
            <input aria-label={t("reportsPage.minimumAmount")} inputMode="decimal" placeholder={t("reportsPage.minimumAmount")} value={amountMin} onChange={(event) => setAmountMin(event.target.value)} />
            <input aria-label={t("reportsPage.maximumAmount")} inputMode="decimal" placeholder={t("reportsPage.maximumAmount")} value={amountMax} onChange={(event) => setAmountMax(event.target.value)} />
          </>}

          {report === "partner-position" && <>
            <select aria-label={t("reportsPage.partner")} value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              <option value="">{t("reportsPage.allAccounts")}</option>
              {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
            </select>
            <input aria-label={t("reportsPage.minimumAmount")} inputMode="decimal" placeholder={t("reportsPage.minimumAmount")} value={amountMin} onChange={(event) => setAmountMin(event.target.value)} />
            <input aria-label={t("reportsPage.maximumAmount")} inputMode="decimal" placeholder={t("reportsPage.maximumAmount")} value={amountMax} onChange={(event) => setAmountMax(event.target.value)} />
          </>}

          {report === "account-ledger" && <>
            <select aria-label={t("reportsPage.account")} value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              <option value="">{t("reportsPage.allAccounts")}</option>
              {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
            </select>
            <input aria-label={t("reportsPage.minimumAmount")} inputMode="decimal" placeholder={t("reportsPage.minimumAmount")} value={amountMin} onChange={(event) => setAmountMin(event.target.value)} />
            <input aria-label={t("reportsPage.maximumAmount")} inputMode="decimal" placeholder={t("reportsPage.maximumAmount")} value={amountMax} onChange={(event) => setAmountMax(event.target.value)} />
          </>}
        </div>
      </section>

      {report === "attendance" && <>
        <section className="record-panel reports-subtabs">
          <button className={views.attendance === "register" ? "is-active" : ""} type="button" onClick={() => switchView("attendance", "register")}>Register</button>
          <button className={views.attendance === "summary" ? "is-active" : ""} type="button" onClick={() => switchView("attendance", "summary")}>Summary</button>
        </section>
        {views.attendance === "register" && <ReportShell title="Attendance Register" rangeLabel={rangeLabel} sectionId="attendance-register" onPrint={() => printSection("attendance-register-print")} onExport={exportAttendanceRegister}>
          <Kpis values={[[t("reportsPage.labour"), attendanceSummary.length], [t("reportsPage.present"), attendanceRows.filter((item) => item.status === "present").length], [t("reportsPage.halfDay"), attendanceRows.filter((item) => item.status === "half_day").length], [t("reportsPage.absent"), attendanceRows.filter((item) => item.status === "absent").length], [t("reportsPage.totalWages"), money(attendanceSummary.reduce((sum, item) => sum + item.wage, 0))]]} />
          <div className="reports-register-shell">
            <p>{t("reportsPage.registerOnlyPrint")}</p>
            <ul>
              <li>{t("reportsPage.rangeShown", { range: rangeLabel })}</li>
              <li>{t("reportsPage.groupShown", { group: groupFilter === ungroupedValue ? t("reportsPage.ungrouped") : groupFilter || t("reportsPage.allGroups") })}</li>
              <li>{t("reportsPage.labourCountShown", { count: attendanceSummary.length })}</li>
            </ul>
          </div>
        </ReportShell>}
        <section className="record-panel reports-print-section reports-print-only" data-print-section="attendance-register-print" aria-hidden="true">
          <header className="reports-view-header">
            <div>
              <h2>Attendance Register</h2>
              <p>{rangeLabel}</p>
            </div>
          </header>
          <div className="attendance-import-table-wrap report-wide-table">
            <table className="report-data-table attendance-register-report">
              <thead>
                <tr>
                  <th>{t("reportsPage.labour")}</th>
                  {attendanceDates.map((date) => <th key={date}>{formatShortDate(date)}</th>)}
                  <th>{t("reportsPage.payableDays")}</th>
                  <th>Wage Rate</th>
                  <th>{t("reportsPage.totalWages")}</th>
                </tr>
              </thead>
              <tbody>
                {attendanceSummary.map((item) => <tr key={item.labourer.id}>
                  <th>{item.labourer.name}</th>
                  {attendanceDates.map((date) => <td key={date}>{attendanceMark(item.records.find((record) => record.date === date)?.status)}</td>)}
                  <td>{formatNumber(item.payable)}</td>
                  <td>{money(item.labourer.dailyWage)}</td>
                  <td>{money(item.wage)}</td>
                </tr>)}
              </tbody>
            </table>
          </div>
        </section>
        {views.attendance === "summary" && <ReportShell title={t("reportsPage.attendanceSummary")} rangeLabel={rangeLabel} sectionId="attendance-summary" onPrint={() => printSection("attendance-summary")} onExport={exportAttendanceSummary}>
          <Kpis values={[[t("reportsPage.labour"), attendanceSummary.length], [t("reportsPage.present"), attendanceRows.filter((item) => item.status === "present").length], [t("reportsPage.halfDay"), attendanceRows.filter((item) => item.status === "half_day").length], [t("reportsPage.absent"), attendanceRows.filter((item) => item.status === "absent").length], [t("reportsPage.totalWages"), money(attendanceSummary.reduce((sum, item) => sum + item.wage, 0))]]} />
          <ReportTable empty={t("reportsPage.noRecords")} columns={[t("reportsPage.labour"), t("reportsPage.present"), t("reportsPage.halfDay"), t("reportsPage.absent"), t("reportsPage.payableDays"), t("reportsPage.totalWages")]} rows={attendanceSummary.map((item) => ({ id: item.labourer.id, title: item.labourer.name, value: money(item.wage), meta: `${t("reportsPage.payableDays")}: ${formatNumber(item.payable)}`, cells: [item.labourer.name, item.present, item.halfDay, item.absent, formatNumber(item.payable), money(item.wage)], details: [[t("reportsPage.present"), item.present], [t("reportsPage.halfDay"), item.halfDay], [t("reportsPage.absent"), item.absent]] }))} />
        </ReportShell>}
      </>}

      {report === "advances" && <>
        <section className="record-panel reports-subtabs">
          <button className={views.advances === "summary" ? "is-active" : ""} type="button" onClick={() => switchView("advances", "summary")}>Summary</button>
          <button className={views.advances === "log" ? "is-active" : ""} type="button" onClick={() => switchView("advances", "log")}>Log</button>
        </section>
        {views.advances === "summary" && <ReportShell title={t("reportsPage.advanceSummary")} rangeLabel={rangeLabel} sectionId="advance-summary" onPrint={() => printSection("advance-summary")} onExport={exportAdvanceSummary}>
          <Kpis values={[[t("reportsPage.totalAdvances"), money(advanceRows.reduce((sum, item) => sum + item.amount, 0))], [t("reportsPage.transactions"), advanceRows.length], [t("reportsPage.labour"), advanceSummary.length]]} />
          <ReportTable empty={t("reportsPage.noRecords")} columns={[t("reportsPage.labour"), t("reportsPage.transactions"), t("reportsPage.total"), t("reportsPage.netBalance")]} rows={advanceSummary.map((item) => ({ id: item.labourer.id, title: item.labourer.name, value: money(item.total), meta: `${item.records.length} ${t("reportsPage.transactions")}`, cells: [item.labourer.name, item.records.length, money(item.total), money(item.outstanding)], details: [[t("reportsPage.account"), [...new Set(item.records.map((record) => accountName(record.accountId)))].join(", ")], [t("reportsPage.status"), item.labourer.active === false ? t("reportsPage.inactive") : t("reportsPage.active")]] }))} />
        </ReportShell>}
        {views.advances === "log" && <ReportShell title={t("reportsPage.advanceLog")} rangeLabel={rangeLabel} sectionId="advance-log" onPrint={() => printSection("advance-log")} onExport={exportAdvanceLog}>
          <ReportTable empty={t("reportsPage.noRecords")} columns={[t("reportsPage.date"), t("reportsPage.labour"), t("reportsPage.amount"), t("reportsPage.account"), t("reportsPage.description"), t("reportsPage.reference")]} rows={advanceRows.map((item) => ({ id: item.id, title: labourName(item.labourerId), value: money(item.amount), meta: item.date, cells: [item.date, labourName(item.labourerId), money(item.amount), accountName(item.accountId), item.notes || "-", item.id.slice(0, 8)], details: [[t("reportsPage.account"), accountName(item.accountId)], [t("reportsPage.notes"), item.notes || "-"]], onOpen: () => navigate(`/workspace/labour-advances?recordId=${item.id}`) }))} />
        </ReportShell>}
      </>}

      {report === "expenditures" && <>
        <section className="record-panel reports-subtabs">
          <button className={views.expenditures === "summary" ? "is-active" : ""} type="button" onClick={() => switchView("expenditures", "summary")}>Summary</button>
          <button className={views.expenditures === "log" ? "is-active" : ""} type="button" onClick={() => switchView("expenditures", "log")}>Log</button>
        </section>
        {views.expenditures === "summary" && <ReportShell title={t("reportsPage.expenseSummary")} rangeLabel={rangeLabel} sectionId="expense-summary" onPrint={() => printSection("expense-summary")} onExport={exportExpenseSummary}>
          <Kpis values={[[t("reportsPage.totalExpenses"), money(voucherRows.reduce((sum, item) => sum + item.amount, 0))], [t("reportsPage.vouchers"), new Set(voucherRows.map((item) => item.voucherNumber)).size], [t("reportsPage.categories"), new Set(voucherRows.map((item) => item.category)).size], [t("reportsPage.account"), new Set(voucherRows.map((item) => item.accountId)).size]]} />
          <div className="reports-breakdowns">
            <div>
              <h3>{t("reportsPage.byCategory")}</h3>
              <div className="reports-summary-list">
                {[...new Set(voucherRows.map((item) => item.category))].map((name) => <article key={name}><span>{name}</span><strong>{money(voucherRows.filter((item) => item.category === name).reduce((sum, item) => sum + item.amount, 0))}</strong></article>)}
              </div>
            </div>
            <div>
              <h3>{t("reportsPage.byAccount")}</h3>
              <div className="reports-summary-list">
                {[...new Set(voucherRows.map((item) => accountName(item.accountId)))].map((name) => <article key={name}><span>{name}</span><strong>{money(voucherRows.filter((item) => accountName(item.accountId) === name).reduce((sum, item) => sum + item.amount, 0))}</strong></article>)}
              </div>
            </div>
          </div>
        </ReportShell>}
        {views.expenditures === "log" && <ReportShell title={t("reportsPage.expenseLog")} rangeLabel={rangeLabel} sectionId="expense-log" onPrint={() => printSection("expense-log")} onExport={exportExpenseLog}>
          <ReportTable empty={t("reportsPage.noRecords")} columns={[t("reportsPage.voucher"), t("reportsPage.date"), t("reportsPage.description"), t("reportsPage.category"), t("reportsPage.account"), t("reportsPage.amount")]} rows={voucherRows.map((item) => ({ id: item.id, title: item.voucherNumber, value: money(item.amount), meta: item.date, cells: [item.voucherNumber, item.date, item.description, `${item.category} / ${item.subcategory}`, accountName(item.accountId), money(item.amount)], details: [[t("reportsPage.category"), `${item.category} / ${item.subcategory}`], [t("reportsPage.account"), accountName(item.accountId)]], onOpen: () => navigate(`/workspace/expenses?recordId=${item.id}`) }))} />
        </ReportShell>}
      </>}

      {report === "partner-position" && <>
        <section className="record-panel reports-subtabs">
          <button className={views["partner-position"] === "position" ? "is-active" : ""} type="button" onClick={() => switchView("partner-position", "position")}>Position</button>
          <button className={views["partner-position"] === "ledger" ? "is-active" : ""} type="button" onClick={() => switchView("partner-position", "ledger")}>Ledger</button>
        </section>
        {views["partner-position"] === "position" && <ReportShell title={t("reportsPage.partnerPositionTitle")} rangeLabel={rangeLabel} sectionId="partner-position" onPrint={() => printSection("partner-position")} onExport={exportPartnerPosition}>
          <ReportTable empty={t("reportsPage.noRecords")} columns={[t("reportsPage.partner"), t("reportsPage.capitalInjected"), t("reportsPage.directExpensesPaid"), t("reportsPage.transfersIn"), t("reportsPage.transfersOut"), t("reportsPage.moneyReturned"), t("reportsPage.currentPartnerBalance")]} rows={partnerLiabilityPositions.map((item) => ({ id: item.key, title: item.name, value: money(item.currentPartnerBalance), cells: [item.name, money(item.capitalInjected), money(item.directExpensesPaid), money(item.transfersIn), money(item.transfersOut), money(item.moneyReturned), money(item.currentPartnerBalance)], details: [[t("reportsPage.openingBalance"), money(item.openingBalance)], [t("reportsPage.adjustments"), money(item.adjustments)], [t("reportsPage.directVoucherExpensesPaid"), money(item.directVoucherExpensesPaid)], [t("reportsPage.directLabourAdvancesPaid"), money(item.directLabourAdvancesPaid)]] }))} />
        </ReportShell>}
        {views["partner-position"] === "ledger" && <ReportShell title={t("reportsPage.partnerLedger")} rangeLabel={rangeLabel} sectionId="partner-ledger" onPrint={() => printSection("partner-ledger")} onExport={exportPartnerLedger}>
          <ReportTable empty={t("reportsPage.noRecords")} columns={[t("reportsPage.date"), t("reportsPage.partner"), t("reportsPage.type"), t("reportsPage.amount"), t("reportsPage.notes")]} rows={partnerRows.map((item) => ({ id: item.id, title: item.partnerName ?? `${item.fromPartner ?? "-"} → ${item.toPartner ?? "-"}`, value: money(item.amount), meta: item.date, cells: [item.date, item.partnerName ?? `${item.fromPartner ?? "-"} → ${item.toPartner ?? "-"}`, item.type, money(item.amount), item.notes || "-"], details: [[t("reportsPage.type"), item.type], [t("reportsPage.notes"), item.notes || "-"]], onOpen: () => navigate(`/workspace/partner-ledger?recordId=${item.id}`) }))} />
        </ReportShell>}
      </>}

      {report === "account-ledger" && <>
        <section className="record-panel reports-subtabs">
          <button className={views["account-ledger"] === "balances" ? "is-active" : ""} type="button" onClick={() => switchView("account-ledger", "balances")}>Balances</button>
          <button className={views["account-ledger"] === "ledger" ? "is-active" : ""} type="button" onClick={() => switchView("account-ledger", "ledger")}>Ledger</button>
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
          <Kpis values={[
            [t("reportsPage.account"), selectedAccountRecord?.name ?? t("reportsPage.allAccounts")],
            [isPartnerLedgerReport ? t("reportsPage.currentPartnerBalance") : t("reportsPage.currentBalance"), money(currentLedgerBalance)],
            ...(isPartnerLedgerReport && partnerAccountLedgerSummaryView
              ? [
                  [t("reportsPage.capitalInjected"), money(partnerAccountLedgerSummaryView.capitalInjected)],
                  [t("reportsPage.directExpensesPaid"), money(partnerAccountLedgerSummaryView.directExpensesPaid)],
                  [t("reportsPage.transfersIn"), money(partnerAccountLedgerSummaryView.transfersIn)],
                  [t("reportsPage.transfersOut"), money(partnerAccountLedgerSummaryView.transfersOut)],
                  [t("reportsPage.moneyReturned"), money(partnerAccountLedgerSummaryView.moneyReturned)],
                  [t("reportsPage.adjustments"), money(partnerAccountLedgerSummaryView.adjustments)],
                  [t("reportsPage.currentPartnerBalance"), money(partnerAccountLedgerSummaryView.netBalance)],
                ] as Array<[string, string]>
              : [
                  [t("reportsPage.voucherExpenses"), money(standardAccountLedgerSummaryView?.expenses ?? 0)],
                  [t("reportsPage.labourAdvance"), money(standardAccountLedgerSummaryView?.advances ?? 0)],
                  [t("reportsPage.settlements"), money(standardAccountLedgerSummaryView?.settlements ?? 0)],
                  [t("reportsPage.incomeFundsSales"), money(standardAccountLedgerSummaryView?.income ?? 0)],
                  [t("reportsPage.netPosition"), money(standardAccountLedgerSummaryView?.netBalance ?? 0)],
                ] as Array<[string, string]>),
          ]} />
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
                  <span className="account-transaction-group__meta"><strong>{money(group.totalAmount)}</strong><small>{t("reportsPage.transactionCount", { count: group.count })}</small></span>
                </button>
                {expanded && <ReportTable empty={t("reportsPage.noRecords")} columns={[t("reportsPage.date"), t("reportsPage.account"), t("reportsPage.type"), t("reportsPage.reference"), t("reportsPage.debit"), t("reportsPage.credit"), t("reportsPage.runningBalance")]} rows={group.transactions.map((item) => ({ id: item.id, title: item.reference, value: item.credit ? `+${money(item.credit)}` : `-${money(item.debit)}`, meta: `${item.date} | ${item.accountName}`, cells: [item.date, item.accountName, item.typeLabel, item.reference, item.debit ? money(item.debit) : "-", item.credit ? money(item.credit) : "-", money(item.running)], details: [[t("reportsPage.description"), item.description], [t("reportsPage.runningBalance"), money(item.running)]], onOpen: () => navigate(item.path) }))} />}
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
                {expanded && <ReportTable empty={t("reportsPage.noRecords")} columns={[t("reportsPage.date"), t("reportsPage.account"), t("reportsPage.type"), t("reportsPage.reference"), t("reportsPage.debit"), t("reportsPage.credit"), t("reportsPage.runningBalance")]} rows={group.transactions.map((item) => ({ id: item.id, title: item.reference, value: item.credit ? `+${money(item.credit)}` : `-${money(item.debit)}`, meta: `${item.date} | ${item.accountName}`, cells: [item.date, item.accountName, item.typeLabel, item.reference, item.debit ? money(item.debit) : "-", item.credit ? money(item.credit) : "-", money(item.running)], details: [[t("reportsPage.description"), item.description], [t("reportsPage.runningBalance"), money(item.running)]], onOpen: () => navigate(item.path) }))} />}
              </section>;
            })}
          </div>)}
        </ReportShell>}
      </>}
    </main>
  </div>;
}
