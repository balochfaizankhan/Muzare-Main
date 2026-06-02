import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { SearchInput } from "../../components/SearchInput";
import { SubpageHeader } from "../../components/SubpageHeader";
import { formatMoney, formatNumber } from "../../lib/format";
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
type ReportRow = {
  id: string;
  cells: ReactNode[];
  details: Array<[string, ReactNode]>;
  title: ReactNode;
  value?: ReactNode;
  meta?: ReactNode;
  onOpen?: () => void;
};

const money = formatMoney;
const reportOptions: Report[] = ["attendance", "advances", "expenditures", "partner-position", "account-ledger"];
const csvCell = (value: unknown) => `"${String(value ?? "").replaceAll("\"", "\"\"")}"`;
const inRange = (date: string, from: string, to: string) => (!from || date >= from) && (!to || date <= to);

function downloadCsv(filename: string, rows: unknown[][]) {
  const href = URL.createObjectURL(new Blob([rows.map((row) => row.map(csvCell).join(",")).join("\n")], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(href);
}

function ReportTable({ columns, empty, rows }: { columns: string[]; empty: string; rows: ReportRow[] }) {
  const { t } = useTranslation();
  if (!rows.length) return <p className="empty-records">{empty}</p>;
  return <>
    <div className="attendance-import-table-wrap report-wide-table">
      <table className="report-data-table">
        <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}<th>{t("reportsPage.actions")}</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.id}>{row.cells.map((cell, index) => <td key={`${row.id}:${index}`}>{cell}</td>)}<td>{row.onOpen && <button type="button" onClick={row.onOpen}>{t("reportsPage.open")}</button>}</td></tr>)}</tbody>
      </table>
    </div>
    <div className="report-mobile-cards">
      {rows.map((row) => <article className="report-mobile-card" key={`mobile:${row.id}`}>
        <header><strong>{row.title}</strong>{row.value && <b>{row.value}</b>}</header>
        {row.meta && <span>{row.meta}</span>}
        <details>
          <summary>{t("reportsPage.viewDetails")}</summary>
          <dl>{row.details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
          {row.onOpen && <button type="button" onClick={row.onOpen}>{t("reportsPage.openSource")}</button>}
        </details>
      </article>)}
    </div>
  </>;
}

function Kpis({ values }: { values: Array<[string, ReactNode]> }) {
  return <div className="reports-kpis">{values.map(([label, value]) => <article key={label}><span>{label}</span><strong>{value}</strong></article>)}</div>;
}

