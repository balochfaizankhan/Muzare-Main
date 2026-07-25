// Pure, dependency-free harvest-performance calculations shared by the Harvest module
// pages and the main workspace dashboard. Kept side-effect free so it can be unit tested
// and reused without pulling in React or Dexie. This module is intentionally independent
// of labour/wage/accounting logic — it only measures operational carton productivity.
import type { HarvestEntry, HarvestGroup } from "./offline-db";

export function cartonsPerPerson(cartonsHarvested: number, membersCount: number): number {
  const cartons = Number(cartonsHarvested) || 0;
  const members = Number(membersCount) || 0;
  if (members <= 0) return 0;
  return cartons / members;
}

export type HarvestGroupLeaderboardRow = {
  groupId: string;
  groupName: string;
  active: boolean;
  totalCartons: number;
  totalMemberDays: number;
  entriesCount: number;
  // Representative crew size — taken from the most recent entry for the group.
  crewSize: number;
  // Weighted productivity: total cartons divided by total person-days.
  cartonsPerPerson: number;
  lastEntryDate: string | null;
};

function resolveGroupName(groups: Map<string, HarvestGroup>, entry: HarvestEntry): string {
  return groups.get(entry.harvestGroupId)?.name ?? entry.harvestGroupName ?? "";
}

export function buildGroupLeaderboard(groups: HarvestGroup[], entries: HarvestEntry[]): HarvestGroupLeaderboardRow[] {
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const rows = new Map<string, HarvestGroupLeaderboardRow>();

  // Seed every known group so groups with no entries still appear (with zero productivity).
  for (const group of groups) {
    rows.set(group.id, {
      groupId: group.id,
      groupName: group.name,
      active: group.active !== false,
      totalCartons: 0,
      totalMemberDays: 0,
      entriesCount: 0,
      crewSize: 0,
      cartonsPerPerson: 0,
      lastEntryDate: null,
    });
  }

  for (const entry of entries) {
    const groupId = entry.harvestGroupId;
    if (!groupId) continue;
    let row = rows.get(groupId);
    if (!row) {
      // Entry references a group that no longer exists — fall back to the denormalized name.
      row = {
        groupId,
        groupName: resolveGroupName(groupById, entry),
        active: false,
        totalCartons: 0,
        totalMemberDays: 0,
        entriesCount: 0,
        crewSize: 0,
        cartonsPerPerson: 0,
        lastEntryDate: null,
      };
      rows.set(groupId, row);
    }
    row.totalCartons += Number(entry.cartonsHarvested) || 0;
    row.totalMemberDays += Number(entry.membersCount) || 0;
    row.entriesCount += 1;
    if (!row.lastEntryDate || entry.date > row.lastEntryDate) {
      row.lastEntryDate = entry.date;
      row.crewSize = Number(entry.membersCount) || 0;
    }
  }

  for (const row of rows.values()) {
    row.cartonsPerPerson = row.totalMemberDays > 0 ? row.totalCartons / row.totalMemberDays : 0;
  }

  return [...rows.values()];
}

export function sortLeaderboard(
  rows: HarvestGroupLeaderboardRow[],
  key: keyof Pick<HarvestGroupLeaderboardRow, "cartonsPerPerson" | "totalCartons" | "crewSize" | "groupName">,
  direction: "asc" | "desc" = "desc",
): HarvestGroupLeaderboardRow[] {
  const factor = direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    if (key === "groupName") return factor * left.groupName.localeCompare(right.groupName);
    const delta = (left[key] as number) - (right[key] as number);
    if (delta !== 0) return factor * delta;
    return left.groupName.localeCompare(right.groupName);
  });
}

export type HarvestSummary = {
  totalCartons: number;
  activeGroups: number;
  totalEntries: number;
  averageCartonsPerPerson: number;
  bestGroup: HarvestGroupLeaderboardRow | null;
  todayTotalCartons: number;
};

export function buildHarvestSummary(
  groups: HarvestGroup[],
  entries: HarvestEntry[],
  options: { todayKey?: string } = {},
): HarvestSummary {
  const leaderboard = buildGroupLeaderboard(groups, entries);
  const totalCartons = entries.reduce((sum, entry) => sum + (Number(entry.cartonsHarvested) || 0), 0);
  const totalMemberDays = entries.reduce((sum, entry) => sum + (Number(entry.membersCount) || 0), 0);
  const activeGroups = groups.filter((group) => group.active !== false).length;
  const todayKey = options.todayKey;
  const todayTotalCartons = todayKey
    ? entries.filter((entry) => entry.date === todayKey).reduce((sum, entry) => sum + (Number(entry.cartonsHarvested) || 0), 0)
    : 0;
  // Best group = highest weighted cartons-per-person among groups that actually recorded harvest.
  const bestGroup = leaderboard
    .filter((row) => row.entriesCount > 0 && row.totalMemberDays > 0)
    .sort((left, right) => right.cartonsPerPerson - left.cartonsPerPerson)[0] ?? null;
  return {
    totalCartons,
    activeGroups,
    totalEntries: entries.length,
    averageCartonsPerPerson: totalMemberDays > 0 ? totalCartons / totalMemberDays : 0,
    bestGroup,
    todayTotalCartons,
  };
}
