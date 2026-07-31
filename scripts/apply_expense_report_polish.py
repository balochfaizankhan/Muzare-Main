from __future__ import annotations

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
REPORTS = ROOT / "web/src/pages/workspace/Reports.tsx"
MAIN = ROOT / "web/src/main.tsx"
LOCALES = ROOT / "web/src/locales/reportsLocalizationBundle.ts"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one literal match, found {count}")
    return text.replace(old, new, 1)


def replace_regex(text: str, pattern: str, new: str, label: str) -> str:
    updated, count = re.subn(pattern, new, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one regex match, found {count}")
    return updated


reports = REPORTS.read_text(encoding="utf-8")

reports = replace_regex(
    reports,
    r'(type VoucherReportLine = \{.*?\n\};\n)\nconst voucherReportItems',
    r'''\1
type ExpenseReportExportRow = {
  key: string;
  sourceId: string;
  voucherNumber: string;
  date: string;
  lineNumber: number;
  description: string;
  categoryKey: string;
  categoryLabel: string;
  subcategoryKey: string;
  subcategoryLabel: string;
  recordType: string;
  accountName: string;
  expenseAmount: number;
  attributedAmount: number;
  voucherTotal: number;
  recipient: string;
  status: string;
};

const voucherReportItems''',
    "insert expense export type",
)

reports = replace_once(
    reports,
    '''  const openExpenseCategory = (nextCategory: string) => {
    setCategory(nextCategory);
    setSubcategory("");
    switchView("expenditures", "log");
  };
  const openExpenseAccount = (nextAccountId: string) => {''',
    '''  const openExpenseCategory = (nextCategory: string) => {
    setCategory(nextCategory);
    setSubcategory("");
    switchView("expenditures", "log");
  };
  const openExpenseSubcategory = (nextCategory: string, nextSubcategory: string) => {
    setCategory(nextCategory);
    setSubcategory(nextSubcategory);
    switchView("expenditures", "log");
  };
  const openExpenseAccount = (nextAccountId: string) => {''',
    "insert subcategory drilldown",
)

reports = replace_once(
    reports,
    '''  const totalRecognizedExpenses = voucherRows.reduce((sum, item) => sum + item.amount, 0) + canonicalExpenseRows.reduce((sum, item) => sum + item.amount, 0);
  const voucherCategories = useMemo(''',
    '''  const totalRecognizedExpenses = voucherRows.reduce((sum, item) => sum + item.amount, 0) + canonicalExpenseRows.reduce((sum, item) => sum + item.amount, 0);
  const expenseExportRows = useMemo<ExpenseReportExportRow[]>(() => {
    const purchaseRows = voucherRows.flatMap((voucher) => voucherReportItems(voucher).map((line, index) => ({
      key: `${voucher.id}:${line.id}`,
      sourceId: voucher.id,
      voucherNumber: getVoucherDisplayNumber(voucher) || voucher.voucherNumber,
      date: voucher.date,
      lineNumber: index + 1,
      description: normalizeText(line.description) || normalizeText(line.remarks) || normalizeText(line.notes) || "-",
      categoryKey: line.category,
      categoryLabel: translateExpenseCategory(line.category),
      subcategoryKey: line.subcategory || "-",
      subcategoryLabel: line.subcategory ? translateExpenseSubcategory(line.subcategory) : "-",
      recordType: t("reportsPage.voucherExpense"),
      accountName: accountName(voucher.accountId),
      expenseAmount: line.amount,
      attributedAmount: line.amount,
      voucherTotal: voucher.amount,
      recipient: "-",
      status: t("common.active"),
    })));

    const labourRows = canonicalExpenseRows.flatMap((item) => {
      const allSources = canonicalExpenseAccountsByDue.get(item.id) ?? [];
      const filteredSources = selectedExpenseAccountId
        ? allSources.filter((source) => {
          const rawAccountId = (source as { accountId?: string | null }).accountId;
          const fallbackAccountId = accounts.find((account) => account.name.trim().toLowerCase() === source.accountName.trim().toLowerCase())?.id ?? null;
          const resolvedAccountId = resolveCanonicalAccountId(rawAccountId, accountLookup)
            ?? resolveCanonicalAccountId(fallbackAccountId, accountLookup)
            ?? fallbackAccountId
            ?? rawAccountId;
          return resolvedAccountId === selectedExpenseAccountId;
        })
        : allSources;
      const sources = filteredSources.map((source) => ({
        accountName: localizeSystemPlaceholder(t, source.accountName) || source.accountName,
        amount: Number(source.amount ?? 0),
      }));
      if (!sources.length) sources.push({ accountName: t("reportsPage.unattributed"), amount: item.amount });

      return sources.map((source, index) => ({
        key: `${item.id}:${index}`,
        sourceId: item.id,
        voucherNumber: item.dueNumber ?? item.id,
        date: item.date,
        lineNumber: index + 1,
        description: normalizeText(item.description) || "-",
        categoryKey: "Labour wages",
        categoryLabel: t("reportsPage.labourWagesCategory"),
        subcategoryKey: "Canonical labour due",
        subcategoryLabel: t("reportsPage.labourDueRecord"),
        recordType: t("reportsPage.labourDueRecord"),
        accountName: source.accountName,
        expenseAmount: index === 0 ? item.amount : 0,
        attributedAmount: source.amount,
        voucherTotal: item.amount,
        recipient: localizeSystemPlaceholder(t, item.recipientName) || item.recipientName || "-",
        status: translateStatus(t, item.status),
      }));
    });

    return [...purchaseRows, ...labourRows].sort((left, right) => {
      const dateOrder = expenseSort === "desc" ? right.date.localeCompare(left.date) : left.date.localeCompare(right.date);
      return dateOrder || left.voucherNumber.localeCompare(right.voucherNumber) || left.lineNumber - right.lineNumber;
    });
  }, [accountLookup, accountName, accounts, canonicalExpenseAccountsByDue, canonicalExpenseRows, expenseSort, selectedExpenseAccountId, t, voucherRows]);

  const expenseCategorySummaryRows = useMemo(() => {
    const grouped = new Map<string, { categoryKey: string; label: string; value: number; sourceIds: Set<string> }>();
    for (const row of expenseExportRows) {
      const current = grouped.get(row.categoryKey) ?? { categoryKey: row.categoryKey, label: row.categoryLabel, value: 0, sourceIds: new Set<string>() };
      current.value += row.expenseAmount;
      current.sourceIds.add(row.sourceId);
      grouped.set(row.categoryKey, current);
    }
    return [...grouped.values()].map((row) => ({
      categoryKey: row.categoryKey,
      label: row.label,
      value: row.value,
      share: totalRecognizedExpenses ? (row.value / totalRecognizedExpenses) * 100 : 0,
      voucherCount: row.sourceIds.size,
    })).sort((left, right) => right.value - left.value || left.label.localeCompare(right.label));
  }, [expenseExportRows, totalRecognizedExpenses]);

  const expenseSubcategorySummaryRows = useMemo(() => {
    const grouped = new Map<string, { categoryKey: string; categoryLabel: string; subcategoryKey: string; subcategoryLabel: string; value: number; sourceIds: Set<string> }>();
    for (const row of expenseExportRows) {
      const key = `${row.categoryKey}::${row.subcategoryKey}`;
      const current = grouped.get(key) ?? {
        categoryKey: row.categoryKey,
        categoryLabel: row.categoryLabel,
        subcategoryKey: row.subcategoryKey,
        subcategoryLabel: row.subcategoryLabel,
        value: 0,
        sourceIds: new Set<string>(),
      };
      current.value += row.expenseAmount;
      current.sourceIds.add(row.sourceId);
      grouped.set(key, current);
    }
    return [...grouped.values()].map((row) => ({
      ...row,
      share: totalRecognizedExpenses ? (row.value / totalRecognizedExpenses) * 100 : 0,
      voucherCount: row.sourceIds.size,
    })).filter((row) => row.value !== 0).sort((left, right) => right.value - left.value || left.subcategoryLabel.localeCompare(right.subcategoryLabel));
  }, [expenseExportRows, totalRecognizedExpenses]);

  const expenseAccountSummaryRows = useMemo(() => {
    const grouped = new Map<string, { label: string; value: number; sourceIds: Set<string> }>();
    for (const row of expenseExportRows) {
      const current = grouped.get(row.accountName) ?? { label: row.accountName, value: 0, sourceIds: new Set<string>() };
      current.value += row.attributedAmount;
      current.sourceIds.add(row.sourceId);
      grouped.set(row.accountName, current);
    }
    return [...grouped.values()].map((row) => ({
      label: row.label,
      value: row.value,
      share: totalRecognizedExpenses ? (row.value / totalRecognizedExpenses) * 100 : 0,
      voucherCount: row.sourceIds.size,
    })).sort((left, right) => right.value - left.value || left.label.localeCompare(right.label));
  }, [expenseExportRows, totalRecognizedExpenses]);

  const expenseVoucherCount = new Set(expenseExportRows.map((row) => row.sourceId)).size;
  const expenseLineItemCount = voucherReportLineRows.length + canonicalExpenseRows.length;
  const voucherCategories = useMemo(''',
    "insert normalized expense report data",
)

reports = replace_regex(
    reports,
    r'''  const exportExpenseSummary = \(\) => \{.*?\n  \};\n  const exportExpenseLog = \(\) => downloadCsv\("expense-log\.csv", \[.*?\n  \]\);\n  const exportPartnerPosition''',
    r'''  const exportExpenseSummary = () => {
    const suffix = from || to ? `${from || "start"}-${to || "end"}` : "all-dates";
    downloadCsv(`expense-summary-${suffix}.csv`, [
      [t("reportsPage.expenseSummary"), ""],
      [t("reportsPage.dateRange"), rangeLabel],
      [t("reportsPage.farm"), reportPrintContext.farm],
      [t("reportsPage.season"), reportPrintContext.season],
      [t("reportsPage.generated"), reportPrintContext.generatedAt],
      [t("reportsPage.by"), reportPrintContext.generatedBy],
      [],
      [t("reportsPage.totalExpenses"), totalRecognizedExpenses],
      [t("reportsPage.vouchers"), expenseVoucherCount],
      [t("reportsPage.lineItems"), expenseLineItemCount],
      [t("reportsPage.categories"), expenseCategorySummaryRows.length],
      [t("reportsPage.account"), expenseAccountSummaryRows.length],
      [],
      [t("reportsPage.category"), t("reportsPage.expenseAmount"), t("reportsPage.shareOfTotal"), t("reportsPage.vouchers")],
      ...expenseCategorySummaryRows.map((row) => [row.label, row.value, Number(row.share.toFixed(2)), row.voucherCount]),
      [],
      [t("reportsPage.category"), t("reportsPage.subcategory"), t("reportsPage.expenseAmount"), t("reportsPage.shareOfTotal"), t("reportsPage.vouchers")],
      ...expenseSubcategorySummaryRows.map((row) => [row.categoryLabel, row.subcategoryLabel, row.value, Number(row.share.toFixed(2)), row.voucherCount]),
      [],
      [t("reportsPage.account"), t("reportsPage.attributedAmount"), t("reportsPage.shareOfTotal"), t("reportsPage.vouchers")],
      ...expenseAccountSummaryRows.map((row) => [row.label, row.value, Number(row.share.toFixed(2)), row.voucherCount]),
      [],
      [t("reportsPage.grandTotal"), totalRecognizedExpenses],
    ]);
  };
  const exportExpenseLog = () => {
    const suffix = from || to ? `${from || "start"}-${to || "end"}` : "all-dates";
    downloadCsv(`expense-log-${suffix}.csv`, [
      [
        t("reportsPage.voucher"),
        t("reportsPage.date"),
        t("reportsPage.serial"),
        t("reportsPage.description"),
        t("reportsPage.category"),
        t("reportsPage.subcategory"),
        t("reportsPage.type"),
        t("reportsPage.account"),
        t("reportsPage.expenseAmount"),
        t("reportsPage.attributedAmount"),
        `${t("reportsPage.voucher")} ${t("reportsPage.total")}`,
        t("reportsPage.recipient"),
        t("reportsPage.status"),
      ],
      ...expenseExportRows.map((row) => [
        row.voucherNumber,
        row.date,
        row.lineNumber,
        row.description,
        row.categoryLabel,
        row.subcategoryLabel,
        row.recordType,
        row.accountName,
        row.expenseAmount,
        row.attributedAmount,
        row.voucherTotal,
        row.recipient,
        row.status,
      ]),
    ]);
  };
  const exportPartnerPosition''',
    "replace expense CSV exports",
)

reports = replace_once(
    reports,
    '''              {voucherSubcategories.map((item) => <option key={item} value={item}>{translateExpenseSubcategory(item)}</option>)}
            </ClearableSelect>''',
    '''              {voucherSubcategories.map((item) => <option key={item} value={item}>{translateExpenseSubcategory(item)}</option>)}
              {category === "Labour wages" && <option value="Canonical labour due">{t("reportsPage.labourDueRecord")}</option>}
            </ClearableSelect>''',
    "add canonical labour due subcategory option",
)

reports = replace_regex(
    reports,
    r'''        \{views\.expenditures === "summary" && <ReportShell.*?</ReportShell>\}\n        \{views\.expenditures === "log"''',
    r'''        {views.expenditures === "summary" && <ReportShell title={t("reportsPage.expenseSummary")} rangeLabel={rangeLabel} sectionId="expense-summary" printContext={reportPrintContext} printLayout="portrait" onPrint={() => printSection("expense-summary")} onExport={exportExpenseSummary}>
          <Kpis values={[
            [t("reportsPage.totalExpenses"), money(totalRecognizedExpenses)],
            [t("reportsPage.vouchers"), expenseVoucherCount],
            [t("reportsPage.lineItems"), expenseLineItemCount],
            [t("reportsPage.account"), expenseAccountSummaryRows.length],
          ]} />
          <div className="reports-breakdowns expense-summary-breakdowns">
            <div>
              <h3>{t("reportsPage.byCategory")}</h3>
              <div className="reports-summary-list">
                {expenseCategorySummaryRows.map((item) => <button type="button" className="reports-summary-drilldown" key={item.categoryKey} onClick={() => openExpenseCategory(item.categoryKey)}>
                  <span className="expense-summary-drilldown__label"><b>{item.label}</b><small>{formatNumber(item.share)}% · {item.voucherCount} {t("reportsPage.vouchers")}</small></span>
                  <strong>{money(item.value)}</strong><ChevronRight size={16} aria-hidden="true" />
                </button>)}
              </div>
            </div>
            <div>
              <h3>{t("reportsPage.byAccount")}</h3>
              <div className="reports-summary-list">
                {expenseAccountSummaryRows.map((item) => {
                  const account = expenseAccountTotals.find((candidate) => candidate.name === item.label);
                  return <button type="button" className="reports-summary-drilldown" key={item.label} onClick={() => account && openExpenseAccount(account.accountId)}>
                    <span className="expense-summary-drilldown__label"><b>{item.label}</b><small>{formatNumber(item.share)}% · {item.voucherCount} {t("reportsPage.vouchers")}</small></span>
                    <strong>{money(item.value)}</strong><ChevronRight size={16} aria-hidden="true" />
                  </button>;
                })}
              </div>
            </div>
            <div className="reports-breakdowns__full">
              <h3>{t("reportsPage.bySubcategory")}</h3>
              <div className="reports-summary-list expense-summary-subcategory-list">
                {expenseSubcategorySummaryRows.map((item) => <button type="button" className="reports-summary-drilldown" key={`${item.categoryKey}:${item.subcategoryKey}`} onClick={() => openExpenseSubcategory(item.categoryKey, item.subcategoryKey)}>
                  <span className="expense-summary-drilldown__label"><b>{item.subcategoryLabel}</b><small>{item.categoryLabel} · {formatNumber(item.share)}%</small></span>
                  <strong>{money(item.value)}</strong><ChevronRight size={16} aria-hidden="true" />
                </button>)}
              </div>
            </div>
          </div>
        </ReportShell>}
        {views.expenditures === "log"''',
    "replace expense summary presentation",
)

reports = replace_regex(
    reports,
    r'''        \{views\.expenditures === "log" && <ReportShell.*?</ReportShell>\}\n      </>\}''',
    r'''        {views.expenditures === "log" && <ReportShell title={t("reportsPage.expenseLog")} rangeLabel={rangeLabel} sectionId="expense-log" printContext={reportPrintContext} printLayout="landscape" printDensity="wide" onPrint={() => printSection("expense-log")} onExport={exportExpenseLog}>
          <Kpis values={[
            [t("reportsPage.totalExpenses"), money(totalRecognizedExpenses)],
            [t("reportsPage.vouchers"), expenseVoucherCount],
            [t("reportsPage.lineItems"), expenseLineItemCount],
            [t("reportsPage.account"), expenseAccountSummaryRows.length],
          ]} />
          <ReportTable
            empty={t("reportsPage.noRecords")}
            columns={[t("reportsPage.voucher"), t("reportsPage.date"), t("reportsPage.description"), t("reportsPage.category"), t("reportsPage.account"), t("reportsPage.amount")]}
            rows={[...voucherRows.map((item) => {
              const lines = voucherReportItems(item);
              const firstLine = lines[0];
              const firstDescription = normalizeText(firstLine?.description) || normalizeText(firstLine?.remarks) || normalizeText(firstLine?.notes) || "-";
              return {
                id: item.id,
                title: getVoucherDisplayNumber(item) || item.voucherNumber,
                value: money(item.amount),
                meta: `${formatReportDateValue(item.date)} · ${lines.length} ${t("reportsPage.lineItems")}`,
                cells: [
                  getVoucherDisplayNumber(item) || item.voucherNumber,
                  formatReportDateValue(item.date),
                  lines.length > 1 ? `${firstDescription} +${lines.length - 1} ${t("expensesPage.moreItems")}` : firstDescription,
                  firstLine ? expenseLabel(firstLine.category, firstLine.subcategory) : expenseLabel(item.category, item.subcategory),
                  accountName(item.accountId),
                  money(item.amount),
                ],
                details: [
                  ...lines.map((line, index) => [
                    `${t("expensesPage.itemNumber", { number: index + 1 })}`,
                    `${normalizeText(line.description) || normalizeText(line.remarks) || normalizeText(line.notes) || "-"} • ${expenseLabel(line.category, line.subcategory)} • ${money(line.amount)}`,
                  ] as [string, ReactNode]),
                  [t("reportsPage.account"), accountName(item.accountId)] as [string, ReactNode],
                ],
                onOpen: () => navigate(`/workspace/expenses?recordId=${item.id}`),
              };
            }), ...canonicalExpenseRows.map((item) => {
              const sources = canonicalExpenseAccountsByDue.get(item.id) ?? [];
              const sourceLabel = sources.map((source) => localizeSystemPlaceholder(t, source.accountName) || source.accountName).join(", ") || t("reportsPage.unattributed");
              return {
                id: item.id,
                title: item.dueNumber ?? localizeSystemPlaceholder(t, item.recipientName),
                value: money(item.amount),
                meta: formatReportDateValue(item.date),
                cells: [item.dueNumber ?? "-", formatReportDateValue(item.date), normalizeText(item.description) || "-", t("reportsPage.labourWagesCategory"), sourceLabel, money(item.amount)],
                details: [
                  [t("reportsPage.status"), translateStatus(t, item.status)],
                  [t("reportsPage.recipient"), localizeSystemPlaceholder(t, item.recipientName)],
                  ...sources.map((source) => [translateStatus(t, source.settlementType), `${localizeSystemPlaceholder(t, source.accountName)} — ${money(source.amount)}`] as [string, ReactNode]),
                ] as [string, ReactNode][],
              };
            })]}
            printColumns={[
              `${t("reportsPage.voucher")} / ${t("reportsPage.date")}`,
              `${t("reportsPage.description")} / ${t("reportsPage.type")}`,
              `${t("reportsPage.category")} / ${t("reportsPage.subcategory")}`,
              `${t("reportsPage.account")} / ${t("reportsPage.recipient")}`,
              `${t("reportsPage.expenseAmount")} / ${t("reportsPage.attributedAmount")}`,
            ]}
            printRows={expenseExportRows.map((row) => [
              <span className="report-print-cell-stack"><strong>{row.voucherNumber}</strong><small className="bidi-isolate">{formatReportDateValue(row.date)} · #{row.lineNumber}</small></span>,
              <span className="report-print-cell-stack"><strong>{row.description}</strong><small>{row.recordType}</small></span>,
              <span className="report-print-cell-stack"><strong>{row.categoryLabel}</strong><small>{row.subcategoryLabel}</small></span>,
              <span className="report-print-cell-stack"><strong>{row.accountName}</strong><small>{row.recipient !== "-" ? row.recipient : row.status}</small></span>,
              <span className="report-print-cell-stack"><strong className="bidi-isolate">{money(row.expenseAmount || row.attributedAmount)}</strong><small className="bidi-isolate">{t("reportsPage.attributedAmount")}: {money(row.attributedAmount)}</small></span>,
            ])}
          />
        </ReportShell>}
      </>}''',
    "replace expense log presentation",
)

REPORTS.write_text(reports, encoding="utf-8")

main = MAIN.read_text(encoding="utf-8")
main = replace_once(
    main,
    'import "./non-attendance-report-print.css";\nimport "./android-report-print-fix.css";',
    'import "./non-attendance-report-print.css";\nimport "./expense-report-polish.css";\nimport "./android-report-print-fix.css";',
    "import expense report CSS",
)
MAIN.write_text(main, encoding="utf-8")

locales = LOCALES.read_text(encoding="utf-8")
locale_insertions = [
    (
        '        halfDayPrintMark: "½",',
        '''        halfDayPrintMark: "½",
        lineItems: "Line items",
        shareOfTotal: "Share of total (%)",
        bySubcategory: "By subcategory",
        labourDueRecord: "Labour wage due",
        attributedAmount: "Attributed amount (SAR)",
        expenseAmount: "Expense amount (SAR)",''',
    ),
    (
        '        halfDayPrintMark: "½",',
        '''        halfDayPrintMark: "½",
        lineItems: "بنود المصروفات",
        shareOfTotal: "النسبة من الإجمالي (%)",
        bySubcategory: "حسب الفئة الفرعية",
        labourDueRecord: "استحقاق أجور العمالة",
        attributedAmount: "المبلغ المنسوب (ر.س)",
        expenseAmount: "مبلغ المصروف (ر.س)",''',
    ),
    (
        '        halfDayPrintMark: "½",',
        '''        halfDayPrintMark: "½",
        lineItems: "اخراجات کی لائن آئٹمز",
        shareOfTotal: "کل میں حصہ (%)",
        bySubcategory: "ذیلی زمرے کے لحاظ سے",
        labourDueRecord: "مزدور اجرت واجب الادا",
        attributedAmount: "منسوب رقم (ر.س)",
        expenseAmount: "اخراجات کی رقم (ر.س)",''',
    ),
]
for index, (old, new) in enumerate(locale_insertions, start=1):
    if old not in locales:
        raise SystemExit(f"locale insertion {index}: marker not found")
    locales = locales.replace(old, new, 1)
LOCALES.write_text(locales, encoding="utf-8")

final_reports = REPORTS.read_text(encoding="utf-8")
assert 'index === 0 ? (getVoucherDisplayNumber(voucher) || voucher.voucherNumber) : ""' not in final_reports
assert 'sources.map((source) => `${source.accountName} — ${money(source.amount)}`).join("; ")' not in final_reports
assert 'expense-summary-${suffix}.csv' in final_reports
assert 'expense-log-${suffix}.csv' in final_reports
assert 'expenseSubcategorySummaryRows' in final_reports
