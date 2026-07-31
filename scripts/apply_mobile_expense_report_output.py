from __future__ import annotations

from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


def replace_count(text: str, old: str, new: str, expected: int, label: str) -> str:
    count = text.count(old)
    if count != expected:
        raise RuntimeError(f"{label}: expected {expected} matches, found {count}")
    return text.replace(old, new)


reports_path = Path("web/src/pages/workspace/Reports.tsx")
reports = reports_path.read_text(encoding="utf-8")

reports = replace_once(
    reports,
    '''type ReportPrintContext = {
  farm: string;
  season: string;
  generatedAt: string;
  generatedBy: string;
};''',
    '''type ReportPrintContext = {
  workspace: string;
  farm: string;
  season: string;
  generatedAt: string;
  generatedBy: string;
};''',
    "report print context workspace",
)

reports = replace_once(
    reports,
    '''function downloadCsv(filename: string, rows: unknown[][]) {
  const href = URL.createObjectURL(new Blob([rows.map((row) => row.map(csvCell).join(",")).join("\\n")], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(href);
}''',
    '''function downloadCsv(filename: string, rows: unknown[][]) {
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\\n");
  const href = URL.createObjectURL(new Blob([`\\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 0);
}''',
    "csv utf8 and mobile download",
)

reports = replace_once(
    reports,
    '''      <dl className="report-document-meta">
        <div><dt>{t("reportsPage.farm")}</dt><dd>{printContext.farm}</dd></div>
        <div><dt>{t("reportsPage.season")}</dt><dd>{printContext.season}</dd></div>
        <div><dt>{t("reportsPage.generated")}</dt><dd className="bidi-isolate">{printContext.generatedAt}</dd></div>
        <div><dt>{t("reportsPage.by")}</dt><dd>{printContext.generatedBy}</dd></div>
      </dl>''',
    '''      <dl className="report-document-meta">
        <div><dt>{t("teamActivity.workspace")}</dt><dd>{printContext.workspace}</dd></div>
        <div><dt>{t("reportsPage.farm")}</dt><dd>{printContext.farm}</dd></div>
        <div><dt>{t("reportsPage.season")}</dt><dd>{printContext.season}</dd></div>
        <div><dt>{t("reportsPage.generated")}</dt><dd className="bidi-isolate">{printContext.generatedAt}</dd></div>
        <div><dt>{t("reportsPage.by")}</dt><dd>{printContext.generatedBy}</dd></div>
      </dl>''',
    "printed workspace metadata",
)

reports = replace_once(
    reports,
    '''  const reportPrintContext = useMemo<ReportPrintContext>(() => ({
    farm: bootstrapFarm?.name ?? t("reportsPage.allFarms"),
    season: bootstrapSeason?.name ?? t("reportsPage.allSeasons"),
    generatedAt: printGeneratedAt,
    generatedBy: printGeneratedBy,
  }), [bootstrapFarm?.name, bootstrapSeason?.name, printGeneratedAt, printGeneratedBy, t]);''',
    '''  const reportPrintContext = useMemo<ReportPrintContext>(() => ({
    workspace: bootstrapQuery.data?.user.workspaceName ?? user?.workspaceName ?? t("reportsPage.unknown"),
    farm: bootstrapFarm?.name ?? t("reportsPage.allFarms"),
    season: bootstrapSeason?.name ?? t("reportsPage.allSeasons"),
    generatedAt: printGeneratedAt,
    generatedBy: printGeneratedBy,
  }), [bootstrapFarm?.name, bootstrapQuery.data?.user.workspaceName, bootstrapSeason?.name, printGeneratedAt, printGeneratedBy, t, user?.workspaceName]);''',
    "report context values",
)