export function Reports() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedReport = searchParams.get("report");
  const normalizedRequestedReport = requestedReport === "combined-expenses" ? "expenditures" : requestedReport as Report | null;
  const [report, setReport] = useState<Report>(normalizedRequestedReport && reportOptions.includes(normalizedRequestedReport) ? normalizedRequestedReport : "attendance");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [accountId, setAccountId] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("");
  const [amountMin, setAmountMin] = useState("");
  const [amountMax, setAmountMax] = useState("");
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
      setLabourers(nextLabourers); setAttendance(nextAttendance); setVouchers(nextVouchers); setAdvances(nextAdvances);
      setAccounts(nextAccounts); setEntries(nextEntries); setSales(nextSales);
    });
  }, []);
  useEffect(() => {
    if (normalizedRequestedReport && reportOptions.includes(normalizedRequestedReport)) setReport(normalizedRequestedReport);
  }, [normalizedRequestedReport]);

  const term = search.trim().toLowerCase();
  const min = amountMin ? Number(amountMin) : null;
  const max = amountMax ? Number(amountMax) : null;
  const labourById = useMemo(() => new Map(labourers.map((labourer) => [labourer.id, labourer])), [labourers]);
  const accountById = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts]);
  const accountName = (id?: string) => accountById.get(id ?? "")?.name ?? t("reportsPage.unknownAccount");
  const labourName = (id: string) => labourById.get(id)?.name ?? t("reportsPage.unknownLabour");
  const matches = (date: string, values: unknown[], amount?: number) => inRange(date, from, to)
    && (min === null || amount === undefined || amount >= min)
    && (max === null || amount === undefined || amount <= max)
    && (!term || values.some((value) => String(value ?? "").toLowerCase().includes(term)));
  const clearFilters = () => { setSearch(""); setFrom(""); setTo(""); setAccountId(""); setCategory(""); setStatus(""); setAmountMin(""); setAmountMax(""); };
  const filtered = Boolean(search || from || to || accountId || category || status || amountMin || amountMax);
  const switchReport = (next: Report) => {
    setReport(next);
    setSearchParams((current) => { current.set("report", next); return current; });
  };

  const attendanceRows = attendance.filter((item) => (!status || item.status === status)
    && matches(item.date, [labourName(item.labourerId), item.status]));
  const attendanceSummary = useMemo(() => labourers.map((labourer) => {
    const records = attendanceRows.filter((item) => item.labourerId === labourer.id);
    const present = records.filter((item) => item.status === "present").length;
    const halfDay = records.filter((item) => item.status === "half_day").length;
    const absent = records.filter((item) => item.status === "absent").length;
    const payable = present + halfDay * 0.5;
    return { labourer, present, halfDay, absent, payable, wage: payable * labourer.dailyWage };
  }).filter((item) => item.present || item.halfDay || item.absent), [attendanceRows, labourers]);

  const advanceRows = advances.filter((item) => (!accountId || item.accountId === accountId)
    && matches(item.date, [labourName(item.labourerId), accountName(item.accountId), item.notes, item.sourceAccountName], item.amount));
  const advanceSummary = useMemo(() => labourers.map((labourer) => {
    const records = advanceRows.filter((item) => item.labourerId === labourer.id);
    return { labourer, records, total: records.reduce((sum, item) => sum + item.amount, 0), lastDate: records.map((item) => item.date).sort().at(-1) ?? "-" };
  }).filter((item) => item.records.length), [advanceRows, labourers]);

  const voucherRows = vouchers.filter((item) => (!accountId || item.accountId === accountId)
    && (!category || item.category === category)
    && matches(item.date, [item.voucherNumber, item.category, item.subcategory, item.vendor, item.description, item.notes, accountName(item.accountId)], item.amount));
  const categories = [...new Set(vouchers.map((item) => item.category).filter(Boolean))].sort();

  const partnerRows = entries.filter((item) => !item.deletedAt
    && (!accountId || item.accountId === accountId || item.fromAccountId === accountId || item.toAccountId === accountId)
    && matches(item.date, [item.partnerName, item.fromPartner, item.toPartner, item.type, item.notes], item.amount));
  const saleRows = sales.filter((item) => (!accountId || item.accountId === accountId)
    && matches(item.date, [item.buyerName, item.produceType, accountName(item.accountId)], item.amount));
  const positions = useMemo(() => accounts.filter((account) => !accountId || account.id === accountId).map((account) => {
    const voucherExpenses = voucherRows.filter((item) => item.accountId === account.id).reduce((sum, item) => sum + item.amount, 0);
    const labourAdvances = advanceRows.filter((item) => item.accountId === account.id).reduce((sum, item) => sum + item.amount, 0);
    const contributions = partnerRows.filter((item) => item.type === "contribution" && item.accountId === account.id).reduce((sum, item) => sum + item.amount, 0);
    const withdrawals = partnerRows.filter((item) => item.type === "withdrawal" && item.accountId === account.id).reduce((sum, item) => sum + item.amount, 0);
    const settlementsSent = partnerRows.filter((item) => item.type === "settlement" && item.fromAccountId === account.id).reduce((sum, item) => sum + item.amount, 0);
    const settlementsReceived = partnerRows.filter((item) => item.type === "settlement" && item.toAccountId === account.id).reduce((sum, item) => sum + item.amount, 0);
    const salesReceived = saleRows.filter((item) => item.accountId === account.id).reduce((sum, item) => sum + item.amount, 0);
    return { account, voucherExpenses, labourAdvances, contributions, withdrawals, settlementsSent, settlementsReceived, salesReceived, net: salesReceived - voucherExpenses - labourAdvances + contributions - withdrawals - settlementsSent + settlementsReceived };
  }), [accountId, accounts, advanceRows, partnerRows, saleRows, voucherRows]);

  const accountLedgerRows = useMemo(() => {
    const rows: Array<{ id: string; date: string; accountId: string; type: string; reference: string; description: string; debit: number; credit: number; path: string }> = [];
    for (const voucher of voucherRows) rows.push({ id: `voucher:${voucher.id}`, date: voucher.date, accountId: voucher.accountId, type: t("reportsPage.voucherExpense"), reference: voucher.voucherNumber, description: voucher.description, debit: voucher.amount, credit: 0, path: `/workspace/expenses?recordId=${voucher.id}` });
    for (const advance of advanceRows) rows.push({ id: `advance:${advance.id}`, date: advance.date, accountId: advance.accountId ?? "", type: t("reportsPage.labourAdvance"), reference: advance.id.slice(0, 8), description: `${labourName(advance.labourerId)}${advance.notes ? ` - ${advance.notes}` : ""}`, debit: advance.amount, credit: 0, path: `/workspace/labour-advances?recordId=${advance.id}` });
    for (const sale of saleRows) rows.push({ id: `sale:${sale.id}`, date: sale.date, accountId: sale.accountId, type: t("reportsPage.sale"), reference: sale.id.slice(0, 8), description: `${sale.buyerName} - ${sale.produceType}`, debit: 0, credit: sale.amount, path: `/workspace/sales?recordId=${sale.id}` });
    for (const entry of partnerRows) {
      if (entry.type === "contribution" || entry.type === "withdrawal") rows.push({ id: `partner:${entry.id}`, date: entry.date, accountId: entry.accountId ?? "", type: entry.type === "contribution" ? t("reportsPage.contribution") : t("reportsPage.withdrawal"), reference: entry.id.slice(0, 8), description: `${entry.partnerName ?? "-"}${entry.notes ? ` - ${entry.notes}` : ""}`, debit: entry.type === "withdrawal" ? entry.amount : 0, credit: entry.type === "contribution" ? entry.amount : 0, path: `/workspace/partner-ledger?recordId=${entry.id}` });
      if (entry.type === "settlement") {
        rows.push({ id: `settlement:${entry.id}:sent`, date: entry.date, accountId: entry.fromAccountId ?? "", type: t("reportsPage.settlementSent"), reference: entry.id.slice(0, 8), description: `${entry.fromPartner ?? "-"} → ${entry.toPartner ?? "-"}`, debit: entry.amount, credit: 0, path: `/workspace/partner-ledger?recordId=${entry.id}` });
        rows.push({ id: `settlement:${entry.id}:received`, date: entry.date, accountId: entry.toAccountId ?? "", type: t("reportsPage.settlementReceived"), reference: entry.id.slice(0, 8), description: `${entry.fromPartner ?? "-"} → ${entry.toPartner ?? "-"}`, debit: 0, credit: entry.amount, path: `/workspace/partner-ledger?recordId=${entry.id}` });
      }
    }
    const running = new Map<string, number>();
    return rows.filter((item) => !accountId || item.accountId === accountId).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)).map((item) => {
      const next = (running.get(item.accountId) ?? 0) + item.credit - item.debit;
      running.set(item.accountId, next);
      return { ...item, running: next };
    });
  }, [accountId, advanceRows, partnerRows, saleRows, t, voucherRows]);

  const exportCurrent = () => {
    if (report === "attendance") downloadCsv("attendance-report.csv", [[t("reportsPage.date"), t("reportsPage.labour"), t("reportsPage.status")], ...attendanceRows.map((item) => [item.date, labourName(item.labourerId), item.status])]);
    if (report === "advances") downloadCsv("labour-advances-log.csv", [[t("reportsPage.date"), t("reportsPage.labour"), t("reportsPage.amount"), t("reportsPage.account"), t("reportsPage.notes")], ...advanceRows.map((item) => [item.date, labourName(item.labourerId), item.amount, accountName(item.accountId), item.notes])]);
    if (report === "expenditures") downloadCsv("expenditure-report.csv", [[t("reportsPage.date"), t("reportsPage.voucher"), t("reportsPage.category"), t("reportsPage.subcategory"), t("reportsPage.account"), t("reportsPage.vendor"), t("reportsPage.description"), t("reportsPage.amount")], ...voucherRows.map((item) => [item.date, item.voucherNumber, item.category, item.subcategory, accountName(item.accountId), item.vendor ?? "", item.description, item.amount])]);
    if (report === "partner-position") downloadCsv("partner-ledger.csv", [[t("reportsPage.date"), t("reportsPage.partner"), t("reportsPage.type"), t("reportsPage.amount"), t("reportsPage.notes")], ...partnerRows.map((item) => [item.date, item.partnerName ?? `${item.fromPartner ?? "-"} → ${item.toPartner ?? "-"}`, item.type, item.amount, item.notes])]);
    if (report === "account-ledger") downloadCsv("account-ledger.csv", [[t("reportsPage.date"), t("reportsPage.account"), t("reportsPage.type"), t("reportsPage.reference"), t("reportsPage.description"), t("reportsPage.debit"), t("reportsPage.credit"), t("reportsPage.runningBalance")], ...accountLedgerRows.map((item) => [item.date, accountName(item.accountId), item.type, item.reference, item.description, item.debit, item.credit, item.running])]);
  };

  return <div className="dashboard-page"><SubpageHeader title={t("reportsPage.title")} /><main className="subpage module-workspace reports-page">
    <section className="record-panel reports-tabs" aria-label={t("reportsPage.title")}>
      {reportOptions.map((item) => <button className={report === item ? "is-active" : ""} type="button" key={item} onClick={() => switchReport(item)}>{t(`reportsPage.tabs.${item}`)}</button>)}
    </section>
    <section className="record-panel reports-filter-panel">
      <div className="reports-filter-heading"><h2>{t("reportsPage.filters")}</h2>{filtered && <button type="button" onClick={clearFilters}>{t("reportsPage.clearFilters")}</button>}</div>
      <div className="reports-filters">
        <SearchInput value={search} onChange={setSearch} placeholder={t("reportsPage.searchPlaceholder")} />
        <input aria-label={t("reportsPage.fromDate")} type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        <input aria-label={t("reportsPage.toDate")} type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        <select aria-label={t("reportsPage.account")} value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">{t("reportsPage.allAccounts")}</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select>
        {(report === "expenditures") && <select aria-label={t("reportsPage.category")} value={category} onChange={(event) => setCategory(event.target.value)}><option value="">{t("reportsPage.allCategories")}</option>{categories.map((item) => <option key={item}>{item}</option>)}</select>}
        {(report === "attendance") && <select aria-label={t("reportsPage.status")} value={status} onChange={(event) => setStatus(event.target.value)}><option value="">{t("reportsPage.allStatuses")}</option><option value="present">{t("reportsPage.present")}</option><option value="half_day">{t("reportsPage.halfDay")}</option><option value="absent">{t("reportsPage.absent")}</option></select>}
        {(report === "advances" || report === "expenditures" || report === "partner-position" || report === "account-ledger") && <><input aria-label={t("reportsPage.minimumAmount")} inputMode="decimal" placeholder={t("reportsPage.minimumAmount")} value={amountMin} onChange={(event) => setAmountMin(event.target.value)} /><input aria-label={t("reportsPage.maximumAmount")} inputMode="decimal" placeholder={t("reportsPage.maximumAmount")} value={amountMax} onChange={(event) => setAmountMax(event.target.value)} /></>}
      </div>
      <footer className="reports-actions"><button type="button" onClick={exportCurrent}>{t("reportsPage.exportCsv")}</button><button type="button" onClick={() => window.print()}>{t("reportsPage.print")}</button></footer>
    </section>
    {report === "attendance" && <AttendanceReport rows={attendanceRows} summary={attendanceSummary} labourName={labourName} t={t} />}
    {report === "advances" && <AdvanceReport rows={advanceRows} summary={advanceSummary} accountName={accountName} labourName={labourName} navigate={navigate} t={t} />}
    {report === "expenditures" && <ExpenseReport rows={voucherRows} advances={advanceRows} accountName={accountName} labourName={labourName} navigate={navigate} t={t} />}
    {report === "partner-position" && <PartnerReport rows={partnerRows} positions={positions} navigate={navigate} t={t} />}
    {report === "account-ledger" && <AccountReport rows={accountLedgerRows} positions={positions} accountName={accountName} navigate={navigate} t={t} />}
  </main></div>;
}

