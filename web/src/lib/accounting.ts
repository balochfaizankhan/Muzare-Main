import type { Account, Advance, LabourWageSettlement, PartnerEntry, Sale, Voucher } from "./offline-db";
import { isActiveOperationalRecord } from "./operationalRecords";
import { isPartnerAccount, partnerAccountBalanceEffect, resolvePartnerTransferAccountIdentity } from "./partnerAccounting";
import { getActiveVouchers } from "./voucherCollections";
import { getActiveLabourWageSettlements, getGeneralExpenseVouchers, getLabourWageSettlementCashPaidAmount, resolveLabourWageSettlementAccountId } from "./labourWageSettlements";
import { buildAccountIdentityLookup, resolveCanonicalAccountId, type AccountIdentityLookup } from "./accountIdentity";

export type CanonicalAccountBalanceEntry = {
  accountId: string;
  balanceEffect: number;
};

export function partnerSettlementEffect(entry: PartnerEntry, accountId: string, accountLookup: AccountIdentityLookup): number {
  if (entry.type !== "settlement") return 0;
  const fromAccountId = resolvePartnerTransferAccountIdentity(entry as Record<string, unknown>, "from", accountLookup).canonicalAccountId ?? entry.fromAccountId ?? null;
  const toAccountId = resolvePartnerTransferAccountIdentity(entry as Record<string, unknown>, "to", accountLookup).canonicalAccountId ?? entry.toAccountId ?? null;
  return (toAccountId === accountId ? entry.amount : 0)
    - (fromAccountId === accountId ? entry.amount : 0);
}

export function partnerEntryAccountEffect(entry: PartnerEntry, account: Account, accountLookup?: AccountIdentityLookup): number {
  if (entry.type === "settlement") return partnerSettlementEffect(entry, account.id, accountLookup ?? buildAccountIdentityLookup([account]));
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
  settlements: LabourWageSettlement[] = [],
  allAccounts: Account[] = [account],
  options: { farmId?: string | null; seasonId?: string | null } = {},
): number {
  if (account.type === "partner") return partnerAccountBalanceEffect(account, sales, vouchers, advances, entries, settlements, allAccounts, options);
  const lookup = buildAccountIdentityLookup(allAccounts);
  const farmId = options.farmId ?? null;
  const seasonId = options.seasonId ?? null;
  const farmMatches = (rowFarmId: string | null) => !farmId || rowFarmId === farmId || rowFarmId === null;
  const seasonMatches = (rowSeasonId: string | null) => !seasonId || rowSeasonId === seasonId || rowSeasonId === null;
  const activeVouchers = getGeneralExpenseVouchers(getActiveVouchers(vouchers), settlements);
  const activeSettlements = getActiveLabourWageSettlements(settlements)
    .filter((record) => resolveCanonicalAccountId(resolveLabourWageSettlementAccountId(record), lookup) === account.id)
    .filter((record) => farmMatches(record.farmId ?? null) && seasonMatches(record.seasonId ?? null))
    .reduce((sum, record) => sum + getLabourWageSettlementCashPaidAmount(record), 0);
  return sales.filter((record) => isActiveOperationalRecord(record) && resolveCanonicalAccountId(record.accountId, lookup) === account.id && farmMatches(record.farmId ?? null) && seasonMatches(record.seasonId ?? null)).reduce((sum, record) => sum + record.amount, 0)
    - activeVouchers.filter((record) => resolveCanonicalAccountId(record.accountId, lookup) === account.id && farmMatches(record.farmId ?? null) && seasonMatches(record.seasonId ?? null)).reduce((sum, record) => sum + record.amount, 0)
    - activeSettlements
    - advances.filter((record) => isActiveOperationalRecord(record) && resolveCanonicalAccountId(record.accountId, lookup) === account.id && farmMatches(record.farmId ?? null) && seasonMatches(record.seasonId ?? null)).reduce((sum, record) => sum + record.amount, 0)
    + entries.filter((record) => isActiveOperationalRecord(record) && farmMatches(record.farmId ?? null) && seasonMatches(record.seasonId ?? null)).reduce((sum, record) => sum + partnerEntryAccountEffect(record, account, lookup), 0);
}

export function calculateAvailableBalance(
  accounts: Account[],
  sales: Sale[],
  vouchers: Voucher[],
  advances: Advance[],
  entries: PartnerEntry[],
  settlements: LabourWageSettlement[] = [],
): number {
  return accounts
    .filter((account) => account.type !== "partner")
    .reduce((sum, account) => sum + calculateAccountBalance(account, sales, vouchers, advances, entries, settlements, accounts), 0);
}

export function calculateDisplayedAccountBalance(
  account: Account,
  sales: Sale[],
  vouchers: Voucher[],
  advances: Advance[],
  entries: PartnerEntry[],
  settlements: LabourWageSettlement[],
  allAccounts: Account[],
  canonicalEntries: CanonicalAccountBalanceEntry[] = [],
  options: { farmId?: string | null; seasonId?: string | null } = {},
): number {
  const localBalance = calculateAccountBalance(account, sales, vouchers, advances, entries, settlements, allAccounts, options);
  const canonicalBalance = canonicalEntries
    .filter((entry) => entry.accountId === account.id)
    .reduce((sum, entry) => sum + entry.balanceEffect, 0);
  return localBalance + canonicalBalance;
}

export function calculateScopedCashAccountBalance(
  accounts: Account[],
  sales: Sale[],
  vouchers: Voucher[],
  advances: Advance[],
  entries: PartnerEntry[],
  settlements: LabourWageSettlement[],
  canonicalEntries: CanonicalAccountBalanceEntry[] = [],
  options: { farmId?: string | null; seasonId?: string | null } = {},
): number {
  return accounts
    .filter((account) => account.type === "cash")
    .reduce((sum, account) => sum + calculateDisplayedAccountBalance(
      account,
      sales,
      vouchers,
      advances,
      entries,
      settlements,
      accounts,
      canonicalEntries,
      options,
    ), 0);
}