reports = replace_once(
    reports,
    '''    const previousDocumentTitle = document.title;
    const previousAccountGroups = reportGroupExpanded;
    const previousPartnerGroups = partnerReportGroupExpanded;
    const restoreCallbacks: Array<() => void> = [];

    if (sectionId === "account-ledger") {
      flushSync(() => {
        setReportGroupExpanded(Object.fromEntries(Object.keys(previousAccountGroups).map((key) => [key, true])) as Record<AccountTransactionGroupKey, boolean>);
        setPartnerReportGroupExpanded(Object.fromEntries(Object.keys(previousPartnerGroups).map((key) => [key, true])) as Record<PartnerLiabilityLedgerGroupKey, boolean>);
      });
      restoreCallbacks.push(() => {
        setReportGroupExpanded(previousAccountGroups);
        setPartnerReportGroupExpanded(previousPartnerGroups);
      });
    }

    const cleanupPrintTarget = () => {
      section.classList.remove("is-print-target");
      printRoot.removeAttribute("data-muzare-print-section");
      document.title = previousDocumentTitle;
      restoreCallbacks.forEach((restore) => restore());
    };
    document.title = `Muzare - ${section.dataset.printTitle ?? sectionId}`;
    printRoot.setAttribute("data-muzare-print-section", sectionId);
    section.classList.add("is-print-target");
    window.addEventListener("afterprint", cleanupPrintTarget, { once: true });
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()));''',
    '''    const previousDocumentTitle = document.title;
    const previousAccountGroups = reportGroupExpanded;
    const previousPartnerGroups = partnerReportGroupExpanded;
    const restoreCallbacks: Array<() => void> = [];

    if (sectionId === "account-ledger") {
      flushSync(() => {
        setReportGroupExpanded(Object.fromEntries(Object.keys(previousAccountGroups).map((key) => [key, true])) as Record<AccountTransactionGroupKey, boolean>);
        setPartnerReportGroupExpanded(Object.fromEntries(Object.keys(previousPartnerGroups).map((key) => [key, true])) as Record<PartnerLiabilityLedgerGroupKey, boolean>);
      });
      restoreCallbacks.push(() => {
        setReportGroupExpanded(previousAccountGroups);
        setPartnerReportGroupExpanded(previousPartnerGroups);
      });
    }

    const detachedRoot = document.createElement("div");
    detachedRoot.id = "muzare-detached-print-root";
    detachedRoot.dir = document.documentElement.dir || "ltr";
    detachedRoot.lang = document.documentElement.lang || "en";
    detachedRoot.setAttribute("role", "document");
    detachedRoot.setAttribute("aria-label", section.dataset.printTitle ?? sectionId);

    const detachedSection = section.cloneNode(true) as HTMLElement;
    detachedSection.classList.add("is-print-target");
    detachedSection.removeAttribute("aria-hidden");
    detachedRoot.appendChild(detachedSection);

    document.title = `Muzare - ${section.dataset.printTitle ?? sectionId}`;
    printRoot.setAttribute("data-muzare-print-section", sectionId);
    printRoot.setAttribute("data-muzare-detached-print", "true");
    document.body.appendChild(detachedRoot);

    let cleanedUp = false;
    const printMediaQuery = window.matchMedia("print");
    const cleanupPrintTarget = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      window.clearTimeout(fallbackCleanup);
      window.removeEventListener("afterprint", handleAfterPrint);
      if (typeof printMediaQuery.removeEventListener === "function") printMediaQuery.removeEventListener("change", handlePrintMediaChange);
      else printMediaQuery.removeListener(handlePrintMediaChange);
      detachedRoot.remove();
      printRoot.removeAttribute("data-muzare-print-section");
      printRoot.removeAttribute("data-muzare-detached-print");
      document.title = previousDocumentTitle;
      restoreCallbacks.forEach((restore) => restore());
    };
    const handleAfterPrint = () => window.setTimeout(cleanupPrintTarget, 250);
    const handlePrintMediaChange = (event: MediaQueryListEvent) => {
      if (!event.matches) window.setTimeout(cleanupPrintTarget, 250);
    };
    window.addEventListener("afterprint", handleAfterPrint, { once: true });
    if (typeof printMediaQuery.addEventListener === "function") printMediaQuery.addEventListener("change", handlePrintMediaChange);
    else printMediaQuery.addListener(handlePrintMediaChange);
    const fallbackCleanup = window.setTimeout(cleanupPrintTarget, 120_000);

    void detachedSection.offsetHeight;
    requestAnimationFrame(() => requestAnimationFrame(() => window.setTimeout(() => window.print(), 120)));''',
    "detached mobile print root",
)

