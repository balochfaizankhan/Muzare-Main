import type { Account, Advance, LabourWageSettlement, PartnerEntry, Sale, Voucher } from "./offline-db";
import { isActiveOperationalRecord } from "./operationalRecords";
import { getActiveVouchers } from "./voucherCollections";
import { getLabourWageSettlementCashPaidAmount, isLabourWageSettlementVoucher, resolveLabourWageSettlementAccountId } from "./labourWageSettlements";
import { buildAccountIdentityLookup, resolveAccountIdentity, resolveCanonicalAccountId, type AccountIdentityLookup, type AccountIdentityLike, type AccountIdentityResolution } from "./accountIdentity";

export type PartnerLiabilityPosition = {
  account: Account | null;
  key: string;
  name: string;
  openingBalance: number;
  capitalInjected: number;
  directExpensesPaid: number;
  purchaseVouchersPaid: number;
  businessFundsNet: number;
  labourAdvancesPaid: number;
  labourWageSettlements: number;
  labourSettlementCashPaid: number;
  labourSettlementNonCashApplied: number;
  totalLabourAdvancesPaid: number;
  outstandingLabourAdvances: number;
  transfersIn: number;
  transfersOut: number;
  moneyReturned: number;
  adjustments: number;
  currentPartnerBalance: number;
  reconciliationDelta: number;
};

export type PartnerAccountingRowBreakdown = {
  purchaseVouchers: Array<{
    voucherId: string;
    voucherNumber?: string;
    date: string;
    amount: number;
    paymentAccountId?: string | null;
    expenseAccountId?: string | null;
    resolvedPaymentAccountId?: string | null;
    sourceAccountName?: string | null;
    farmId?: string | null;
    seasonId?: string | null;
    status?: string | null;
    deleted: boolean;
    voided: boolean;
    reversed: boolean;
    included: boolean;
    includedByCanonicalId: boolean;
    includedByAlias: boolean;
    includedByNameFallback: boolean;
    excludedReason: string | null;
  }>;
  funds: Array<{
    transactionId: string;
    date: string;
    amount: number;
    direction: "given" | "received" | "other";
    accountId: string | null;
    resolvedAccountId: string | null;
    fromAccountId: string | null;
    toAccountId: string | null;
    fromPartnerId: string | null;
    toPartnerId: string | null;
    partnerId: string | null;
    resolvedFromAccountId: string | null;
    resolvedToAccountId: string | null;
    fromResolution: PartnerTransferAccountResolution;
    toResolution: PartnerTransferAccountResolution;
    farmId: string | null;
    seasonId: string | null;
    status: string | null;
    deleted: boolean;
    voided: boolean;
    reversed: boolean;
    included: boolean;
    includedByCanonicalId: boolean;
    includedByAlias: boolean;
    includedByNameFallback: boolean;
    excludedReason: string | null;
  }>;
  advances: Array<{
    advanceId: string;
    date: string;
    amount: number;
    accountId: string | null;
    resolvedAccountId: string | null;
    sourceAccountName: string | null;
    farmId: string | null;
    seasonId: string | null;
    deleted: boolean;
    voided: boolean;
    reversed: boolean;
    included: boolean;
    includedByCanonicalId: boolean;
    includedByAlias: boolean;
    includedByNameFallback: boolean;
    excludedReason: string | null;
  }>;
  settlements: Array<{
    settlementId: string;
    settlementNumber: string;
    date: string;
    status: string;
    deleted: boolean;
    voided: boolean;
    reversed: boolean;
    totalLabourCost: number;
    advancesApplied: number;
    settledAdvanceAmount: number;
    cashPaid: number;
    carryForwardAdvance: number;
    accountId: string | null;
    resolvedAccountId: string | null;
    farmId: string | null;
    seasonId: string | null;
    included: boolean;
    includedByCanonicalId: boolean;
    includedByAlias: boolean;
    includedByNameFallback: boolean;
    excludedReason: string | null;
  }>;
};

