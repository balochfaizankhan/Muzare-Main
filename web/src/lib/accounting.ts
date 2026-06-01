import type { Account, Advance, PartnerEntry, Sale, Voucher } from "./offline-db";

export function partnerSettlementEffect(entry: PartnerEntry, accountId: string): number {
  if (entry.type !== "settlement") return 0;
  return (entry.toAccountId === accountId ? entry.amount : 0)
    - (entry.fromAccountId === accountId ? entry.amount : 0);
}

export function partnerEntryAccountEffect(entry: PartnerEntry, account: Account): number {
  if (entry.type === "settlement") return partnerSettlementEffect(entry, account.id);
  if (entry.accountId !== account.id) return 0;
  return entry.type === "contribution" ? entry.amount : -entry.amount;
}

export function calculateAccountBalance(
  account: Account,
  sales: Sale[],
  vouchers: Voucher[],
  advances: Advance[],
  entries: PartnerEntry[],
): number {
  return sales.filter((record) => record.accountId === account.id).reduce((sum, record) => sum + record.amount, 0)
    - vouchers.filter((record) => record.accountId === account.id).reduce((sum, record) => sum + record.amount, 0)
    - advances.filter((record) => record.accountId === account.id).reduce((sum, record) => sum + record.amount, 0)
    + entries.reduce((sum, record) => sum + partnerEntryAccountEffect(record, account), 0);
}

export function calculateAvailableBalance(
  accounts: Account[],
  sales: Sale[],
  vouchers: Voucher[],
  advances: Advance[],
  entries: PartnerEntry[],
): number {
  return accounts.reduce((sum, account) => sum + calculateAccountBalance(account, sales, vouchers, advances, entries), 0);
}