reports = replace_once(
    reports,
    '''  const expenseVoucherCount = new Set(expenseExportRows.map((row) => row.sourceId)).size;
  const expenseLineItemCount = voucherReportLineRows.length + canonicalExpenseRows.length;''',
    '''  const expenseVoucherCount = new Set(expenseExportRows.map((row) => row.sourceId)).size;
  const expenseLineItemCount = expenseExportRows.length;
  const expenseCsvHeaderRows = (title: string): unknown[][] => [
    ["Muzare", title],
    [t("teamActivity.workspace"), reportPrintContext.workspace],
    [t("reportsPage.farm"), reportPrintContext.farm],
    [t("reportsPage.season"), reportPrintContext.season],
    [t("reportsPage.dateRange"), rangeLabel],
    [t("reportsPage.generated"), reportPrintContext.generatedAt],
    [t("reportsPage.by"), reportPrintContext.generatedBy],
  ];
  const expenseCsvTotalsRows: unknown[][] = [
    [],
    [t("reportsPage.summary"), ""],
    [t("reportsPage.transactions"), expenseVoucherCount],
    [t("reportsPage.lineItems"), expenseLineItemCount],
    [t("reportsPage.totalExpenses"), totalRecognizedExpenses],
    [t("reportsPage.categories"), expenseCategorySummaryRows.length],
    [t("reportsPage.account"), expenseAccountSummaryRows.length],
    [],
    [t("reportsPage.byCategory"), ""],
    [t("reportsPage.category"), t("reportsPage.expenseAmount"), t("reportsPage.shareOfTotal"), t("reportsPage.transactions")],
    ...expenseCategorySummaryRows.map((row) => [row.label, row.value, Number(row.share.toFixed(2)), row.voucherCount]),
    [],
    [t("reportsPage.byAccount"), ""],
    [t("reportsPage.account"), t("reportsPage.attributedAmount"), t("reportsPage.shareOfTotal"), t("reportsPage.transactions")],
    ...expenseAccountSummaryRows.map((row) => [row.label, row.value, Number(row.share.toFixed(2)), row.voucherCount]),
    [],
    [t("reportsPage.bySubcategory"), ""],
    [t("reportsPage.category"), t("reportsPage.subcategory"), t("reportsPage.expenseAmount"), t("reportsPage.shareOfTotal"), t("reportsPage.transactions")],
    ...expenseSubcategorySummaryRows.map((row) => [row.categoryLabel, row.subcategoryLabel, row.value, Number(row.share.toFixed(2)), row.voucherCount]),
    [],
    [t("reportsPage.grandTotal"), totalRecognizedExpenses],
  ];''',
    "expense csv metadata and footer totals",
)

reports = replace_once(
    reports,
    '''  const exportExpenseSummary = () => {
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
  };''',
    '''  const exportExpenseSummary = () => {
    const suffix = from || to ? `${from || "start"}-${to || "end"}` : "all-dates";
    downloadCsv(`expense-summary-${suffix}.csv`, [
      ...expenseCsvHeaderRows(t("reportsPage.expenseSummary")),
      ...expenseCsvTotalsRows,
    ]);
  };
  const exportExpenseLog = () => {
    const suffix = from || to ? `${from || "start"}-${to || "end"}` : "all-dates";
    downloadCsv(`expense-log-${suffix}.csv`, [
      ...expenseCsvHeaderRows(t("reportsPage.expenseLog")),
      [],
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
      ...expenseCsvTotalsRows,
    ]);
  };''',
    "expense exports with full header and bottom analysis",
)

