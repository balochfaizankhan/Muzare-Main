import type { LabourFinancialReadModel } from "./api";
import { resolveCanonicalAccountId, type AccountIdentityLookup } from "./accountIdentity";
import type { Account } from "./offline-db";

export type CanonicalDisplayAccount = {
  id: string;
  canonicalAccountId: string;
  account: Account;
  sourceAccountIds: string[];
  synthetic: boolean;
};

function normalizeName(value: string) {
  return value.trim().toLowerCase();
}

function preferredAccountScore(account: Account, canonicalAccountId?: string | null) {
  let score = 0;
  if (!account.sourceType?.toLowerCase().includes("labour")) score += 300;
  if (canonicalAccountId && account.id === canonicalAccountId) score += 200;
  if (!account.oldAndroidId?.trim()) score += 20;
  if (!account.deletedAt) score += 10;
  return score;
}

function buildUniqueCanonicalPartnerNameMap(partnerPositions: LabourFinancialReadModel["partnerPositions"]) {
  const counts = new Map<string, number>();
  for (const position of partnerPositions) {
    const key = normalizeName(position.accountName);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const unique = new Map<string, LabourFinancialReadModel["partnerPositions"][number]>();
  for (const position of partnerPositions) {
    const key = normalizeName(position.accountName);
    if (counts.get(key) === 1) unique.set(key, position);
  }
  return unique;
}

export function buildCanonicalDisplayAccounts(
  accounts: Account[],
  accountLookup: AccountIdentityLookup,
  canonicalPartnerPositions: LabourFinancialReadModel["partnerPositions"],
): CanonicalDisplayAccount[] {
  const canonicalPartnerById = new Map(canonicalPartnerPositions.map((position) => [position.accountId, position] as const));
  const canonicalPartnerByName = buildUniqueCanonicalPartnerNameMap(canonicalPartnerPositions);
  const groups = new Map<string, {
    canonicalPartner?: LabourFinancialReadModel["partnerPositions"][number];
    representative: Account | null;
    members: Account[];
  }>();

  for (const account of accounts) {
    const canonicalPartner = account.type === "partner"
      ? canonicalPartnerById.get(account.id) ?? canonicalPartnerByName.get(normalizeName(account.name))
      : undefined;
    const groupKey = canonicalPartner?.accountId
      ?? resolveCanonicalAccountId(account.id, accountLookup)
      ?? account.id;
    const group = groups.get(groupKey) ?? {
      canonicalPartner,
      representative: null,
      members: [],
    };
    group.members.push(account);
    if (!group.canonicalPartner && canonicalPartner) group.canonicalPartner = canonicalPartner;
    if (!group.representative || preferredAccountScore(account, group.canonicalPartner?.accountId) > preferredAccountScore(group.representative, group.canonicalPartner?.accountId)) {
      group.representative = account;
    }
    groups.set(groupKey, group);
  }

  for (const canonicalPartner of canonicalPartnerPositions) {
    if (groups.has(canonicalPartner.accountId)) continue;
    if (Math.abs(canonicalPartner.farmOwesPartner) < 0.009 && canonicalPartner.entryCount === 0) continue;
    groups.set(canonicalPartner.accountId, {
      canonicalPartner,
      representative: {
        id: canonicalPartner.accountId,
        workspaceId: "",
        farmId: null,
        seasonId: null,
        createdAt: "",
        updatedAt: "",
        name: canonicalPartner.accountName,
        type: "partner",
      },
      members: [],
    });
  }

  return [...groups.entries()]
    .map(([groupKey, group]) => ({
      id: group.representative?.id ?? groupKey,
      canonicalAccountId: group.canonicalPartner?.accountId ?? groupKey,
      account: group.representative ?? {
        id: groupKey,
        workspaceId: "",
        farmId: null,
        seasonId: null,
        createdAt: "",
        updatedAt: "",
        name: group.canonicalPartner?.accountName ?? groupKey,
        type: "partner",
      },
      sourceAccountIds: group.members.map((member) => member.id),
      synthetic: group.members.length === 0,
    }))
    .sort((left, right) => left.account.name.localeCompare(right.account.name));
}
