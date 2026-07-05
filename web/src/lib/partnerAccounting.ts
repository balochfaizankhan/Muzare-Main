import type { Account, Advance, LabourWageSettlement, PartnerEntry, Sale, Voucher } from "./offline-db";
import { isActiveOperationalRecord } from "./operationalRecords";
import { getActiveVouchers } from "./voucherCollections";
import { getActiveLabourWageSettlements, isLabourWageSettlementVoucher } from "./labourWageSettlements";

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
  totalLabourAdvancesPaid: number;
  outstandingLabourAdvances: number;
  transfersIn: number;
  transfersOut: number;
  moneyReturned: number;
  adjustments: number;
  currentPartnerBalance: number;
  reconciliationDelta: number;
};

export type PartnerBalanceState = "farm_owes_partner" | "partner_holds_business_money" | "settled";

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
  if (entry.partnerAccountId && accounts.some((account) => account.id === entry.partnerAccountId && account.type === "partner")) return entry.partnerAccountId;
  const name = entry.partnerName?.trim();
  if (!name) return undefined;
  const matches = accounts.filter((account) => account.type === "partner" && normalized(account.name) === normalized(name));
  return matches.length === 1 ? matches[0]!.id : undefined;
}

export function partnerAccountBalanceEffect(
  account: Account,
  sales: Sale[],
  vouchers: Voucher[],
  advances: Advance[],
  entries: PartnerEntry[],
  settlements: LabourWageSettlement[],
  allAccounts: Account[],
) {
  if (account.type !== "partner") return 0;
  const activeVouchers = getActiveVouchers(vouchers);
  const activeSettlements = getActiveLabourWageSettlements(settlements as LabourWageSettlement[]);
  const capitalInjected = entries
    .filter((entry) => isActiveOperationalRecord(entry) && entry.type === "contribution" && resolvePartnerAccountId(entry, allAccounts) === account.id)
    .reduce((sum, entry) => sum + entry.amount, 0);
  const moneyReturned = entries
    .filter((entry) => isActiveOperationalRecord(entry) && entry.type === "withdrawal" && resolvePartnerAccountId(entry, allAccounts) === account.id)
    .reduce((sum, entry) => sum + entry.amount, 0);
  const transfersIn = entries
    .filter((entry) => isActiveOperationalRecord(entry) && entry.type === "settlement" && entry.toAccountId === account.id)
    .reduce((sum, entry) => sum + entry.amount, 0);
  const transfersOut = entries
    .filter((entry) => isActiveOperationalRecord(entry) && entry.type === "settlement" && entry.fromAccountId === account.id)
    .reduce((sum, entry) => sum + entry.amount, 0);
  const entryAdjustments = entries
    .filter((entry) => isActiveOperationalRecord(entry) && entry.type === "adjustment" && resolvePartnerAccountId(entry, allAccounts) === account.id)
    .reduce((sum, entry) => sum + partnerAdjustmentEffect(entry), 0);
  const directVoucherExpensesPaid = activeVouchers
    .filter((voucher) => !isLabourWageSettlementVoucher(voucher))
    .filter((voucher) => voucher.accountId === account.id)
    .reduce((sum, voucher) => sum + voucher.amount, 0);
  const labourSettlementExpenses = activeSettlements
    .filter((settlement) => settlement.linkedAccountId === account.id)
    .reduce((sum, settlement) => sum + settlement.expenseAmount, 0);
  const directLabourAdvancesPaid = advances
    .filter((advance) => isActiveOperationalRecord(advance) && advance.accountId === account.id)
    .reduce((sum, advance) => sum + advance.amount, 0);
  const settledAdvancesApplied = activeSettlements
    .filter((settlement) => settlement.linkedAccountId === account.id)
    .reduce((sum, settlement) => sum + settlement.settledAdvanceAmount, 0);
  const adjustments = sales
    .filter((sale) => isActiveOperationalRecord(sale) && sale.accountId === account.id)
    .reduce((sum, sale) => sum - sale.amount, 0);
  return capitalInjected
    + directVoucherExpensesPaid
    + labourSettlementExpenses
    + Math.max(directLabourAdvancesPaid - settledAdvancesApplied, 0)
    + transfersOut
    - transfersIn
    - moneyReturned
    + entryAdjustments
    + adjustments;
}