reports = replace_count(
    reports,
    '''            [t("reportsPage.vouchers"), expenseVoucherCount],''',
    '''            [t("reportsPage.transactions"), expenseVoucherCount],''',
    2,
    "expense transaction kpis",
)

reports = replace_count(
    reports,
    '''<span className="expense-summary-drilldown__label"><b>{item.label}</b><small>{formatNumber(item.share)}% · {item.voucherCount} {t("reportsPage.vouchers")}</small></span>''',
    '''<span className="expense-summary-drilldown__label"><b>{item.label}</b><small>{formatNumber(item.share)}% · {item.voucherCount} {t("reportsPage.vouchers")}</small><span className="expense-summary-share-bar" aria-hidden="true"><i style={{ width: `${Math.min(item.share, 100)}%` }} /></span></span>''',
    2,
    "category and account share graphics",
)

reports = replace_once(
    reports,
    '''<span className="expense-summary-drilldown__label"><b>{item.subcategoryLabel}</b><small>{item.categoryLabel} · {formatNumber(item.share)}%</small></span>''',
    '''<span className="expense-summary-drilldown__label"><b>{item.subcategoryLabel}</b><small>{item.categoryLabel} · {formatNumber(item.share)}%</small><span className="expense-summary-share-bar" aria-hidden="true"><i style={{ width: `${Math.min(item.share, 100)}%` }} /></span></span>''',
    "subcategory share graphic",
)

reports = replace_once(
    reports,
    '''            printRows={expenseExportRows.map((row) => [
              <span className="report-print-cell-stack"><strong>{row.voucherNumber}</strong><small className="bidi-isolate">{formatReportDateValue(row.date)} · #{row.lineNumber}</small></span>,
              <span className="report-print-cell-stack"><strong>{row.description}</strong><small>{row.recordType}</small></span>,
              <span className="report-print-cell-stack"><strong>{row.categoryLabel}</strong><small>{row.subcategoryLabel}</small></span>,
              <span className="report-print-cell-stack"><strong>{row.accountName}</strong><small>{row.recipient !== "-" ? row.recipient : row.status}</small></span>,
              <span className="report-print-cell-stack"><strong className="bidi-isolate">{money(row.expenseAmount)}</strong><small className="bidi-isolate">{t("reportsPage.attributedAmount")}: {money(row.attributedAmount)}</small></span>,
            ])}
          />
        </ReportShell>}''',
    '''            printRows={expenseExportRows.map((row) => [
              <span className="report-print-cell-stack"><strong>{row.voucherNumber}</strong><small className="bidi-isolate">{formatReportDateValue(row.date)} · #{row.lineNumber}</small></span>,
              <span className="report-print-cell-stack"><strong>{row.description}</strong><small>{row.recordType}</small></span>,
              <span className="report-print-cell-stack"><strong>{row.categoryLabel}</strong><small>{row.subcategoryLabel}</small></span>,
              <span className="report-print-cell-stack"><strong>{row.accountName}</strong><small>{row.recipient !== "-" ? row.recipient : row.status}</small></span>,
              <span className="report-print-cell-stack"><strong className="bidi-isolate">{money(row.expenseAmount)}</strong><small className="bidi-isolate">{t("reportsPage.attributedAmount")}: {money(row.attributedAmount)}</small></span>,
            ])}
          />
          <section className="expense-report-footer-summary" aria-label={t("reportsPage.summary")}>
            <header className="expense-report-footer-summary__header">
              <div><span>{t("reportsPage.summary")}</span><h3>{t("reportsPage.expenseSummary")}</h3></div>
              <strong>{money(totalRecognizedExpenses)}</strong>
            </header>
            <div className="expense-report-footer-summary__kpis">
              <article><span>{t("reportsPage.transactions")}</span><strong>{formatNumber(expenseVoucherCount)}</strong></article>
              <article><span>{t("reportsPage.lineItems")}</span><strong>{formatNumber(expenseLineItemCount)}</strong></article>
              <article><span>{t("reportsPage.totalExpenses")}</span><strong>{money(totalRecognizedExpenses)}</strong></article>
            </div>
            <div className="expense-report-footer-summary__breakdowns">
              <div>
                <h4>{t("reportsPage.byCategory")}</h4>
                <div className="expense-report-footer-summary__list">
                  {expenseCategorySummaryRows.map((item) => <article className="expense-report-summary-row" key={`footer-category:${item.categoryKey}`}>
                    <div><strong>{item.label}</strong><small>{formatNumber(item.share)}% · {item.voucherCount} {t("reportsPage.transactions")}</small><span className="expense-summary-share-bar" aria-hidden="true"><i style={{ width: `${Math.min(item.share, 100)}%` }} /></span></div>
                    <b>{money(item.value)}</b>
                  </article>)}
                </div>
              </div>
              <div>
                <h4>{t("reportsPage.byAccount")}</h4>
                <div className="expense-report-footer-summary__list">
                  {expenseAccountSummaryRows.map((item) => <article className="expense-report-summary-row" key={`footer-account:${item.label}`}>
                    <div><strong>{item.label}</strong><small>{formatNumber(item.share)}% · {item.voucherCount} {t("reportsPage.transactions")}</small><span className="expense-summary-share-bar" aria-hidden="true"><i style={{ width: `${Math.min(item.share, 100)}%` }} /></span></div>
                    <b>{money(item.value)}</b>
                  </article>)}
                </div>
              </div>
            </div>
          </section>
        </ReportShell>}''',
    "expense log bottom summary",
)

