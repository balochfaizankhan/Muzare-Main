import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { SubpageHeader } from "../../components/SubpageHeader";
import { SearchInput } from "../../components/SearchInput";
import { formatMoney } from "../../lib/format";
import { offlineDb, workspaceRecords, type Account, type Advance, type PartnerEntry, type Sale, type Voucher } from "../../lib/offline-db";

type Report = "combined-expenses" | "account-ledger" | "partner-position";
const money = formatMoney;

export function Reports() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const [report, setReport] = useState<Report>((searchParams.get("report") as Report) || "combined-expenses");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [accountId, setAccountId] = useState("");
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [advances, setAdvances] = useState<Advance[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [entries, setEntries] = useState<PartnerEntry[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  useEffect(() => {
    void Promise.all([
      workspaceRecords(offlineDb.vouchers, { includeGeneralFarmRecords: true }),
      workspaceRecords(offlineDb.advances),
      workspaceRecords(offlineDb.accounts),
      workspaceRecords(offlineDb.partnerEntries),
      workspaceRecords(offlineDb.sales),
    ]).then(([nextVouchers, nextAdvances, nextAccounts, nextEntries, nextSales]) => {
      setVouchers(nextVouchers); setAdvances(nextAdvances); setAccounts(nextAccounts); setEntries(nextEntries); setSales(nextSales);
    });
  }, []);
  const accountName = (id?: string) => accounts.find((account) => account.id === id)?.name ?? t("reportsPage.unknownAccount");
  const term = search.trim().toLowerCase();
  const match = (date: string, values: string[]) => (!from || date >= from) && (!to || date <= to)
    && (!term || values.some((value) => value.toLowerCase().includes(term)));
  const voucherRows = vouchers.filter((item) => (!accountId || item.accountId === accountId)
    && match(item.date, [item.voucherNumber, item.description, item.category, item.subcategory, accountName(item.accountId), String(item.amount)]));
  const advanceRows = advances.filter((item) => (!accountId || item.accountId === accountId)
    && match(item.date, [item.notes, accountName(item.accountId), String(item.amount)]));
  const filteredEntries = entries.filter((item) => !item.deletedAt
    && (!accountId || item.accountId === accountId || item.fromAccountId === accountId || item.toAccountId === accountId)
    && match(item.date, [item.partnerName ?? "", item.fromPartner ?? "", item.toPartner ?? "", item.notes, String(item.amount)]));
  const filteredSales = sales.filter((item) => (!accountId || item.accountId === accountId)
    && match(item.date, [item.buyerName, item.produceType, accountName(item.accountId), String(item.amount)]));
  const positions = useMemo(() => accounts.filter((account) => !accountId || account.id === accountId).map((account) => {
    const voucherExpenses = voucherRows.filter((item) => item.accountId === account.id).reduce((sum, item) => sum + item.amount, 0);
    const labourAdvances = advanceRows.filter((item) => item.accountId === account.id).reduce((sum, item) => sum + item.amount, 0);
    const contributions = filteredEntries.filter((item) => item.type === "contribution" && item.accountId === account.id).reduce((sum, item) => sum + item.amount, 0);
    const withdrawals = filteredEntries.filter((item) => item.type === "withdrawal" && item.accountId === account.id).reduce((sum, item) => sum + item.amount, 0);
    const settlementsSent = filteredEntries.filter((item) => item.type === "settlement" && item.fromAccountId === account.id).reduce((sum, item) => sum + item.amount, 0);
    const settlementsReceived = filteredEntries.filter((item) => item.type === "settlement" && item.toAccountId === account.id).reduce((sum, item) => sum + item.amount, 0);
    const salesReceived = filteredSales.filter((item) => item.accountId === account.id).reduce((sum, item) => sum + item.amount, 0);
    return { account, voucherExpenses, labourAdvances, contributions, withdrawals, settlementsSent, settlementsReceived, salesReceived, net: salesReceived - voucherExpenses - labourAdvances + contributions - withdrawals - settlementsSent + settlementsReceived };
  }), [accountId, accounts, advanceRows, filteredEntries, filteredSales, voucherRows]);
  const grandTotal = voucherRows.reduce((sum, item) => sum + item.amount, 0) + advanceRows.reduce((sum, item) => sum + item.amount, 0);

  return <div className="dashboard-page"><SubpageHeader title={t("reportsPage.title")} /><main className="subpage module-workspace">
    <section className="record-panel"><h2>{t("reportsPage.accountingReports")}</h2><div className="account-ledger-filters">
      <select value={report} onChange={(event) => setReport(event.target.value as Report)}><option value="combined-expenses">{t("reportsPage.combinedExpenses")}</option><option value="partner-position">{t("reportsPage.partnerPosition")}</option><option value="account-ledger">{t("reportsPage.accountLedger")}</option></select>
      <SearchInput value={search} onChange={setSearch} placeholder={t("reportsPage.searchPlaceholder")} />
      <input aria-label={t("reportsPage.fromDate")} type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
      <input aria-label={t("reportsPage.toDate")} type="date" value={to} onChange={(event) => setTo(event.target.value)} />
      <select value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">{t("reportsPage.allAccounts")}</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select>
    </div></section>
    {report === "combined-expenses" && <section className="record-panel"><h2>{t("reportsPage.combinedExpensesTitle")}</h2><p>{t("reportsPage.combinedExpensesDescription")}</p><strong>{money(grandTotal)}</strong><div className="record-list">{voucherRows.map((item) => <article key={`voucher:${item.id}`}><strong>{item.date} | {item.voucherNumber}</strong><span>{t("reportsPage.voucherExpense")} | {accountName(item.accountId)}</span><span>{item.description}</span><b>{money(item.amount)}</b></article>)}{advanceRows.map((item) => <article key={`advance:${item.id}`}><strong>{item.date}</strong><span>{t("reportsPage.labourAdvance")} | {accountName(item.accountId)}</span><span>{item.notes || "-"}</span><b>{money(item.amount)}</b></article>)}</div></section>}
    {report === "partner-position" && <section className="record-panel"><h2>{t("reportsPage.partnerPositionTitle")}</h2><div className="record-list">{positions.map((item) => <article key={item.account.id}><strong>{item.account.name}</strong><span>{t("reportsPage.voucherExpenses")}: {money(item.voucherExpenses)}</span><span>{t("dashboard.labourAdvances")}: {money(item.labourAdvances)}</span><span>{t("reportsPage.contributions")}: {money(item.contributions)} | {t("reportsPage.withdrawals")}: {money(item.withdrawals)}</span><span>{t("reportsPage.settlementsSent")}: {money(item.settlementsSent)} | {t("reportsPage.settlementsReceived")}: {money(item.settlementsReceived)}</span><b>{t("reportsPage.netPosition")}: {money(item.net)}</b></article>)}</div></section>}
    {report === "account-ledger" && <section className="record-panel"><h2>{t("reportsPage.accountLedgerTitle")}</h2><div className="record-list">{positions.filter((item) => !accountId || item.account.id === accountId).map((item) => <article key={item.account.id}><strong>{item.account.name}</strong><span>{t("reportsPage.salesReceived")}: {money(item.salesReceived)}</span><span>{t("reportsPage.voucherExpenses")}: {money(item.voucherExpenses)}</span><span>{t("dashboard.labourAdvances")}: {money(item.labourAdvances)}</span><span>{t("reportsPage.settlementsSent")}: {money(item.settlementsSent)} | {t("reportsPage.settlementsReceived")}: {money(item.settlementsReceived)}</span><b>{t("reportsPage.netBalance")}: {money(item.net)}</b></article>)}</div></section>}
  </main></div>;
}
