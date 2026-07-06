import type { Account, Advance, LabourWageSettlement, PartnerEntry, Sale, Voucher } from "./offline-db";
import { isActiveOperationalRecord } from "./operationalRecords";
import { isPartnerAccount, partnerAccountBalanceEffect } from "./partnerAccounting";
import { getActiveVouchers } from "./voucherCollections";
import { getActiveLabourWageSettlements, getLabourWageSettlementCashPaidAmount, isLabourWageSettlementVoucher, resolveLabourWageSettlementAccountId } from "./labourWageSettlements";
import { buildAccountIdentityLookup, resolveCanonicalAccountId } from "./accountIdentity";

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
  const activeVouchers = getActiveVouchers(vouchers).filter((record) => !isLabourWageSettlementVoucher(record));
  const activeSettlements = getActiveLabourWageSettlements(settlements)
    .filter((record) => resolveCanonicalAccountId(resolveLabourWageSettlementAccountId(record), lookup) === account.id)
    .filter((record) => farmMatches(record.farmId ?? null) && seasonMatches(record.seasonId ?? null))
    .reduce((sum, record) => sum + getLabourWageSettlementCashPaidAmount(record), 0);
  return sales.filter((record) => isActiveOperationalRecord(record) && resolveCanonicalAccountId(record.accountId, lookup) === account.id && farmMatches(record.farmId ?? null) && seasonMatches(record.seasonId ?? null)).reduce((sum, record) => sum + record.amount, 0)
    - activeVouchers.filter((record) => resolveCanonicalAccountId(record.accountId, lookup) === account.id && farmMatches(record.farmId ?? null) && seasonMatches(record.seasonId ?? null)).reduce((sum, record) => sum + record.amount, 0)
    - activeSettlements
    - advances.filter((record) => isActiveOperationalRecord(record) && resolveCanonicalAccountId(record.accountId, lookup) === account.id && farmMatches(record.farmId ?? null) && seasonMatches(record.seasonId ?? null)).reduce((sum, record) => sum + record.amount, 0)
    + entries.filter((record) => isActiveOperationalRecord(record) && farmMatches(record.farmId ?? null) && seasonMatches(record.seasonId ?? null)).reduce((sum, record) => sum + partnerEntryAccountEffect(record, account), 0);
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