reports_path.write_text(reports, encoding="utf-8")

print_css_path = Path("web/src/non-attendance-report-print.css")
print_css = print_css_path.read_text(encoding="utf-8")
print_css = replace_once(
    print_css,
    '''  html[data-muzare-print-section]:not([data-muzare-print-section^="attendance"]) .reports-print-section.is-print-target button,''',
    '''  html[data-muzare-print-section]:not([data-muzare-print-section^="attendance"]) .reports-print-section.is-print-target button:not(.reports-summary-drilldown),''',
    "keep analytical rows visible in print",
)
print_css = replace_once(
    print_css,
    '''    grid-template-columns: repeat(4, minmax(0, 1fr));''',
    '''    grid-template-columns: minmax(0, 1.35fr) repeat(2, minmax(0, 1fr)) minmax(0, 1.2fr) minmax(0, 1fr);''',
    "five-column print metadata",
)
print_css_path.write_text(print_css, encoding="utf-8")

android_css_path = Path("web/src/android-report-print-fix.css")
android_css = android_css_path.read_text(encoding="utf-8")
android_css = replace_once(
    android_css,
    '''    background: #fff !important;
    display: block !important;
    height: auto !important;''',
    '''    background: #fff !important;
    contain: none !important;
    content-visibility: visible !important;
    display: block !important;
    height: auto !important;''',
    "detached print root rendering",
)
android_css_path.write_text(android_css, encoding="utf-8")

