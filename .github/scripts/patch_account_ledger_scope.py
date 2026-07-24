from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
P = ROOT / "web/src/pages/workspace/Reports.tsx"
s = P.read_text()


def rep(old, new, label):
    global s
    count = s.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, got {count}")
    s = s.replace(old, new, 1)


rep('? activeSettlements.find((item) => item.id === voucher.settlementId || item.id === voucher.id)', '? allActiveSettlements.find((item) => item.id === voucher.settlementId || item.id === voucher.id)', 'settlement lookup')
rep('    for (const sale of saleRows) rows.push({', '    for (const sale of allActiveSaleRows) rows.push({', 'all sales')
rep('    for (const entry of partnerRows) {', '    for (const entry of allActivePartnerRows) {', 'all partner rows')
rep('''    const running = new Map<string, number>();
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
  );''', '''    const selectedLedgerAccountId = accountId ? resolveCanonicalAccountId(accountId, accountLookup) ?? accountId : "";
    const running = new Map<string, number>();
    return rows
      .map((item) => {
        const canonicalItemAccountId = resolveCanonicalAccountId(item.accountId, accountLookup) ?? item.accountId;
        return { ...item, accountId: canonicalItemAccountId, accountName: item.accountName || accountName(canonicalItemAccountId) };
      })
      .filter((item) => !selectedLedgerAccountId || item.accountId === selectedLedgerAccountId)
      .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
      .map((item) => {
        const next = (running.get(item.accountId) ?? 0) + item.credit - item.debit;
        running.set(item.accountId, next);
        return { ...item, running: next };
      });
  }, [accountId, accountLookup, accountName, accountById, accountingAdvanceRows, accounts, allActivePartnerRows, allActiveSaleRows, allActiveSettlements, canonicalAccountLedgerEntries, cashAffectingVouchers, labourName, t]);
  const filteredAccountLedgerRows = useMemo(() => accountLedgerRows.filter((item) => matches(
    item.date,
    [item.accountName, item.typeLabel, item.reference, item.description, item.counterparty],
    Math.abs(item.memoAmount ?? item.credit - item.debit),
  )), [accountLedgerRows, matches]);
  const allGroupedAccountLedgerRows = useMemo(() => groupAccountTransactions(accountLedgerRows), [accountLedgerRows]);
  const allGroupedPartnerLedgerRows = useMemo(
    () => selectedAccountRecord?.type === "partner" ? groupPartnerLiabilityTransactions(accountLedgerRows) : [],
    [accountLedgerRows, selectedAccountRecord],
  );
  const groupedAccountLedgerRows = useMemo(() => groupAccountTransactions(filteredAccountLedgerRows), [filteredAccountLedgerRows]);
  const groupedPartnerLedgerRows = useMemo(
    () => selectedAccountRecord?.type === "partner" ? groupPartnerLiabilityTransactions(filteredAccountLedgerRows) : [],
    [filteredAccountLedgerRows, selectedAccountRecord],
  );''', 'ledger grouping')
rep('    for (const group of groupedPartnerLedgerRows) {', '    for (const group of allGroupedPartnerLedgerRows) {', 'partner summary')
rep('  }, [groupedPartnerLedgerRows, selectedAccountRecord, selectedPartnerSnapshot]);', '  }, [allGroupedPartnerLedgerRows, selectedAccountRecord, selectedPartnerSnapshot]);', 'partner summary deps')
rep('    for (const group of groupedAccountLedgerRows) {', '    for (const group of allGroupedAccountLedgerRows) {', 'standard summary')
rep('  }, [groupedAccountLedgerRows]);', '  }, [allGroupedAccountLedgerRows]);', 'standard summary deps')

P.write_text(s)
Path(__file__).unlink()