export type PartnerAccountingSnapshot = PartnerLiabilityPosition & {
  fundsGiven: number;
  fundsReceived: number;
  labourAdvancesSettledThroughWageSettlements: number;
  labourSettlementCashPaid: number;
  labourSettlementNonCashApplied: number;
  moneyReturned: number;
  adjustment: number;
  farmOwesPartner: number;
  reconciliationLines: string[];
  rowBreakdown: PartnerAccountingRowBreakdown;
  mismatchDiagnostics: {
    includedByAliasCount: number;
    includedByNameFallbackCount: number;
    unmappedCount: number;
    deletedIncludedCount: number;
    voidedIncludedCount: number;
  };
};

export type PartnerBalanceState = "farm_owes_partner" | "partner_holds_business_money" | "settled";
export type PartnerTransferAccountSide = "from" | "to";
export type PartnerTransferAccountResolution = AccountIdentityResolution & {
  sourceField: string | null;
  rawValue: string | null;
};

export type PartnerLiabilityLedgerGroupKey =
  | "capital_injected"
  | "purchase_vouchers_paid"
  | "labour_advances_paid"
  | "labour_wage_settlements"
  | "transfers_in"
  | "transfers_out"
  | "money_returned"
  | "adjustments"
  | "other";

export type PartnerLiabilityGroupableTransaction = {
  id: string;
  date: string;
  debit: number;
  credit: number;
  partnerLiabilityGroup?: PartnerLiabilityLedgerGroupKey;
};

export type PartnerLiabilityLedgerGroup<T extends PartnerLiabilityGroupableTransaction> = {
  groupKey: PartnerLiabilityLedgerGroupKey;
  transactions: T[];
  totalAmount: number;
  debitTotal: number;
  creditTotal: number;
  count: number;
};

export const partnerLiabilityGroupOrder: PartnerLiabilityLedgerGroupKey[] = [
  "capital_injected",
  "purchase_vouchers_paid",
  "labour_advances_paid",
  "labour_wage_settlements",
  "transfers_in",
  "transfers_out",
  "money_returned",
  "adjustments",
  "other",
];

export const defaultPartnerLiabilityGroupExpansion = (): Record<PartnerLiabilityLedgerGroupKey, boolean> => ({
  capital_injected: true,
  purchase_vouchers_paid: true,
  labour_advances_paid: true,
  labour_wage_settlements: true,
  transfers_in: true,
  transfers_out: true,
  money_returned: true,
  adjustments: true,
  other: false,
});

const normalized = (value: string) => value.trim().toLowerCase();

export function calculatePartnerLiabilityBalance(position: Pick<PartnerLiabilityPosition, "openingBalance" | "capitalInjected" | "directExpensesPaid" | "transfersIn" | "transfersOut" | "moneyReturned" | "adjustments">) {
  return position.openingBalance
    + position.capitalInjected
    + position.directExpensesPaid
    + position.transfersOut
    - position.transfersIn
    - position.moneyReturned
    + position.adjustments;
}

export function partnerAdjustmentEffect(entry: Pick<PartnerEntry, "amount" | "adjustmentDirection">) {
  return entry.adjustmentDirection === "decrease" ? -entry.amount : entry.amount;
}

export function getPartnerBalanceState(balance: number): PartnerBalanceState {
  if (balance > 0.009) return "farm_owes_partner";
  if (balance < -0.009) return "partner_holds_business_money";
  return "settled";
}

export function partnerLiabilityGroupDisplayTotal(groupKey: PartnerLiabilityLedgerGroupKey, totalAmount: number) {
  if (groupKey === "transfers_in" || groupKey === "money_returned") return Math.abs(totalAmount);
  return totalAmount;
}

export const isPartnerAccount = (account?: Account | null) => account?.type === "partner";

export function resolvePartnerAccountId(entry: Pick<PartnerEntry, "partnerAccountId" | "partnerName">, accounts: Account[]) {
  const lookup = buildAccountIdentityLookup(accounts);
  const resolved = resolveCanonicalAccountId(entry.partnerAccountId ?? null, lookup);
  if (resolved && lookup.byId.get(resolved)?.type === "partner") return resolved;
  const name = entry.partnerName?.trim();
  if (!name) return undefined;
  const matches = accounts.filter((account) => account.type === "partner" && normalized(account.name) === normalized(name));
  return matches.length === 1 ? matches[0]!.id : undefined;
}