expense_css = r'''
.expense-summary-breakdowns {
  align-items: start;
}

.reports-breakdowns__full {
  grid-column: 1 / -1;
}

.expense-summary-drilldown__label {
  display: grid;
  gap: 3px;
  min-width: 0;
  text-align: start;
}

.expense-summary-drilldown__label b {
  color: var(--text-primary);
  font-size: .88rem;
  font-weight: 800;
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.expense-summary-drilldown__label small {
  color: var(--text-secondary);
  font-size: .7rem;
  font-weight: 650;
  line-height: 1.3;
}

.expense-summary-share-bar {
  background: rgba(46, 125, 50, .13);
  border-radius: 999px;
  display: block;
  height: 4px;
  margin-top: 2px;
  overflow: hidden;
  width: 100%;
}

.expense-summary-share-bar i {
  background: linear-gradient(90deg, #2e7d32, #72ad72);
  border-radius: inherit;
  display: block;
  height: 100%;
  min-width: 2px;
}

.expense-summary-breakdowns .reports-summary-drilldown {
  grid-template-columns: minmax(0, 1fr) auto auto !important;
}

.expense-summary-subcategory-list {
  display: grid;
  gap: 8px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.expense-report-footer-summary {
  background: var(--surface, #fff);
  border: 1px solid var(--border, #dce5df);
  border-radius: 18px;
  box-shadow: 0 12px 30px rgba(26, 57, 36, .08);
  margin-top: 18px;
  overflow: hidden;
}

.expense-report-footer-summary__header {
  align-items: center;
  background: linear-gradient(135deg, #1f6f37, #358e50);
  color: #fff;
  display: flex;
  gap: 16px;
  justify-content: space-between;
  padding: 18px 20px;
}

.expense-report-footer-summary__header div {
  display: grid;
  gap: 2px;
}

.expense-report-footer-summary__header span {
  font-size: .7rem;
  font-weight: 800;
  letter-spacing: .08em;
  opacity: .78;
  text-transform: uppercase;
}

.expense-report-footer-summary__header h3,
.expense-report-footer-summary__header strong {
  color: inherit;
  margin: 0;
}

.expense-report-footer-summary__header h3 {
  font-size: 1rem;
}

.expense-report-footer-summary__header > strong {
  font-size: 1.15rem;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.expense-report-footer-summary__kpis {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  padding: 14px 16px 0;
}

.expense-report-footer-summary__kpis article {
  background: var(--surface-subtle, #f7faf8);
  border: 1px solid var(--border, #e0e7e2);
  border-radius: 12px;
  display: grid;
  gap: 5px;
  padding: 12px;
}

.expense-report-footer-summary__kpis span {
  color: var(--text-secondary);
  font-size: .7rem;
  font-weight: 700;
}

.expense-report-footer-summary__kpis strong {
  color: var(--text-primary);
  font-size: .95rem;
  font-variant-numeric: tabular-nums;
}

.expense-report-footer-summary__breakdowns {
  display: grid;
  gap: 14px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  padding: 14px 16px 16px;
}

.expense-report-footer-summary__breakdowns > div {
  border: 1px solid var(--border, #e0e7e2);
  border-radius: 14px;
  min-width: 0;
  padding: 12px;
}

.expense-report-footer-summary__breakdowns h4 {
  color: var(--text-primary);
  font-size: .78rem;
  margin: 0 0 9px;
}

.expense-report-footer-summary__list {
  display: grid;
  gap: 7px;
}

.expense-report-summary-row {
  align-items: start;
  background: var(--surface-subtle, #f8faf8);
  border: 1px solid var(--border, #e3e9e5);
  border-radius: 10px;
  display: grid;
  gap: 10px;
  grid-template-columns: minmax(0, 1fr) auto;
  padding: 9px 10px;
}

.expense-report-summary-row > div {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.expense-report-summary-row strong {
  color: var(--text-primary);
  font-size: .76rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.expense-report-summary-row small {
  color: var(--text-secondary);
  font-size: .64rem;
  font-weight: 650;
}

.expense-report-summary-row > b {
  color: var(--text-primary);
  font-size: .76rem;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

@media (max-width: 720px) {
  .expense-summary-subcategory-list,
  .expense-report-footer-summary__breakdowns,
  .expense-report-footer-summary__kpis {
    grid-template-columns: minmax(0, 1fr);
  }

  .expense-report-footer-summary__header {
    align-items: start;
    flex-direction: column;
  }
}

@media print {
  html[data-muzare-print-section="expense-summary"] .expense-summary-subcategory-list {
    display: grid !important;
    gap: 1.6mm !important;
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
  }

  html[data-muzare-print-section="expense-summary"] .reports-print-section.is-print-target button.reports-summary-drilldown {
    display: grid !important;
    grid-template-columns: minmax(0, 1fr) auto !important;
  }

  html[data-muzare-print-section="expense-summary"] .expense-summary-drilldown__label {
    display: grid !important;
    gap: .6mm !important;
  }

  html[data-muzare-print-section="expense-summary"] .expense-summary-drilldown__label b {
    color: #24362a !important;
    font-size: 7.2pt !important;
    white-space: normal !important;
  }

  html[data-muzare-print-section="expense-summary"] .expense-summary-drilldown__label small {
    color: #68766c !important;
    display: block !important;
    font-size: 6pt !important;
  }

  html[data-muzare-print-section^="expense-"] .expense-summary-share-bar {
    background: #e0ebe2 !important;
    height: 1.1mm !important;
    margin-top: .5mm !important;
  }

  html[data-muzare-print-section^="expense-"] .expense-summary-share-bar i {
    background: #2e7d32 !important;
  }

  html[data-muzare-print-section="expense-log"] .expense-report-footer-summary {
    background: #fff !important;
    border: .7pt solid #cbd8ce !important;
    border-radius: 2.5mm !important;
    box-shadow: none !important;
    break-inside: auto;
    margin-top: 5mm !important;
    overflow: hidden !important;
  }

  html[data-muzare-print-section="expense-log"] .expense-report-footer-summary__header {
    background: #246d37 !important;
    display: flex !important;
    padding: 3mm 3.5mm !important;
  }

  html[data-muzare-print-section="expense-log"] .expense-report-footer-summary__header span {
    font-size: 6pt !important;
  }

  html[data-muzare-print-section="expense-log"] .expense-report-footer-summary__header h3 {
    font-size: 9pt !important;
  }

  html[data-muzare-print-section="expense-log"] .expense-report-footer-summary__header > strong {
    font-size: 10pt !important;
  }

  html[data-muzare-print-section="expense-log"] .expense-report-footer-summary__kpis {
    display: grid !important;
    gap: 1.8mm !important;
    grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
    padding: 2.5mm 3mm 0 !important;
  }

  html[data-muzare-print-section="expense-log"] .expense-report-footer-summary__kpis article {
    background: #f6f9f6 !important;
    border: .5pt solid #d9e3db !important;
    border-radius: 1.5mm !important;
    padding: 2mm !important;
  }

  html[data-muzare-print-section="expense-log"] .expense-report-footer-summary__kpis span {
    font-size: 6pt !important;
  }

  html[data-muzare-print-section="expense-log"] .expense-report-footer-summary__kpis strong {
    font-size: 8pt !important;
  }

  html[data-muzare-print-section="expense-log"] .expense-report-footer-summary__breakdowns {
    display: grid !important;
    gap: 2.5mm !important;
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
    padding: 2.5mm 3mm 3mm !important;
  }

  html[data-muzare-print-section="expense-log"] .expense-report-footer-summary__breakdowns > div {
    border: .5pt solid #d9e3db !important;
    border-radius: 1.5mm !important;
    padding: 2mm !important;
  }

  html[data-muzare-print-section="expense-log"] .expense-report-footer-summary__breakdowns h4 {
    color: #244c31 !important;
    font-size: 7pt !important;
    margin-bottom: 1.5mm !important;
  }

  html[data-muzare-print-section="expense-log"] .expense-report-footer-summary__list {
    gap: 1mm !important;
  }

  html[data-muzare-print-section="expense-log"] .expense-report-summary-row {
    background: #fafcfb !important;
    border: .4pt solid #e0e7e2 !important;
    border-radius: 1mm !important;
    break-inside: avoid;
    gap: 1.5mm !important;
    padding: 1.3mm 1.5mm !important;
  }

  html[data-muzare-print-section="expense-log"] .expense-report-summary-row strong,
  html[data-muzare-print-section="expense-log"] .expense-report-summary-row > b {
    color: #26382c !important;
    font-size: 6.3pt !important;
  }

  html[data-muzare-print-section="expense-log"] .expense-report-summary-row small {
    color: #68766c !important;
    font-size: 5.4pt !important;
  }
}
'''.lstrip()
Path("web/src/expense-report-polish.css").write_text(expense_css, encoding="utf-8")

print("Applied mobile print, CSV metadata, bottom totals, and expense report visual polish.")
