from pathlib import Path

reports_path = Path("web/src/pages/workspace/Reports.tsx")
main_path = Path("web/src/main.tsx")
css_path = Path("web/src/reports-expenditure-drilldown.css")


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    reports_path,
    '''  const voucherBaseRows = useMemo(() => generalExpenseVouchers
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
  [accountId, accountName, generalExpenseVouchers, matches]);''',
    '''  const selectedExpenseAccountId = accountId ? resolveCanonicalAccountId(accountId, accountLookup) ?? accountId : "";
  const voucherBaseRows = useMemo(() => generalExpenseVouchers
    .filter((item) => {
      const lines = voucherReportItems(item);
      return (!selectedExpenseAccountId || resolveCanonicalAccountId(item.accountId, accountLookup) === selectedExpenseAccountId)
        && matches(item.date, [
          getVoucherDisplayNumber(item) || item.voucherNumber,
          item.description,
          item.notes,
          accountName(item.accountId),
          ...lines.flatMap((line) => [line.category, line.subcategory, line.description, line.remarks ?? "", String(line.amount)]),
        ], item.amount);
    }),
  [accountLookup, accountName, generalExpenseVouchers, matches, selectedExpenseAccountId]);''',
)

replace_once(
    reports_path,
    '''  const canonicalExpenseRows = useMemo(() => (canonicalFinancials.data?.expenses ?? [])
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
  [canonicalExpenseIds, canonicalFinancials.data?.expenseAccountAttributions]);''',
    '''  const canonicalExpenseAttributions = canonicalFinancials.data?.expenseAccountAttributions ?? [];
  const canonicalExpenseAccountIdsByDue = useMemo(() => {
    const grouped = new Map<string, Set<string>>();
    for (const row of canonicalExpenseAttributions) {
      const rawAccountId = (row as { accountId?: string | null }).accountId;
      const fallbackAccountId = accounts.find((account) => account.name === row.accountName)?.id ?? null;
      const resolvedAccountId = resolveCanonicalAccountId(rawAccountId ?? fallbackAccountId, accountLookup) ?? rawAccountId ?? fallbackAccountId;
      if (!resolvedAccountId) continue;
      const accountIds = grouped.get(row.dueId) ?? new Set<string>();
      accountIds.add(resolvedAccountId);
      grouped.set(row.dueId, accountIds);
    }
    return grouped;
  }, [accountLookup, accounts, canonicalExpenseAttributions]);
  const canonicalExpenseRows = useMemo(() => (canonicalFinancials.data?.expenses ?? [])
    .filter((item) => item.active
      && inRange(item.date, from, to)
      && (!category || category === "Labour wages")
      && (!subcategory || subcategory === "Canonical labour due")
      && (!selectedExpenseAccountId || canonicalExpenseAccountIdsByDue.get(item.id)?.has(selectedExpenseAccountId))
      && matches(item.date, [item.dueNumber, item.recipientName, item.description, item.status], item.amount))
    .sort((a, b) => expenseSort === "desc" ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date)),
  [canonicalExpenseAccountIdsByDue, canonicalFinancials.data?.expenses, category, expenseSort, from, matches, selectedExpenseAccountId, subcategory, to]);
  const canonicalExpenseIds = useMemo(() => new Set(canonicalExpenseRows.map((item) => item.id)), [canonicalExpenseRows]);
  const canonicalExpenseAccountRows = useMemo(() => canonicalExpenseAttributions
    .filter((item) => canonicalExpenseIds.has(item.dueId)),
  [canonicalExpenseAttributions, canonicalExpenseIds]);''',
)

