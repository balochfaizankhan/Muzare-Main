import type { Account, Advance, PartnerEntry, Sale, Voucher } from "./offline-db";

const normalizedName = (value?: string) => value?.trim().toLowerCase() ?? "";

export function partnerSettlementEffect(entry: PartnerEntry, partnerName: string): number {
  if (entry.type !== "settlement") return 0;
  const accountName = normalizedName(partnerName);
  return (normalizedName(entry.toPartner) === accountName ? entry.amount : 0)
    - (normalizedName(entry.fromPartner) === accountName ? entry.amount : 0);
}

export function partnerEntryAccountEffect(entry: PartnerEntry, account: Account): number {
  if (entry.type === "settlement") return partnerSettlementEffect(entry, account.name);
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
