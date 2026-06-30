import type { Account, Advance, PartnerEntry, Sale, Voucher } from "./offline-db";
import { isActiveOperationalRecord } from "./operationalRecords";
import { isPartnerAccount, partnerAccountBalanceEffect } from "./partnerAccounting";

export function partnerSettlementEffect(entry: PartnerEntry, accountId: string): number {
  if (entry.type !== "settlement") return 0;
  return (entry.toAccountId === accountId ? entry.amount : 0)
    - (entry.fromAccountId === accountId ? entry.amount : 0);
}

export function partnerEntryAccountEffect(entry: PartnerEntry, account: Account): number {
  if (entry.type === "settlement") return partnerSettlementEffect(entry, account.id);
  if (entry.type === "adjustment") return 0;
  if (isPartnerAccount(account)) return 0;
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
  if (account.type === "partner") return partnerAccountBalanceEffect(account, sales, vouchers, advances, entries, [account]);
  return sales.filter((record) => isActiveOperationalRecord(record) && record.accountId === account.id).reduce((sum, record) => sum + record.amount, 0)
    - vouchers.filter((record) => isActiveOperationalRecord(record) && record.accountId === account.id).reduce((sum, record) => sum + record.amount, 0)
    - advances.filter((record) => isActiveOperationalRecord(record) && record.accountId === account.id).reduce((sum, record) => sum + record.amount, 0)
    + entries.filter((record) => isActiveOperationalRecord(record)).reduce((sum, record) => sum + partnerEntryAccountEffect(record, account), 0);
}

export function calculateAvailableBalance(
  accounts: Account[],
  sales: Sale[],
  vouchers: Voucher[],
  advances: Advance[],
  entries: PartnerEntry[],
): number {
  return accounts
    .filter((account) => account.type !== "partner")
    .reduce((sum, account) => sum + calculateAccountBalance(account, sales, vouchers, advances, entries), 0);
}