type Translator = (key: string, options?: Record<string, unknown>) => string;
function AttendanceReport({ rows, summary, labourName, t }: { rows: Attendance[]; summary: Array<{ labourer: Labourer; present: number; halfDay: number; absent: number; payable: number; wage: number }>; labourName: (id: string) => string; t: Translator }) {
  return <section className="record-panel"><h2>{t("reportsPage.attendanceTitle")}</h2>
    <Kpis values={[[t("reportsPage.labour"), summary.length], [t("reportsPage.present"), rows.filter((item) => item.status === "present").length], [t("reportsPage.halfDay"), rows.filter((item) => item.status === "half_day").length], [t("reportsPage.absent"), rows.filter((item) => item.status === "absent").length], [t("reportsPage.totalWages"), money(summary.reduce((sum, item) => sum + item.wage, 0))]]} />
    <h3>{t("reportsPage.attendanceSummary")}</h3>
    <ReportTable empty={t("reportsPage.noRecords")} columns={[t("reportsPage.labour"), t("reportsPage.present"), t("reportsPage.halfDay"), t("reportsPage.absent"), t("reportsPage.payableDays"), t("reportsPage.totalWages")]} rows={summary.map((item) => ({ id: item.labourer.id, title: item.labourer.name, value: money(item.wage), meta: `${t("reportsPage.payableDays")}: ${formatNumber(item.payable)}`, cells: [item.labourer.name, item.present, item.halfDay, item.absent, formatNumber(item.payable), money(item.wage)], details: [[t("reportsPage.present"), item.present], [t("reportsPage.halfDay"), item.halfDay], [t("reportsPage.absent"), item.absent]] }))} />
    <h3>{t("reportsPage.attendanceLog")}</h3>
    <ReportTable empty={t("reportsPage.noRecords")} columns={[t("reportsPage.date"), t("reportsPage.labour"), t("reportsPage.status")]} rows={rows.map((item) => ({ id: item.id, title: labourName(item.labourerId), value: item.status, meta: item.date, cells: [item.date, labourName(item.labourerId), item.status], details: [[t("reportsPage.date"), item.date], [t("reportsPage.status"), item.status]] }))} />
  </section>;
}
function AdvanceReport({ rows, summary, accountName, labourName, navigate, t }: { rows: Advance[]; summary: Array<{ labourer: Labourer; records: Advance[]; total: number; lastDate: string }>; accountName: (id?: string) => string; labourName: (id: string) => string; navigate: (path: string) => void; t: Translator }) {
  return <><section className="record-panel"><h2>{t("reportsPage.advanceSummary")}</h2><Kpis values={[[t("reportsPage.totalAdvances"), money(rows.reduce((sum, item) => sum + item.amount, 0))], [t("reportsPage.transactions"), rows.length], [t("reportsPage.labour"), summary.length]]} /><ReportTable empty={t("reportsPage.noRecords")} columns={[t("reportsPage.labour"), t("reportsPage.transactions"), t("reportsPage.lastAdvanceDate"), t("reportsPage.total")]} rows={summary.map((item) => ({ id: item.labourer.id, title: item.labourer.name, value: money(item.total), meta: item.lastDate, cells: [item.labourer.name, item.records.length, item.lastDate, money(item.total)], details: [[t("reportsPage.transactions"), item.records.length], [t("reportsPage.lastAdvanceDate"), item.lastDate], [t("reportsPage.account"), [...new Set(item.records.map((record) => accountName(record.accountId)))].join(", ")], [t("reportsPage.status"), item.labourer.active === false ? t("reportsPage.inactive") : t("reportsPage.active")]] }))} /></section>
    <section className="record-panel"><h2>{t("reportsPage.advanceLog")}</h2><ReportTable empty={t("reportsPage.noRecords")} columns={[t("reportsPage.date"), t("reportsPage.labour"), t("reportsPage.amount"), t("reportsPage.account"), t("reportsPage.notes")]} rows={rows.map((item) => ({ id: item.id, title: labourName(item.labourerId), value: money(item.amount), meta: item.date, cells: [item.date, labourName(item.labourerId), money(item.amount), accountName(item.accountId), item.notes || "-"], details: [[t("reportsPage.account"), accountName(item.accountId)], [t("reportsPage.notes"), item.notes || "-"]], onOpen: () => navigate(`/workspace/labour-advances?recordId=${item.id}`) }))} /></section></>;
}
function ExpenseReport({ rows, advances, accountName, labourName, navigate, t }: { rows: Voucher[]; advances: Advance[]; accountName: (id?: string) => string; labourName: (id: string) => string; navigate: (path: string) => void; t: Translator }) {
  const groupTotals = (values: Array<[string, number]>) => [...new Set(values.map(([name]) => name || "-"))].map((name) => [name, values.filter(([item]) => (item || "-") === name).reduce((sum, [, amount]) => sum + amount, 0)] as const);
  const categories = groupTotals(rows.map((item) => [item.category, item.amount]));
  const subcategories = groupTotals(rows.map((item) => [item.subcategory, item.amount]));
  const accounts = groupTotals(rows.map((item) => [accountName(item.accountId), item.amount]));
  const vendors = groupTotals(rows.map((item) => [item.vendor || "-", item.amount]));
  const Breakdown = ({ title, values }: { title: string; values: ReadonlyArray<readonly [string, number]> }) => <div><h3>{title}</h3><div className="reports-summary-list">{values.map(([name, total]) => <article key={name}><span>{name}</span><strong>{money(total)}</strong></article>)}</div></div>;
  const voucherTotal = rows.reduce((sum, item) => sum + item.amount, 0);
  const advanceTotal = advances.reduce((sum, item) => sum + item.amount, 0);
  return <><section className="record-panel"><h2>{t("reportsPage.expenseSummary")}</h2><Kpis values={[[t("reportsPage.voucherExpenses"), money(voucherTotal)], [t("reportsPage.labourAdvance"), money(advanceTotal)], [t("reportsPage.totalBusinessExpenses"), money(voucherTotal + advanceTotal)], [t("reportsPage.vouchers"), new Set(rows.map((item) => item.voucherNumber)).size], [t("reportsPage.categories"), categories.length]]} /><div className="reports-breakdowns"><Breakdown title={t("reportsPage.byCategory")} values={categories} /><Breakdown title={t("reportsPage.bySubcategory")} values={subcategories} /><Breakdown title={t("reportsPage.byAccount")} values={accounts} /><Breakdown title={t("reportsPage.byVendor")} values={vendors} /></div></section>
    <section className="record-panel"><h2>{t("reportsPage.expenseLog")}</h2><ReportTable empty={t("reportsPage.noRecords")} columns={[t("reportsPage.date"), t("reportsPage.voucher"), t("reportsPage.category"), t("reportsPage.account"), t("reportsPage.description"), t("reportsPage.amount")]} rows={rows.map((item) => ({ id: item.id, title: item.voucherNumber, value: money(item.amount), meta: item.date, cells: [item.date, item.voucherNumber, `${item.category} / ${item.subcategory}`, accountName(item.accountId), item.description, money(item.amount)], details: [[t("reportsPage.category"), `${item.category} / ${item.subcategory}`], [t("reportsPage.account"), accountName(item.accountId)], [t("reportsPage.vendor"), item.vendor || "-"], [t("reportsPage.description"), item.description]], onOpen: () => navigate(`/workspace/expenses?recordId=${item.id}`) }))} /></section>
    <section className="record-panel"><h2>{t("reportsPage.businessExpenseLog")}</h2><ReportTable empty={t("reportsPage.noRecords")} columns={[t("reportsPage.date"), t("reportsPage.type"), t("reportsPage.reference"), t("reportsPage.account"), t("reportsPage.description"), t("reportsPage.amount")]} rows={[...rows.map((item) => ({ id: `voucher:${item.id}`, title: item.voucherNumber, value: money(item.amount), meta: item.date, cells: [item.date, t("reportsPage.voucherExpense"), item.voucherNumber, accountName(item.accountId), item.description, money(item.amount)], details: [[t("reportsPage.account"), accountName(item.accountId)] as [string, ReactNode]], onOpen: () => navigate(`/workspace/expenses?recordId=${item.id}`) })), ...advances.map((item) => ({ id: `advance:${item.id}`, title: labourName(item.labourerId), value: money(item.amount), meta: item.date, cells: [item.date, t("reportsPage.labourAdvance"), item.id.slice(0, 8), accountName(item.accountId), item.notes || "-", money(item.amount)], details: [[t("reportsPage.account"), accountName(item.accountId)] as [string, ReactNode]], onOpen: () => navigate(`/workspace/labour-advances?recordId=${item.id}`) }))]} /></section></>;
}
function PartnerReport({ rows, positions, navigate, t }: { rows: PartnerEntry[]; positions: Array<{ account: Account; voucherExpenses: number; labourAdvances: number; contributions: number; withdrawals: number; settlementsSent: number; settlementsReceived: number; salesReceived: number; net: number }>; navigate: (path: string) => void; t: Translator }) {
  return <><section className="record-panel"><h2>{t("reportsPage.partnerPositionTitle")}</h2><ReportTable empty={t("reportsPage.noRecords")} columns={[t("reportsPage.partner"), t("reportsPage.voucherExpenses"), t("reportsPage.labourAdvance"), t("reportsPage.contributions"), t("reportsPage.withdrawals"), t("reportsPage.netPosition")]} rows={positions.map((item) => ({ id: item.account.id, title: item.account.name, value: money(item.net), cells: [item.account.name, money(item.voucherExpenses), money(item.labourAdvances), money(item.contributions), money(item.withdrawals), money(item.net)], details: [[t("reportsPage.salesReceived"), money(item.salesReceived)], [t("reportsPage.settlementsSent"), money(item.settlementsSent)], [t("reportsPage.settlementsReceived"), money(item.settlementsReceived)]] }))} /></section>
    <section className="record-panel"><h2>{t("reportsPage.partnerLedger")}</h2><ReportTable empty={t("reportsPage.noRecords")} columns={[t("reportsPage.date"), t("reportsPage.partner"), t("reportsPage.type"), t("reportsPage.amount"), t("reportsPage.notes")]} rows={rows.map((item) => ({ id: item.id, title: item.partnerName ?? `${item.fromPartner ?? "-"} → ${item.toPartner ?? "-"}`, value: money(item.amount), meta: item.date, cells: [item.date, item.partnerName ?? `${item.fromPartner ?? "-"} → ${item.toPartner ?? "-"}`, item.type, money(item.amount), item.notes || "-"], details: [[t("reportsPage.type"), item.type], [t("reportsPage.notes"), item.notes || "-"]], onOpen: () => navigate(`/workspace/partner-ledger?recordId=${item.id}`) }))} /></section></>;
}
function AccountReport({ rows, positions, accountName, navigate, t }: { rows: Array<{ id: string; date: string; accountId: string; type: string; reference: string; description: string; debit: number; credit: number; running: number; path: string }>; positions: Array<{ account: Account; net: number }>; accountName: (id?: string) => string; navigate: (path: string) => void; t: Translator }) {
  const movements = positions.map((item) => {
    const accountRows = rows.filter((row) => row.accountId === item.account.id);
    const debit = accountRows.reduce((sum, row) => sum + row.debit, 0);
    const credit = accountRows.reduce((sum, row) => sum + row.credit, 0);
    return { ...item, debit, credit, closing: credit - debit };
  });
  return <><section className="record-panel"><h2>{t("reportsPage.accountBalances")}</h2><div className="reports-kpis">{positions.map((item) => <article key={item.account.id}><span>{item.account.name}</span><strong>{money(item.net)}</strong></article>)}</div></section>
    <section className="record-panel"><h2>{t("reportsPage.cashBankMovement")}</h2><ReportTable empty={t("reportsPage.noRecords")} columns={[t("reportsPage.account"), t("reportsPage.openingBalance"), t("reportsPage.totalDebit"), t("reportsPage.totalCredit"), t("reportsPage.closingBalance")]} rows={movements.map((item) => ({ id: item.account.id, title: item.account.name, value: money(item.closing), cells: [item.account.name, money(0), money(item.debit), money(item.credit), money(item.closing)], details: [[t("reportsPage.totalDebit"), money(item.debit)], [t("reportsPage.totalCredit"), money(item.credit)]] }))} /></section>
    <section className="record-panel"><h2>{t("reportsPage.accountLedgerTitle")}</h2><ReportTable empty={t("reportsPage.noRecords")} columns={[t("reportsPage.date"), t("reportsPage.account"), t("reportsPage.type"), t("reportsPage.reference"), t("reportsPage.debit"), t("reportsPage.credit"), t("reportsPage.runningBalance")]} rows={rows.map((item) => ({ id: item.id, title: item.reference, value: item.credit ? `+${money(item.credit)}` : `-${money(item.debit)}`, meta: `${item.date} | ${accountName(item.accountId)}`, cells: [item.date, accountName(item.accountId), item.type, item.reference, item.debit ? money(item.debit) : "-", item.credit ? money(item.credit) : "-", money(item.running)], details: [[t("reportsPage.description"), item.description], [t("reportsPage.runningBalance"), money(item.running)]], onOpen: () => navigate(item.path) }))} /></section></>;
}
