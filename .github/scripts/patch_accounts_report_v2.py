from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
REPORTS = ROOT / "web/src/pages/workspace/Reports.tsx"
PARTNER = ROOT / "web/src/lib/partnerAccounting.ts"
MAIN = ROOT / "web/src/main.tsx"


def sub(text, pattern, replacement, label, flags=re.S):
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, got {count}")
    return updated


def rep(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, got {count}")
    return text.replace(old, new, 1)


p = PARTNER.read_text()
r = REPORTS.read_text()
m = MAIN.read_text()

p = sub(p, r"export function mergePartnerPositionWithCanonical\([\s\S]*?\n}\n\nexport function resolveCanonicalPartnerPosition", '''export function mergePartnerPositionWithCanonical(
  legacy: PartnerLiabilityPosition,
  canonical?: CanonicalPartnerPosition | null,
): PartnerLiabilityPosition {
  if (!canonical) return legacy;
  const nonLabourBalance = legacy.currentPartnerBalance - legacy.labourAdvancesPaid;
  const restoredAppliedAdvances = canonical.appliedLabourAdvances;
  const partnerBalance = canonical.farmOwesPartner + restoredAppliedAdvances;
  const ledgerBalance = canonical.ledgerBalance + restoredAppliedAdvances;
  return {
    ...legacy,
    directExpensesPaid: legacy.purchaseVouchersPaid + canonical.labourAdvancesPaid + canonical.directLabourPayments,
    labourAdvancesPaid: canonical.labourAdvancesPaid,
    labourPayments: canonical.labourPayments,
    totalLabourAdvancesPaid: canonical.labourAdvancesPaid,
    labourWageSettlements: canonical.directLabourPayments,
    labourSettlementCashPaid: canonical.directLabourPayments,
    labourSettlementNonCashApplied: canonical.appliedLabourAdvances,
    settledAdvances: canonical.appliedLabourAdvances,
    outstandingLabourAdvances: canonical.outstandingLabourAdvances,
    moneyReturned: canonical.recoveries,
    currentPartnerBalance: nonLabourBalance + partnerBalance,
    reconciliationDifference: partnerBalance - ledgerBalance,
    reconciliationDelta: partnerBalance - ledgerBalance,
    isConsistent: Math.abs(partnerBalance - ledgerBalance) < 0.01,
  };
}

export function resolveCanonicalPartnerPosition''', "partner merge")

p = sub(p, r"export function buildCanonicalPartnerLiabilityPosition\([\s\S]*?\n}\n\nexport function groupPartnerLiabilityTransactions", '''export function buildCanonicalPartnerLiabilityPosition(
  canonical: CanonicalPartnerPosition,
  account: Account | null,
): PartnerLiabilityPosition {
  const restoredAppliedAdvances = canonical.appliedLabourAdvances;
  const partnerBalance = canonical.farmOwesPartner + restoredAppliedAdvances;
  const ledgerBalance = canonical.ledgerBalance + restoredAppliedAdvances;
  return {
    account,
    key: canonical.accountId,
    name: canonical.accountName,
    openingBalance: 0,
    capitalInjected: 0,
    directExpensesPaid: canonical.labourAdvancesPaid + canonical.directLabourPayments,
    purchaseVouchersPaid: 0,
    businessFundsNet: 0,
    labourAdvancesPaid: canonical.labourAdvancesPaid,
    labourPayments: canonical.labourPayments,
    labourWageSettlements: canonical.directLabourPayments,
    labourSettlementCashPaid: canonical.directLabourPayments,
    labourSettlementNonCashApplied: canonical.appliedLabourAdvances,
    totalLabourAdvancesPaid: canonical.labourAdvancesPaid,
    settledAdvances: canonical.appliedLabourAdvances,
    outstandingLabourAdvances: canonical.outstandingLabourAdvances,
    reconciliationDifference: partnerBalance - ledgerBalance,
    isConsistent: Math.abs(partnerBalance - ledgerBalance) < 0.01,
    transfersIn: 0,
    transfersOut: 0,
    moneyReturned: canonical.recoveries,
    adjustments: 0,
    currentPartnerBalance: partnerBalance,
    reconciliationDelta: partnerBalance - ledgerBalance,
  };
}

export function groupPartnerLiabilityTransactions''', "canonical partner position")

r = rep(r, '''  const activeSettlements = useMemo(
    () => getActiveLabourWageSettlements(labourWageSettlements)
      .filter((settlement) => !from || settlement.settlementDate >= from)
      .filter((settlement) => !to || settlement.settlementDate <= to),
    [from, labourWageSettlements, to],
  );''', '''  const allActiveSettlements = useMemo(() => getActiveLabourWageSettlements(labourWageSettlements), [labourWageSettlements]);
  const activeSettlements = useMemo(
    () => allActiveSettlements
      .filter((settlement) => !from || settlement.settlementDate >= from)
      .filter((settlement) => !to || settlement.settlementDate <= to),
    [allActiveSettlements, from, to],
  );''', "settlement scopes")
r = rep(r, 'selectDedupedExpenseVouchers(activeVouchers, activeSettlements, replacedLegacySourceIds)', 'selectDedupedExpenseVouchers(activeVouchers, allActiveSettlements, replacedLegacySourceIds)', "dedupe scope")
r = rep(r, '[activeSettlements, activeVouchers, replacedLegacySourceIds]', '[allActiveSettlements, activeVouchers, replacedLegacySourceIds]', "dedupe deps")

r = rep(r, '''  const partnerRows = entries
    .filter((item) => isActiveOperationalRecord(item)
      && (!accountId || item.accountId === accountId || item.fromAccountId === accountId || item.toAccountId === accountId)
      && matches(item.date, [item.partnerName, item.fromPartner, item.toPartner, item.type, item.notes], item.amount))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const saleRows = sales
    .filter((item) => isActiveOperationalRecord(item)
      && (!accountId || item.accountId === accountId)
      && (!saleTypeFilter || saleTypeFilter === "all" || resolveSaleType(item) === saleTypeFilter)
      && matches(item.date, [item.buyerName, item.invoiceNumber, saleProduceLabel(item), saleTypeLabel(item), item.dispatchDate, item.vehicleNumber, accountName(item.accountId), item.paymentDate], item.amount))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));''', '''  const allActivePartnerRows = useMemo(() => entries.filter(isActiveOperationalRecord).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)), [entries]);
  const partnerRows = allActivePartnerRows.filter((item) => (!accountId || item.accountId === accountId || item.fromAccountId === accountId || item.toAccountId === accountId) && matches(item.date, [item.partnerName, item.fromPartner, item.toPartner, item.type, item.notes], item.amount));
  const allActiveSaleRows = useMemo(() => sales.filter(isActiveOperationalRecord).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)), [sales]);
  const saleRows = allActiveSaleRows.filter((item) => (!accountId || item.accountId === accountId) && (!saleTypeFilter || saleTypeFilter === "all" || resolveSaleType(item) === saleTypeFilter) && matches(item.date, [item.buyerName, item.invoiceNumber, saleProduceLabel(item), saleTypeLabel(item), item.dispatchDate, item.vehicleNumber, accountName(item.accountId), item.paymentDate], item.amount));''', "all-time rows")

start = r.index('  const positions = useMemo(() => accounts')
end = r.index('  const partnerLiabilityPositions = useMemo(() => {', start)
block = r[start:end].replace('partnerRows', 'allActivePartnerRows').replace('saleRows', 'allActiveSaleRows').replace('activeSettlements, accounts', 'allActiveSettlements, accounts').replace('activeSettlements, canonicalLabourAccountEntries', 'allActiveSettlements, canonicalLabourAccountEntries')
r = r[:start] + block + r[end:]
r = rep(r, 'buildPartnerLiabilityPositions(accounts, cashAffectingVouchers, [], partnerRows, saleRows, [])', 'buildPartnerLiabilityPositions(accounts, cashAffectingVouchers, [], allActivePartnerRows, allActiveSaleRows, [])', "partner position scope")
r = rep(r, '[accountId, accountLookup, accounts, canonicalFinancials.data?.partnerPositions, cashAffectingVouchers, partnerRows, saleRows]', '[accountId, accountLookup, accounts, allActivePartnerRows, allActiveSaleRows, canonicalFinancials.data?.partnerPositions, cashAffectingVouchers]', "partner position deps")
r = rep(r, 'getPartnerAccountingSnapshot(selectedAccountRecord, saleRows, cashAffectingVouchers, [], partnerRows, [], accounts)', 'getPartnerAccountingSnapshot(selectedAccountRecord, allActiveSaleRows, cashAffectingVouchers, [], allActivePartnerRows, [], accounts)', "snapshot scope")
r = rep(r, '[accountLookup, accounts, canonicalFinancials.data?.partnerPositions, cashAffectingVouchers, partnerRows, saleRows, selectedAccountRecord]', '[accountLookup, accounts, allActivePartnerRows, allActiveSaleRows, canonicalFinancials.data?.partnerPositions, cashAffectingVouchers, selectedAccountRecord]', "snapshot deps")

r = rep(r, '  const selectedAccountRecord = accountId ? accounts.find((item) => item.id === accountId) ?? null : null;', '''  const displayedPositions = useMemo(() => positions.map((item) => {
    if (item.account.type !== "partner") return item;
    const canonicalId = resolveCanonicalAccountId(item.account.id, accountLookup) ?? item.account.id;
    const partner = partnerLiabilityPositions.find((position) => position.key === canonicalId || position.account?.id === item.account.id);
    return partner ? { ...item, net: partner.currentPartnerBalance } : item;
  }), [accountLookup, partnerLiabilityPositions, positions]);
  const selectedAccountRecord = accountId ? accounts.find((item) => item.id === accountId) ?? null : null;''', "displayed positions")
r = rep(r, 'const currentLedgerBalance = selectedAccountRecord ? positions.find((item) => item.account.id === selectedAccountRecord.id)?.net ?? 0', 'const currentLedgerBalance = selectedAccountRecord ? displayedPositions.find((item) => item.account.id === selectedAccountRecord.id)?.net ?? 0', "current balance")
r = r.replace('...positions.map((item) => [item.account.name, item.voucherExpenses', '...displayedPositions.map((item) => [item.account.name, item.voucherExpenses', 1)
r = r.replace('<div className="reports-kpis">{positions.map((item) => <article', '<div className="reports-kpis account-balance-list">{displayedPositions.map((item) => <article', 1)

r = rep(r, '''      const fallbackAccountId = accounts.find((account) => account.name === row.accountName)?.id ?? null;
      const resolvedAccountId = resolveCanonicalAccountId(rawAccountId ?? fallbackAccountId, accountLookup) ?? rawAccountId ?? fallbackAccountId;''', '''      const fallbackAccountId = accounts.find((account) => account.name.trim().toLowerCase() === row.accountName.trim().toLowerCase())?.id ?? null;
      const resolvedAccountId = resolveCanonicalAccountId(rawAccountId, accountLookup) ?? resolveCanonicalAccountId(fallbackAccountId, accountLookup) ?? fallbackAccountId ?? rawAccountId;''', "attribution identity")
r = rep(r, '''      const fallbackAccountId = accounts.find((account) => account.name === sourceName)?.id ?? null;
      const resolvedAccountId = resolveCanonicalAccountId(rawAccountId ?? fallbackAccountId, accountLookup) ?? rawAccountId ?? fallbackAccountId;''', '''      const fallbackAccountId = accounts.find((account) => account.name.trim().toLowerCase() === sourceName.trim().toLowerCase())?.id ?? null;
      const resolvedAccountId = resolveCanonicalAccountId(rawAccountId, accountLookup) ?? resolveCanonicalAccountId(fallbackAccountId, accountLookup) ?? fallbackAccountId ?? rawAccountId;''', "summary identity")

start = r.index('          {isPartnerLedgerReport && partnerAccountLedgerOverviewView\n            ? <>')
end = r.index('            : <Kpis values={[', start)
branch = '''          {isPartnerLedgerReport && partnerAccountLedgerOverviewView
            ? <>
              <section className={`account-ledger-hero account-ledger-hero--${getPartnerBalanceState(currentLedgerBalance)}`}>
                <div><small>{t("reportsPage.partnerAccount", { defaultValue: "Partner account" })}</small><h3>{selectedAccountRecord?.name ?? t("reportsPage.allAccounts")}</h3><span>{getPartnerBalanceState(currentLedgerBalance) === "partner_holds_business_money" ? t("reportsPage.partnerHoldsBusinessMoney") : getPartnerBalanceState(currentLedgerBalance) === "settled" ? t("reportsPage.settled", { defaultValue: "Settled" }) : t("reportsPage.farmOwesPartner")}</span></div>
                <strong>{money(Math.abs(currentLedgerBalance))}</strong>
              </section>
              <div className="account-ledger-metric-grid">
                <article className="account-ledger-metric account-ledger-metric--wide"><header><span>{t("reportsPage.directExpensesPaid")}</span><strong>{money(partnerAccountLedgerOverviewView.directExpensesPaid)}</strong></header><dl><div><dt>{t("reportsPage.purchaseVouchersColumn")}</dt><dd>{money(partnerAccountLedgerOverviewView.purchaseVouchersPaid)}</dd></div><div><dt>{t("reportsPage.totalLabourAdvancesPaidColumn")}</dt><dd>{money(partnerAccountLedgerOverviewView.labourAdvancesPaid)}</dd></div><div><dt>{t("reportsPage.adjustedInSettlements")}</dt><dd>{money(partnerAccountLedgerOverviewView.labourSettlementNonCashApplied)}</dd></div><div><dt>{t("reportsPage.outstandingLabourAdvancesColumn")}</dt><dd>{money(partnerAccountLedgerOverviewView.outstandingLabourAdvances)}</dd></div></dl><p>{t("reportsPage.appliedAdvancePartnerLiabilityNote", { defaultValue: "Applied advances reduce labour outstanding only; they remain owed to the funding partner." })}</p></article>
                <article className="account-ledger-metric"><span>{t("reportsPage.capitalInjected")}</span><strong>{money(partnerAccountLedgerOverviewView.capitalInjected)}</strong></article>
                <article className="account-ledger-metric"><span>{t("reportsPage.transfersOut")}</span><strong>{money(partnerAccountLedgerOverviewView.transfersOut)}</strong></article>
                <article className="account-ledger-metric"><span>{t("reportsPage.transfersIn")}</span><strong>{money(partnerAccountLedgerOverviewView.transfersIn)}</strong></article>
                <article className="account-ledger-metric"><span>{t("reportsPage.moneyReturned")}</span><strong>{money(partnerAccountLedgerOverviewView.moneyReturned)}</strong></article>
                <article className="account-ledger-metric"><span>{t("reportsPage.adjustments")}</span><strong>{money(partnerAccountLedgerOverviewView.adjustments)}</strong></article>
              </div>
              <details className={`account-ledger-reconciliation account-ledger-reconciliation--compact${showReportLedgerWarning ? " is-warning" : ""}`} open={showReportLedgerWarning || undefined}><summary><span>{t("reportsPage.reconciliationTitle")}</span><strong>{showReportLedgerWarning ? t("reportsPage.needsReview", { defaultValue: "Needs review" }) : t("reportsPage.reconciled", { defaultValue: "Reconciled" })}</strong></summary><div className="account-ledger-reconciliation__rows"><div><span>{t("reportsPage.capitalInjected")}</span><strong>{money(partnerAccountLedgerOverviewView.capitalInjected)}</strong></div><div><span>+ {t("reportsPage.directExpensesPaid")}</span><strong>{money(partnerAccountLedgerOverviewView.directExpensesPaid)}</strong></div><div><span>+ {t("reportsPage.transfersOut")}</span><strong>{money(partnerAccountLedgerOverviewView.transfersOut)}</strong></div><div><span>- {t("reportsPage.transfersIn")}</span><strong>{money(partnerAccountLedgerOverviewView.transfersIn)}</strong></div><div><span>- {t("reportsPage.moneyReturned")}</span><strong>{money(partnerAccountLedgerOverviewView.moneyReturned)}</strong></div><div><span>+/- {t("reportsPage.adjustments")}</span><strong>{money(partnerAccountLedgerOverviewView.adjustments)}</strong></div><div className="account-ledger-reconciliation__total"><span>= {t("reportsPage.reconciliationComputed")}</span><strong>{money(partnerAccountLedgerOverviewView.netBalance)}</strong></div></div>{showReportLedgerWarning && <p className="worker-action-warning">{t("reportsPage.reconciliationComponentsWarning")}</p>}</details>
            </>
'''
r = r[:start] + branch + r[end:]
r = r.replace('{showReportLedgerWarning && <p className="worker-action-warning">{t("reportsPage.groupedReconciliationWarning", { delta: money(reportLedgerDelta) })}</p>}', '{showReportLedgerWarning && !isPartnerLedgerReport && <p className="worker-action-warning">{t("reportsPage.groupedReconciliationWarning", { delta: money(reportLedgerDelta) })}</p>}', 1)

m = rep(m, 'import "./reports-account-polish.css";\n', 'import "./reports-account-polish.css";\nimport "./accounts-report-v2.css";\n', "css import")

REPORTS.write_text(r)
PARTNER.write_text(p)
MAIN.write_text(m)
Path(__file__).unlink()