function firstStringValue(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function resolvePartnerTransferAccountIdentity(
  entry: Record<string, unknown>,
  side: PartnerTransferAccountSide,
  accounts: AccountIdentityLike[] | AccountIdentityLookup,
): PartnerTransferAccountResolution {
  const lookup = Array.isArray(accounts) ? buildAccountIdentityLookup(accounts) : accounts;
  const keys = side === "from"
    ? ["fromAccountId", "fromPartnerId", "partnerId", "partnerAccountId", "accountId"]
    : ["toAccountId", "toPartnerId", "partnerId", "partnerAccountId", "accountId"];
  const rawValue = firstStringValue(entry, keys);
  if (rawValue) {
    const resolved = resolveAccountIdentity(rawValue, lookup, firstStringValue(entry, ["partnerName", "fromPartner", "toPartner"]));
    if (resolved.canonicalAccountId) {
      const sourceField = keys.find((key) => typeof entry[key] === "string" && (entry[key] as string).trim() === rawValue) ?? null;
      return { ...resolved, sourceField, rawValue };
    }
  }
  return {
    canonicalAccountId: null,
    matchedBy: "unmatched",
    matchedAccount: null,
    needsAccountMappingRepair: Boolean(rawValue),
    sourceField: rawValue ? keys.find((key) => typeof entry[key] === "string" && (entry[key] as string).trim() === rawValue) ?? null : null,
    rawValue,
  };
}

function settlementStatusFlags(settlement: Pick<LabourWageSettlement, "status" | "deletedAt" | "voidedAt" | "accountingStatus">) {
  const deleted = Boolean(settlement.deletedAt) || settlement.status === "deleted" || settlement.accountingStatus === "deleted";
  const voided = Boolean(settlement.voidedAt) || settlement.status === "voided" || settlement.accountingStatus === "voided";
  const reversed = false;
  return { deleted, voided, reversed };
}

export function getPartnerAccountingSnapshot(
  account: Account,
  sales: Sale[],
  vouchers: Voucher[],
  advances: Advance[],
  entries: PartnerEntry[],
  settlements: LabourWageSettlement[],
  allAccounts: Account[],
  options: { farmId?: string | null; seasonId?: string | null } = {},
): PartnerAccountingSnapshot {
  const accountLookup = buildAccountIdentityLookup(allAccounts);
  const farmId = options.farmId ?? null;
  const seasonId = options.seasonId ?? null;
  const farmMatches = (rowFarmId: string | null) => !farmId || rowFarmId === farmId || rowFarmId === null;
  const seasonMatches = (rowSeasonId: string | null) => !seasonId || rowSeasonId === seasonId || rowSeasonId === null;
  const purchaseVouchers = getActiveVouchers(vouchers).map((voucher) => {
    const resolvedPaymentAccountId = resolveCanonicalAccountId(voucher.accountId, accountLookup);
    const included = !isLabourWageSettlementVoucher(voucher) && resolvedPaymentAccountId === account.id;
    return {
      voucherId: voucher.id,
      voucherNumber: voucher.voucherNumber,
      date: voucher.date,
      amount: voucher.amount,
      paymentAccountId: voucher.accountId,
      expenseAccountId: null,
      resolvedPaymentAccountId,
      sourceAccountName: null,
      farmId: voucher.farmId,
      seasonId: voucher.seasonId,
      status: "posted",
      deleted: Boolean(voucher.deletedAt),
      voided: false,
      reversed: false,
      included,
      includedByCanonicalId: included && resolvedPaymentAccountId === account.id,
      includedByAlias: false,
      includedByNameFallback: false,
      excludedReason: included ? null : "Voucher is not linked to the selected account.",
    };
  });
  const funds = entries.map((entry) => {
    const resolvedAccountId = resolveCanonicalAccountId(entry.accountId ?? null, accountLookup) ?? resolvePartnerAccountId(entry, allAccounts) ?? null;
    const fromResolution = resolvePartnerTransferAccountIdentity(entry as Record<string, unknown>, "from", accountLookup);
    const toResolution = resolvePartnerTransferAccountIdentity(entry as Record<string, unknown>, "to", accountLookup);
    const direction: "given" | "received" | "other" = entry.type === "settlement"
      ? (toResolution.canonicalAccountId === account.id ? "received" : fromResolution.canonicalAccountId === account.id ? "given" : "other")
      : "other";
    const included = isActiveOperationalRecord(entry) && farmMatches(entry.farmId ?? null) && seasonMatches(entry.seasonId ?? null) && (
      (entry.type === "settlement" && (fromResolution.canonicalAccountId === account.id || toResolution.canonicalAccountId === account.id))
      || entry.type === "contribution"
      || entry.type === "withdrawal"
      || entry.type === "adjustment"
    );
    const excludedReason = included ? null : entry.type === "settlement"
      ? "Settlement is not linked to the selected account."
      : "Transaction is not linked to the selected account.";
    return {
      transactionId: entry.id,
      date: entry.date,
      amount: entry.amount,
      direction,
      accountId: entry.accountId ?? null,
      resolvedAccountId,
      fromAccountId: firstStringValue(entry as Record<string, unknown>, ["fromAccountId", "fromPartnerId", "partnerId", "partnerAccountId"]),
      toAccountId: firstStringValue(entry as Record<string, unknown>, ["toAccountId", "toPartnerId", "partnerId", "partnerAccountId"]),
      fromPartnerId: firstStringValue(entry as Record<string, unknown>, ["fromPartnerId"]),
      toPartnerId: firstStringValue(entry as Record<string, unknown>, ["toPartnerId"]),
      partnerId: firstStringValue(entry as Record<string, unknown>, ["partnerId"]),
      farmId: entry.farmId ?? null,
      seasonId: entry.seasonId ?? null,
      status: "posted",
      deleted: Boolean(entry.deletedAt),
      voided: false,
      reversed: false,
      included,
      includedByCanonicalId: included && (fromResolution.matchedBy === "canonical" || toResolution.matchedBy === "canonical"),
      includedByAlias: included && (fromResolution.matchedBy === "alias" || toResolution.matchedBy === "alias"),
      includedByNameFallback: included && (fromResolution.matchedBy === "name_fallback" || toResolution.matchedBy === "name_fallback"),
      excludedReason,
      resolvedFromAccountId: fromResolution.canonicalAccountId,
      resolvedToAccountId: toResolution.canonicalAccountId,
      fromResolution,
      toResolution,
    };
  });
  const advanceRows = advances.map((advance) => {
    const resolved = resolveAccountIdentity(advance.accountId ?? null, accountLookup, advance.sourceAccountName ?? null);
    const included = isActiveOperationalRecord(advance) && !advance.deletedAt && resolved.canonicalAccountId === account.id && farmMatches(advance.farmId ?? null) && seasonMatches(advance.seasonId ?? null);
    return {
      advanceId: advance.id,
      date: advance.date,
      amount: advance.amount,
      accountId: advance.accountId ?? null,
      resolvedAccountId: resolved.canonicalAccountId,
      sourceAccountName: advance.sourceAccountName ?? null,
      farmId: advance.farmId ?? null,
      seasonId: advance.seasonId ?? null,
      deleted: Boolean(advance.deletedAt),
      voided: false,
      reversed: false,
      included,
      includedByCanonicalId: included && resolved.matchedBy === "canonical",
      includedByAlias: included && resolved.matchedBy === "alias",
      includedByNameFallback: included && resolved.matchedBy === "name_fallback",
      excludedReason: included ? null : resolved.canonicalAccountId !== account.id ? "Advance belongs to another account." : "Advance is deleted or outside filters.",
    };
  });
  const settlementRows = settlements.map((settlement) => {
    const flags = settlementStatusFlags(settlement);
    const resolvedAccountId = resolveCanonicalAccountId(resolveLabourWageSettlementAccountId(settlement as unknown as { linkedAccountId?: unknown; paymentAccountId?: unknown; accountId?: unknown }) ?? null, accountLookup);
    const included = isActiveOperationalRecord(settlement) && settlement.status === "posted" && !flags.deleted && !flags.voided && resolvedAccountId === account.id;
    return {
      settlementId: settlement.id,
      settlementNumber: settlement.settlementNumber,
      date: settlement.settlementDate,
      status: settlement.status,
      deleted: flags.deleted,
      voided: flags.voided,
      reversed: flags.reversed,
      totalLabourCost: settlement.totalEarned,
      advancesApplied: settlement.advancesPaid,
      settledAdvanceAmount: settlement.settledAdvanceAmount,
      cashPaid: getLabourWageSettlementCashPaidAmount(settlement),
      carryForwardAdvance: settlement.carryForwardAdvance,
      accountId: settlement.linkedAccountId,
      resolvedAccountId,
      farmId: settlement.farmId ?? null,
      seasonId: settlement.seasonId ?? null,
      included,
      includedByCanonicalId: included && settlement.status === "posted" && resolvedAccountId === account.id,
      includedByAlias: false,
      includedByNameFallback: false,
      excludedReason: included ? null : "Settlement is deleted, voided, or not linked to the selected account.",
    };
  });
  if (typeof console !== "undefined" && import.meta.env.DEV) {
    for (const row of funds) {
      console.debug("PARTNER_ACCOUNTING_FUND_ROW", {
        id: row.transactionId,
        type: "settlement",
        fromPartnerId: row.fromPartnerId,
        toPartnerId: row.toPartnerId,
        partnerId: row.partnerId,
        amount: row.amount,
        farmId: row.farmId,
        seasonId: row.seasonId,
        included: row.included,
        excludedReason: row.excludedReason,
        resolvedFromAccountId: row.resolvedFromAccountId,
        resolvedToAccountId: row.resolvedToAccountId,
        includedByCanonicalId: row.includedByCanonicalId,
        includedByAlias: row.includedByAlias,
        includedByNameFallback: row.includedByNameFallback,
      });
    }
    for (const row of advanceRows) {
      console.debug("PARTNER_ACCOUNTING_ADVANCE_ROW", {
        id: row.advanceId,
        type: "advance",
        accountId: row.accountId,
        resolvedAccountId: row.resolvedAccountId,
        sourceAccountName: row.sourceAccountName,
        amount: row.amount,
        farmId: row.farmId,
        seasonId: row.seasonId,
        included: row.included,
        excludedReason: row.excludedReason,
        includedByCanonicalId: row.includedByCanonicalId,
        includedByAlias: row.includedByAlias,
        includedByNameFallback: row.includedByNameFallback,
      });
    }
    for (const row of settlementRows) {
      console.debug("PARTNER_ACCOUNTING_SETTLEMENT_ROW", {
        id: row.settlementId,
        settlementNumber: row.settlementNumber,
        type: "labour_wage_settlement",
        linkedAccountId: row.accountId,
        paymentAccountId: row.accountId,
        partnerId: row.accountId,
        amount: row.settledAdvanceAmount,
        farmId: row.farmId,
        seasonId: row.seasonId,
        included: row.included,
        excludedReason: row.excludedReason,
        resolvedAccountId: row.resolvedAccountId,
        includedByCanonicalId: row.includedByCanonicalId,
        includedByAlias: row.includedByAlias,
        includedByNameFallback: row.includedByNameFallback,
      });
    }
  }
  const totalLabourAdvancesPaid = advanceRows.filter((row) => row.included).reduce((sum, row) => sum + row.amount, 0);
  const labourAdvancesSettledThroughWageSettlements = settlementRows.filter((row) => row.included).reduce((sum, row) => sum + row.settledAdvanceAmount, 0);
  const outstandingLabourAdvances = Math.max(0, totalLabourAdvancesPaid - labourAdvancesSettledThroughWageSettlements);
  const labourSettlementCashPaid = settlementRows.filter((row) => row.included && row.cashPaid > 0).reduce((sum, row) => sum + row.cashPaid, 0);
  const labourSettlementNonCashApplied = labourAdvancesSettledThroughWageSettlements;

  const purchaseVouchersPaid = purchaseVouchers.filter((row) => row.included).reduce((sum, row) => sum + row.amount, 0);
  const fundsGiven = funds.filter((row) => row.included && row.direction === "given").reduce((sum, row) => sum + row.amount, 0);
  const fundsReceived = funds.filter((row) => row.included && row.direction === "received").reduce((sum, row) => sum + row.amount, 0);
  const moneyReturned = entries
    .filter((entry) => isActiveOperationalRecord(entry) && entry.type === "withdrawal" && resolveCanonicalAccountId(entry.partnerAccountId ?? entry.accountId ?? null, accountLookup) === account.id)
    .reduce((sum, entry) => sum + entry.amount, 0);
  const adjustment = entries
    .filter((entry) => isActiveOperationalRecord(entry) && entry.type === "adjustment" && resolveCanonicalAccountId(entry.partnerAccountId ?? entry.accountId ?? null, accountLookup) === account.id)
    .reduce((sum, entry) => sum + partnerAdjustmentEffect(entry), 0)
    - sales.filter((sale) => isActiveOperationalRecord(sale) && resolveCanonicalAccountId(sale.accountId, accountLookup) === account.id).reduce((sum, sale) => sum + sale.amount, 0);

  const capitalInjected = entries
    .filter((entry) => isActiveOperationalRecord(entry) && entry.type === "contribution" && resolveCanonicalAccountId(entry.partnerAccountId ?? entry.accountId ?? null, accountLookup) === account.id)
    .reduce((sum, entry) => sum + entry.amount, 0);

  const farmOwesPartner = purchaseVouchersPaid
    + fundsGiven
    - fundsReceived
    + outstandingLabourAdvances
    + labourSettlementCashPaid
    + adjustment
    - moneyReturned;

  const currentPartnerBalance = farmOwesPartner;

  const reconciliationLines = [
    `Purchase vouchers ${purchaseVouchersPaid}`,
    `Funds given ${fundsGiven}`,
    `Funds received ${fundsReceived}`,
    `Total labour advances paid ${totalLabourAdvancesPaid}`,
    `Less settled through wage settlements ${labourAdvancesSettledThroughWageSettlements}`,
    `Outstanding labour advances ${outstandingLabourAdvances}`,
    `Labour settlements cash paid ${labourSettlementCashPaid}`,
    `Money returned ${moneyReturned}`,
    `Adjustment ${adjustment}`,
    `Farm owes partner ${farmOwesPartner}`,
  ];

  return {
    account,
    key: account.id,
    name: account.name,
    openingBalance: 0,
    capitalInjected,
    directExpensesPaid: purchaseVouchersPaid + outstandingLabourAdvances,
    purchaseVouchersPaid,
    businessFundsNet: fundsGiven - fundsReceived,
    labourAdvancesPaid: totalLabourAdvancesPaid,
    labourWageSettlements: labourSettlementNonCashApplied,
    totalLabourAdvancesPaid,
    outstandingLabourAdvances,
    transfersIn: fundsReceived,
    transfersOut: fundsGiven,
    moneyReturned,
    adjustments: adjustment,
    currentPartnerBalance,
    reconciliationDelta: 0,
    fundsGiven,
    fundsReceived,
    labourAdvancesSettledThroughWageSettlements,
    labourSettlementCashPaid,
    labourSettlementNonCashApplied,
    adjustment,
    farmOwesPartner,
    reconciliationLines,
    rowBreakdown: {
      purchaseVouchers,
      funds,
      advances: advanceRows,
      settlements: settlementRows,
    },
    mismatchDiagnostics: {
      includedByAliasCount: advanceRows.filter((row) => row.includedByAlias).length,
      includedByNameFallbackCount: advanceRows.filter((row) => row.includedByNameFallback).length,
      unmappedCount: advanceRows.filter((row) => !row.resolvedAccountId).length,
      deletedIncludedCount: [...advanceRows, ...settlementRows].filter((row) => row.deleted && row.included).length,
      voidedIncludedCount: settlementRows.filter((row) => row.voided && row.included).length,
    },
  } satisfies PartnerAccountingSnapshot;
}

export function partnerAccountBalanceEffect(
  account: Account,
  sales: Sale[],
  vouchers: Voucher[],
  advances: Advance[],
  entries: PartnerEntry[],
  settlements: LabourWageSettlement[],
  allAccounts: Account[],
  options: { farmId?: string | null; seasonId?: string | null } = {},
) {
  if (account.type !== "partner") return 0;
  const snapshot = getPartnerAccountingSnapshot(account, sales, vouchers, advances, entries, settlements, allAccounts, options);
  return snapshot.currentPartnerBalance;
}

export function buildPartnerLiabilityPositions(
  accounts: Account[],
  vouchers: Voucher[],
  advances: Advance[],
  entries: PartnerEntry[],
  sales: Sale[] = [],
  settlements: Array<Pick<LabourWageSettlement, "linkedAccountId" | "settledAdvanceAmount" | "status" | "deletedAt" | "accountingStatus">> = [],
  options: { farmId?: string | null; seasonId?: string | null } = {},
) {
  const partnerAccounts = accounts.filter((account) => account.type === "partner");
  const positions = new Map<string, PartnerLiabilityPosition>();
  const ensure = (key: string, name: string, account: Account | null) => {
    const current = positions.get(key) ?? {
      account,
      key,
      name,
      openingBalance: 0,
      capitalInjected: 0,
      directExpensesPaid: 0,
      purchaseVouchersPaid: 0,
      businessFundsNet: 0,
      labourAdvancesPaid: 0,
      labourWageSettlements: 0,
      labourSettlementCashPaid: 0,
      labourSettlementNonCashApplied: 0,
      totalLabourAdvancesPaid: 0,
      outstandingLabourAdvances: 0,
      transfersIn: 0,
      transfersOut: 0,
      moneyReturned: 0,
      adjustments: 0,
      currentPartnerBalance: 0,
      reconciliationDelta: 0,
    };
    if (!positions.has(key)) positions.set(key, current);
    return current;
  };

  for (const account of partnerAccounts) ensure(account.id, account.name, account);
  for (const account of partnerAccounts) {
    const snapshot = getPartnerAccountingSnapshot(account, sales, vouchers, advances, entries, settlements as LabourWageSettlement[], accounts, options);
    const position = ensure(account.id, account.name, account);
    position.capitalInjected = snapshot.capitalInjected;
    position.directExpensesPaid = snapshot.directExpensesPaid;
    position.purchaseVouchersPaid = snapshot.purchaseVouchersPaid;
    position.businessFundsNet = snapshot.businessFundsNet;
    position.labourAdvancesPaid = snapshot.labourAdvancesPaid;
    position.labourWageSettlements = snapshot.labourWageSettlements;
    position.labourSettlementCashPaid = snapshot.labourSettlementCashPaid;
    position.labourSettlementNonCashApplied = snapshot.labourSettlementNonCashApplied;
    position.totalLabourAdvancesPaid = snapshot.totalLabourAdvancesPaid;
    position.outstandingLabourAdvances = snapshot.outstandingLabourAdvances;
    position.transfersIn = snapshot.transfersIn;
    position.transfersOut = snapshot.transfersOut;
    position.moneyReturned = snapshot.moneyReturned;
    position.adjustments = snapshot.adjustments;
    position.currentPartnerBalance = snapshot.currentPartnerBalance;
    position.reconciliationDelta = snapshot.reconciliationDelta;
    position.account = snapshot.account;
  }

  return [...positions.values()]
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function groupPartnerLiabilityTransactions<T extends PartnerLiabilityGroupableTransaction>(transactions: T[]) {
  const groups = new Map<PartnerLiabilityLedgerGroupKey, PartnerLiabilityLedgerGroup<T>>();
  for (const groupKey of partnerLiabilityGroupOrder) {
    groups.set(groupKey, {
      groupKey,
      transactions: [],
      totalAmount: 0,
      debitTotal: 0,
      creditTotal: 0,
      count: 0,
    });
  }

  for (const transaction of transactions) {
    const groupKey = transaction.partnerLiabilityGroup ?? "other";
    const group = groups.get(groupKey)!;
    group.transactions.push(transaction);
    group.count += 1;
    group.debitTotal += transaction.debit;
    group.creditTotal += transaction.credit;
    group.totalAmount += transaction.credit - transaction.debit;
  }

  return partnerLiabilityGroupOrder.map((groupKey) => ({
    ...groups.get(groupKey)!,
    transactions: [...groups.get(groupKey)!.transactions].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)),
  }));
}