replace_once(
    reports_path,
    '''  const expenseAccountTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const item of voucherReportLineRows) {
      const name = accountName(item.accountId);
      totals.set(name, (totals.get(name) ?? 0) + item.amount);
    }
    for (const item of canonicalExpenseAccountRows) totals.set(item.accountName, (totals.get(item.accountName) ?? 0) + item.amount);
    return [...totals.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [canonicalExpenseAccountRows, voucherReportLineRows]);''',
    '''  const expenseAccountTotals = useMemo(() => {
    const totals = new Map<string, { accountId: string; name: string; value: number }>();
    const addAmount = (rawAccountId: string | null | undefined, sourceName: string, amount: number) => {
      const fallbackAccountId = accounts.find((account) => account.name === sourceName)?.id ?? null;
      const resolvedAccountId = resolveCanonicalAccountId(rawAccountId ?? fallbackAccountId, accountLookup) ?? rawAccountId ?? fallbackAccountId;
      if (!resolvedAccountId) return;
      const resolvedName = localizeSystemPlaceholder(t, accountName(resolvedAccountId)) || localizeSystemPlaceholder(t, sourceName) || sourceName;
      const current = totals.get(resolvedAccountId);
      totals.set(resolvedAccountId, {
        accountId: resolvedAccountId,
        name: resolvedName,
        value: (current?.value ?? 0) + amount,
      });
    };
    for (const item of voucherReportLineRows) addAmount(item.accountId, accountName(item.accountId), item.amount);
    for (const item of canonicalExpenseAccountRows) addAmount((item as { accountId?: string | null }).accountId, item.accountName, item.amount);
    return [...totals.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [accountLookup, accountName, accounts, canonicalExpenseAccountRows, t, voucherReportLineRows]);''',
)

replace_once(
    reports_path,
    '''  const openAccountLedger = (nextAccountId: string) => {
    setAccountId(nextAccountId);
    switchView("account-ledger", "ledger");
  };''',
    '''  const openAccountLedger = (nextAccountId: string) => {
    setAccountId(nextAccountId);
    switchView("account-ledger", "ledger");
  };
  const openExpenseCategory = (nextCategory: string) => {
    setCategory(nextCategory);
    setSubcategory("");
    switchView("expenditures", "log");
  };
  const openExpenseAccount = (nextAccountId: string) => {
    setAccountId(nextAccountId);
    switchView("expenditures", "log");
  };''',
)

replace_once(
    reports_path,
    '''    const accountTotals = expenseAccountTotals;''',
    '''    const accountTotals = expenseAccountTotals.map((item) => [item.name, item.value]);''',
)

replace_once(
    reports_path,
    '''              {voucherCategories.map((item) => <option key={item} value={item}>{translateExpenseCategory(item)}</option>)}''',
    '''              {voucherCategories.map((item) => <option key={item} value={item}>{translateExpenseCategory(item)}</option>)}
              {!voucherCategories.includes("Labour wages") && <option value="Labour wages">{t("reportsPage.labourWagesCategory")}</option>}''',
)

replace_once(
    reports_path,
    '''                {[...new Set(voucherReportLineRows.map((item) => item.category))].map((name) => <article key={name}><span>{translateExpenseCategory(name)}</span><strong>{money(voucherReportLineRows.filter((item) => item.category === name).reduce((sum, item) => sum + item.amount, 0))}</strong></article>)}
                {canonicalExpenseRows.length ? <article><span>{t("reportsPage.labourWagesCategory")}</span><strong>{money(canonicalExpenseRows.reduce((sum, item) => sum + item.amount, 0))}</strong></article> : null}''',
    '''                {[...new Set(voucherReportLineRows.map((item) => item.category))].map((name) => {
                  const value = voucherReportLineRows.filter((item) => item.category === name).reduce((sum, item) => sum + item.amount, 0);
                  return <button type="button" className="reports-summary-drilldown" key={name} onClick={() => openExpenseCategory(name)}><span>{translateExpenseCategory(name)}</span><strong>{money(value)}</strong><ChevronRight size={16} aria-hidden="true" /></button>;
                })}
                {canonicalExpenseRows.length ? <button type="button" className="reports-summary-drilldown" onClick={() => openExpenseCategory("Labour wages")}><span>{t("reportsPage.labourWagesCategory")}</span><strong>{money(canonicalExpenseRows.reduce((sum, item) => sum + item.amount, 0))}</strong><ChevronRight size={16} aria-hidden="true" /></button> : null}''',
)