export function buildPartnerLiabilityPositions(
  accounts: Account[],
  vouchers: Voucher[],
  advances: Advance[],
  entries: PartnerEntry[],
  sales: Sale[] = [],
  settlements: Array<Pick<LabourWageSettlement, "linkedAccountId" | "settledAdvanceAmount" | "status" | "deletedAt">> = [],
) {
  const activeVouchers = getActiveVouchers(vouchers);
  const activeSettlements = getActiveLabourWageSettlements(settlements as LabourWageSettlement[]);
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

  for (const entry of entries.filter((item) => isActiveOperationalRecord(item))) {
    if (entry.type === "settlement") {
      if (entry.fromAccountId) ensure(entry.fromAccountId, accounts.find((account) => account.id === entry.fromAccountId)?.name ?? entry.fromPartner ?? "-", accounts.find((account) => account.id === entry.fromAccountId) ?? null).transfersOut += entry.amount;
      if (entry.toAccountId) ensure(entry.toAccountId, accounts.find((account) => account.id === entry.toAccountId)?.name ?? entry.toPartner ?? "-", accounts.find((account) => account.id === entry.toAccountId) ?? null).transfersIn += entry.amount;
      continue;
    }
    const resolvedId = resolvePartnerAccountId(entry, accounts);
    if (resolvedId) {
      const account = accounts.find((item) => item.id === resolvedId) ?? null;
      const position = ensure(resolvedId, account?.name ?? entry.partnerName ?? "-", account);
      if (entry.type === "contribution") position.capitalInjected += entry.amount;
      if (entry.type === "withdrawal") position.moneyReturned += entry.amount;
      if (entry.type === "adjustment") position.adjustments += partnerAdjustmentEffect(entry);
      continue;
    }
    const fallbackName = entry.partnerName?.trim();
    if (!fallbackName) continue;
    const position = ensure(`legacy:${normalized(fallbackName)}`, fallbackName, null);
    if (entry.type === "contribution") position.capitalInjected += entry.amount;
    if (entry.type === "withdrawal") position.moneyReturned += entry.amount;
    if (entry.type === "adjustment") position.adjustments += partnerAdjustmentEffect(entry);
  }

  for (const voucher of activeVouchers) {
    const account = partnerAccounts.find((item) => item.id === voucher.accountId);
    if (!account) continue;
    const position = ensure(account.id, account.name, account);
    if (isLabourWageSettlementVoucher(voucher)) continue;
    position.purchaseVouchersPaid += voucher.amount;
    position.directExpensesPaid += voucher.amount;
  }

  for (const advance of advances.filter((item) => isActiveOperationalRecord(item))) {
    const account = partnerAccounts.find((item) => item.id === advance.accountId);
    if (!account) continue;
    const position = ensure(account.id, account.name, account);
    position.totalLabourAdvancesPaid += advance.amount;
  }

  for (const settlement of activeSettlements) {
    const account = partnerAccounts.find((item) => item.id === settlement.linkedAccountId);
    if (!account) continue;
    const position = ensure(account.id, account.name, account);
    position.labourWageSettlements += settlement.expenseAmount;
  }

  for (const position of positions.values()) {
    position.businessFundsNet = position.transfersOut - position.transfersIn;
    position.outstandingLabourAdvances = Math.max(position.totalLabourAdvancesPaid - settlements
      .filter((item) => isActiveOperationalRecord(item) && item.linkedAccountId === position.account?.id)
      .reduce((sum, item) => sum + item.settledAdvanceAmount, 0), 0);
    position.labourAdvancesPaid = position.outstandingLabourAdvances;
    position.directExpensesPaid = position.purchaseVouchersPaid + position.labourWageSettlements + position.outstandingLabourAdvances;
  }

  for (const sale of sales.filter((item) => isActiveOperationalRecord(item))) {
    const account = partnerAccounts.find((item) => item.id === sale.accountId);
    if (!account) continue;
    const position = ensure(account.id, account.name, account);
    position.adjustments -= sale.amount;
  }

  return [...positions.values()]
    .map((position) => {
      const currentPartnerBalance = calculatePartnerLiabilityBalance(position);
      return {
        ...position,
        currentPartnerBalance,
        reconciliationDelta: currentPartnerBalance - calculatePartnerLiabilityBalance(position),
      };
    })
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