replace_once(
    reports_path,
    '''                {expenseAccountTotals.map(([name, value]) => <article key={name}><span>{localizeSystemPlaceholder(t, name)}</span><strong>{money(value)}</strong></article>)}''',
    '''                {expenseAccountTotals.map((item) => <button type="button" className="reports-summary-drilldown" key={item.accountId} onClick={() => openExpenseAccount(item.accountId)}><span>{item.name}</span><strong>{money(item.value)}</strong><ChevronRight size={16} aria-hidden="true" /></button>)}''',
)

main_text = main_path.read_text(encoding="utf-8")
import_line = 'import "./reports-expenditure-drilldown.css";\n'
if import_line not in main_text:
    anchor = 'import "./reports-account-polish.css";\n'
    if anchor not in main_text:
        raise SystemExit("main.tsx: reports-account-polish import anchor not found")
    main_path.write_text(main_text.replace(anchor, anchor + import_line, 1), encoding="utf-8")

css_path.write_text(
    '''/* Expense summary drill-down cards: interactive, accessible and mobile-first. */
@media screen {
  [data-print-section="expense-summary"] .reports-summary-list {
    align-content: start;
  }

  [data-print-section="expense-summary"] .reports-summary-drilldown {
    align-items: center;
    appearance: none;
    background: var(--surface, #fff);
    border: 1px solid color-mix(in srgb, var(--border, #dfe5e1) 88%, white);
    border-radius: 11px;
    color: var(--text-primary, #102a1c);
    cursor: pointer;
    display: grid;
    font: inherit;
    gap: 9px;
    grid-template-columns: minmax(0, 1fr) auto 16px;
    min-height: 44px;
    padding: 9px 10px;
    text-align: start;
    transition: background 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease, transform 0.16s ease;
    width: 100%;
  }

  [data-print-section="expense-summary"] .reports-summary-drilldown span {
    color: var(--text-secondary, #667085);
    font-size: 0.78rem;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  [data-print-section="expense-summary"] .reports-summary-drilldown strong {
    color: var(--text-primary, #102a1c);
    font-size: 0.86rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  [data-print-section="expense-summary"] .reports-summary-drilldown svg {
    color: var(--brand-primary, #267d35);
    transition: transform 0.16s ease;
  }

  [data-print-section="expense-summary"] .reports-summary-drilldown:hover,
  [data-print-section="expense-summary"] .reports-summary-drilldown:focus-visible {
    background: color-mix(in srgb, var(--surface-tint, #f5faef) 75%, white);
    border-color: color-mix(in srgb, var(--brand-primary, #267d35) 40%, var(--border, #dfe5e1));
    box-shadow: 0 7px 18px rgba(20, 82, 43, 0.08);
    outline: none;
    transform: translateY(-1px);
  }

  [data-print-section="expense-summary"] .reports-summary-drilldown:hover svg,
  [data-print-section="expense-summary"] .reports-summary-drilldown:focus-visible svg {
    transform: translateX(2px);
  }

  [data-print-section="expense-summary"] .reports-summary-drilldown:active {
    box-shadow: none;
    transform: scale(0.995);
  }
}

@media screen and (max-width: 640px) {
  [data-print-section="expense-summary"] .reports-summary-drilldown {
    min-height: 48px;
    padding: 10px 11px;
  }
}

[dir="rtl"] [data-print-section="expense-summary"] .reports-summary-drilldown svg {
  transform: scaleX(-1);
}

[dir="rtl"] [data-print-section="expense-summary"] .reports-summary-drilldown:hover svg,
[dir="rtl"] [data-print-section="expense-summary"] .reports-summary-drilldown:focus-visible svg {
  transform: scaleX(-1) translateX(2px);
}
''',
    encoding="utf-8",
)
