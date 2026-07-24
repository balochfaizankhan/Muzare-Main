import { and, eq, inArray } from "drizzle-orm";
import type { db } from "../db/client.js";
import {
  accounts,
  labourAdvanceApplications,
  labourDues,
  labourPaymentVouchers,
  operationalRecords,
} from "../db/schema.js";
import { isDeletedOperationalPayload } from "../operational-record-state.js";

type DbClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const toMinor = (value: unknown) => {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) : 0;
};
const toMajor = (minor: number) => Number((minor / 100).toFixed(2));

/**
 * Canonical Group Advance Pool model.
 *
 * A labour group and its leader are ONE financial settlement unit: every valid
 * advance voucher paid to the leader or to any labourer CURRENTLY assigned to
 * the group — plus group-directed advance vouchers — forms one combined pool
 * the leader is responsible for. Ownership follows the recipient labourer's
 * current group membership, so moving a labourer moves their advance vouchers
 * to the new group's pool, and removing them from all groups returns the
 * vouchers to their Individual pool. Historical group snapshots are NOT
 * required and never control pool assignment.
 *
 * Applications and recoveries are pool-level only: no per-voucher allocation,
 * consumption, or "applied/outstanding" voucher state exists anywhere in this
 * model. Posted applications stay attached to the pool of the due they settled
 * (group dues stay with that group forever); labourer-recorded events follow
 * the labourer's current pool. Balances are SIGNED — a pool made negative by
 * later movement of members is reported negative, never clamped to zero.
 *
 * The same rules are enforced in PostgreSQL by labour_advance_pool_key /
 * labour_due_pool_key / validate_labour_advance_application (migration 0047).
 * Change them together or preview and posting will diverge.
 */

export type MembershipLabourer = {
  id: string;
  name: string;
  groupId: string | null;
  deleted: boolean;
};

export type MembershipGroup = {
  id: string;
  name: string;
  leaderId: string | null;
  leaderName: string | null;
  memberCount: number;
  deleted: boolean;
};

export type MembershipDirectory = {
  labourers: Map<string, MembershipLabourer>;
  groups: Map<string, MembershipGroup>;
};

export async function loadMembershipDirectory(tx: DbClient, workspaceId: string, farmId: string): Promise<MembershipDirectory> {
  const [labourerRows, groupRows] = await Promise.all([
    tx.select({ clientRecordId: operationalRecords.clientRecordId, payload: operationalRecords.payload }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.farmId, farmId),
      eq(operationalRecords.entityType, "labourer"),
    )),
    tx.select({ clientRecordId: operationalRecords.clientRecordId, payload: operationalRecords.payload }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.farmId, farmId),
      eq(operationalRecords.entityType, "labourGroup"),
    )),
  ]);
  return buildMembershipDirectory(labourerRows, groupRows);
}

/** Pure construction of the current-membership directory from operational records. */
export function buildMembershipDirectory(
  labourerRows: Array<{ clientRecordId: string; payload: Record<string, unknown> }>,
  groupRows: Array<{ clientRecordId: string; payload: Record<string, unknown> }>,
): MembershipDirectory {
  const groups = new Map<string, MembershipGroup>();
  for (const row of groupRows) {
    const payload = row.payload as Record<string, unknown>;
    if (isDeletedOperationalPayload(payload)) continue;
    groups.set(row.clientRecordId, {
      id: row.clientRecordId,
      name: text(payload.name) ?? "Labour Group",
      leaderId: text(payload.foremanLabourId) ?? text(payload.foremanId),
      leaderName: null,
      memberCount: 0,
      deleted: false,
    });
  }
  const groupIdByName = new Map<string, string | null>();
  for (const group of groups.values()) {
    const key = group.name.toLowerCase();
    // Only an unambiguous name can stand in for a missing groupId reference.
    groupIdByName.set(key, groupIdByName.has(key) ? null : group.id);
  }
  const labourers = new Map<string, MembershipLabourer>();
  for (const row of labourerRows) {
    const payload = row.payload as Record<string, unknown>;
    const deleted = isDeletedOperationalPayload(payload);
    const directGroupId = text(payload.groupId);
    const namedGroupId = text(payload.group) ? groupIdByName.get(text(payload.group)!.toLowerCase()) ?? null : null;
    const groupId = directGroupId && groups.has(directGroupId) ? directGroupId
      : namedGroupId && groups.has(namedGroupId) ? namedGroupId
      : null;
    labourers.set(row.clientRecordId, {
      id: row.clientRecordId,
      name: text(payload.name) ?? "Labourer",
      groupId: deleted ? null : groupId,
      deleted,
    });
  }
  // The leader belongs to the group's settlement unit even without an explicit
  // member assignment of their own.
  for (const group of groups.values()) {
    if (!group.leaderId) continue;
    const leader = labourers.get(group.leaderId);
    if (!leader) continue;
    group.leaderName = leader.name;
    if (!leader.deleted && !leader.groupId) leader.groupId = group.id;
  }
  for (const labourer of labourers.values()) {
    if (labourer.deleted || !labourer.groupId) continue;
    const group = groups.get(labourer.groupId);
    if (group) group.memberCount += 1;
  }
  return { labourers, groups };
}

export type AdvancePoolOwnership =
  | { kind: "GROUP"; poolKey: string; groupId: string }
  | { kind: "INDIVIDUAL"; poolKey: string; labourerId: string }
  | { kind: "SCOPE"; poolKey: string }
  | { kind: "REVIEW"; poolKey: null; reviewReason: "RECIPIENT_NOT_FOUND" | "GROUP_NOT_FOUND" | "NO_RECIPIENT_REFERENCE" };

type VoucherOwnershipInput = {
  labourerId?: string | null;
  labourGroupId?: string | null;
  financialScopeKey?: string | null;
  recipientSnapshot?: unknown;
};

const snapshotOf = (value: unknown) => (value && typeof value === "object" ? value as Record<string, unknown> : {});

/** The labourer who received the advance — the original audit recipient. */
export function advanceRecipientLabourerId(advance: VoucherOwnershipInput) {
  const snapshot = snapshotOf(advance.recipientSnapshot);
  return text(advance.labourerId)
    ?? text(snapshot.labourerId)
    ?? text(snapshot.advanceLabourerId)
    ?? text(snapshot.recipientLabourerId);
}

/** Group identity recorded on a group-directed advance voucher itself. */
export function advanceDirectedGroupId(advance: VoucherOwnershipInput) {
  const direct = text(advance.labourGroupId);
  if (direct) return direct;
  const snapshot = snapshotOf(advance.recipientSnapshot);
  const fromSnapshot = text(snapshot.labourGroupId) ?? text(snapshot.groupId);
  if (fromSnapshot) return fromSnapshot;
  const scopeKey = text(advance.financialScopeKey);
  if (scopeKey?.startsWith("group:")) return scopeKey.slice("group:".length);
  return null;
}

export function labourerCurrentPoolKey(labourerId: string, directory: MembershipDirectory) {
  const labourer = directory.labourers.get(labourerId);
  if (!labourer || labourer.deleted) return null;
  return labourer.groupId ? `group:${labourer.groupId}` : `individual:${labourerId}`;
}

/**
 * The ONE canonical rule that assigns an advance voucher to a pool:
 * 1. A labour-recipient voucher belongs to the recipient's CURRENT pool
 *    (their current group's pool, or their individual pool when ungrouped).
 * 2. A group-directed voucher belongs to that group's pool.
 * 3. Contractor/crew/unregistered/batch vouchers keep their own scope pool.
 * Only genuinely broken records (recipient or group no longer exists, no
 * recipient reference at all) resolve to REVIEW.
 */
export function resolveAdvancePoolOwnership(advance: VoucherOwnershipInput, directory: MembershipDirectory): AdvancePoolOwnership {
  const labourerId = advanceRecipientLabourerId(advance);
  if (labourerId) {
    const poolKey = labourerCurrentPoolKey(labourerId, directory);
    if (poolKey?.startsWith("group:")) return { kind: "GROUP", poolKey, groupId: poolKey.slice("group:".length) };
    if (poolKey) return { kind: "INDIVIDUAL", poolKey, labourerId };
    const directedGroupId = advanceDirectedGroupId(advance);
    if (directedGroupId && directory.groups.has(directedGroupId))
      return { kind: "GROUP", poolKey: `group:${directedGroupId}`, groupId: directedGroupId };
    return { kind: "REVIEW", poolKey: null, reviewReason: "RECIPIENT_NOT_FOUND" };
  }
  const groupId = advanceDirectedGroupId(advance);
  if (groupId) {
    if (directory.groups.has(groupId)) return { kind: "GROUP", poolKey: `group:${groupId}`, groupId };
    return { kind: "REVIEW", poolKey: null, reviewReason: "GROUP_NOT_FOUND" };
  }
  const scopeKey = text(advance.financialScopeKey);
  if (scopeKey && !scopeKey.startsWith("legacy:") && !scopeKey.startsWith("individual:") && !scopeKey.startsWith("group:"))
    return { kind: "SCOPE", poolKey: scopeKey };
  return { kind: "REVIEW", poolKey: null, reviewReason: "NO_RECIPIENT_REFERENCE" };
}

type DueLike = {
  recipientScope: string;
  labourGroupId: string | null;
  labourerId: string | null;
  financialScopeKey: string;
};

/**
 * The pool a labour due settles against. A group due always settles against
 * its own group's pool (frozen — posted applications stay with this group). An
 * individual due settles against the labourer's CURRENT pool, so a grouped
 * labourer's earnings settle through their group's combined balance.
 */
export function duePoolKey(due: DueLike, directory: MembershipDirectory): string | null {
  if (due.recipientScope === "LABOUR_GROUP") return due.labourGroupId ? `group:${due.labourGroupId}` : null;
  if (due.recipientScope === "INDIVIDUAL" && due.labourerId)
    return labourerCurrentPoolKey(due.labourerId, directory) ?? `individual:${due.labourerId}`;
  return due.financialScopeKey || null;
}

export type AdvancePoolVoucher = {
  id: string;
  voucherNumber: string;
  voucherDate: string;
  status: string;
  description: string;
  paymentAmount: number;
  paymentAccountId: string | null;
  paymentAccountName: string | null;
  labourerId: string | null;
  labourerName: string | null;
  recipientName: string | null;
  recipientScope: string;
  ownership: AdvancePoolOwnership;
  currentGroupId: string | null;
  currentGroupName: string | null;
  createdAt: Date | null;
};

export type AdvancePoolActivityEvent = {
  id: string;
  poolKey: string | null;
  type: "ADVANCE_RECORDED" | "APPLIED_TO_DUE" | "APPLICATION_REVERSED" | "RECOVERY_RECORDED" | "VOUCHER_REVERSED";
  date: string;
  amount: number;
  direction: 1 | -1;
  voucherNumber: string | null;
  dueNumber: string | null;
  description: string | null;
  recipientName: string | null;
};

export type AdvancePoolPosition = {
  poolKey: string;
  kind: "GROUP" | "INDIVIDUAL" | "SCOPE";
  groupId: string | null;
  groupName: string | null;
  groupLeaderId: string | null;
  groupLeaderName: string | null;
  memberCount: number;
  labourerId: string | null;
  labourerName: string | null;
  totalAdvances: number;
  appliedAdvances: number;
  recoveredAdvances: number;
  /** SIGNED: negative pools are reported, never clamped. */
  availableAdvances: number;
  voucherCount: number;
};

export type AdvancePoolLedger = {
  directory: MembershipDirectory;
  vouchers: AdvancePoolVoucher[];
  pools: Map<string, AdvancePoolPosition>;
  reviewVouchers: Array<AdvancePoolVoucher & { reviewReason: string }>;
  activity: AdvancePoolActivityEvent[];
  farmWide: { totalAdvances: number; appliedAdvances: number; recoveredAdvances: number; availableAdvances: number };
};

/**
 * THE canonical pool calculation. Every consumer — advances page, pool cards,
 * pool details, due settlement preview and posting pre-check, reports — must
 * read pool balances from here (or from the matching SQL guard) and never
 * recompute them independently.
 */
export type AdvancePoolVoucherRow = {
  id: string;
  voucherNumber: string;
  voucherDate: string;
  nature: string;
  status: string;
  description: string;
  paymentAmount: unknown;
  paymentAccountId: string | null;
  labourerId: string | null;
  labourGroupId: string | null;
  financialScopeKey: string;
  recipientScope: string;
  recipientSnapshot: unknown;
  relatedAdvanceVoucherId: string | null;
  reversalReference: string | null;
  createdAt: Date | null;
};

export type AdvancePoolApplicationRow = {
  id: string;
  amount: unknown;
  status: string;
  createdAt: Date | null;
  reversedAt: Date | null;
  dueId: string;
  dueNumber: string;
  dueRecipientScope: string;
  dueLabourGroupId: string | null;
  dueLabourerId: string | null;
  dueFinancialScopeKey: string;
  dueRecipientSnapshot: unknown;
};

export async function loadAdvancePoolLedger(tx: DbClient, ctx: { workspaceId: string; farmId: string; seasonId: string }): Promise<AdvancePoolLedger> {
  const [directory, voucherRows, applicationRows, accountRows] = await Promise.all([
    loadMembershipDirectory(tx, ctx.workspaceId, ctx.farmId),
    tx.select({
      id: labourPaymentVouchers.id,
      voucherNumber: labourPaymentVouchers.voucherNumber,
      voucherDate: labourPaymentVouchers.voucherDate,
      nature: labourPaymentVouchers.nature,
      status: labourPaymentVouchers.status,
      description: labourPaymentVouchers.description,
      paymentAmount: labourPaymentVouchers.paymentAmount,
      paymentAccountId: labourPaymentVouchers.paymentAccountId,
      labourerId: labourPaymentVouchers.labourerId,
      labourGroupId: labourPaymentVouchers.labourGroupId,
      financialScopeKey: labourPaymentVouchers.financialScopeKey,
      recipientScope: labourPaymentVouchers.recipientScope,
      recipientSnapshot: labourPaymentVouchers.recipientSnapshot,
      relatedAdvanceVoucherId: labourPaymentVouchers.relatedAdvanceVoucherId,
      reversalReference: labourPaymentVouchers.reversalReference,
      createdAt: labourPaymentVouchers.createdAt,
    }).from(labourPaymentVouchers).where(and(
      eq(labourPaymentVouchers.workspaceId, ctx.workspaceId),
      eq(labourPaymentVouchers.farmId, ctx.farmId),
      eq(labourPaymentVouchers.seasonId, ctx.seasonId),
      inArray(labourPaymentVouchers.nature, ["ADVANCE", "REFUND_RECOVERY", "REVERSAL"]),
    )),
    tx.select({
      id: labourAdvanceApplications.id,
      amount: labourAdvanceApplications.amount,
      status: labourAdvanceApplications.status,
      createdAt: labourAdvanceApplications.createdAt,
      reversedAt: labourAdvanceApplications.reversedAt,
      dueId: labourDues.id,
      dueNumber: labourDues.dueNumber,
      dueRecipientScope: labourDues.recipientScope,
      dueLabourGroupId: labourDues.labourGroupId,
      dueLabourerId: labourDues.labourerId,
      dueFinancialScopeKey: labourDues.financialScopeKey,
      dueRecipientSnapshot: labourDues.recipientSnapshot,
    }).from(labourAdvanceApplications).innerJoin(labourDues, eq(labourAdvanceApplications.dueId, labourDues.id)).where(and(
      eq(labourDues.workspaceId, ctx.workspaceId),
      eq(labourDues.farmId, ctx.farmId),
      eq(labourDues.seasonId, ctx.seasonId),
      inArray(labourAdvanceApplications.status, ["ACTIVE", "REVERSED"]),
    )),
    tx.select({ id: accounts.id, name: accounts.name }).from(accounts).where(eq(accounts.farmId, ctx.farmId)),
  ]);
  return buildAdvancePoolLedger(directory, voucherRows, applicationRows, new Map(accountRows.map((row) => [row.id, row.name])));
}

/** Pure canonical pool computation — shared by the loader and the unit tests. */
export function buildAdvancePoolLedger(
  directory: MembershipDirectory,
  voucherRows: AdvancePoolVoucherRow[],
  applicationRows: AdvancePoolApplicationRow[],
  accountNameById: Map<string, string> = new Map(),
): AdvancePoolLedger {
  const pools = new Map<string, AdvancePoolPosition>();
  const totalsMinor = new Map<string, { total: number; applied: number; recovered: number; voucherCount: number }>();
  const poolTotals = (poolKey: string) => {
    let entry = totalsMinor.get(poolKey);
    if (!entry) {
      entry = { total: 0, applied: 0, recovered: 0, voucherCount: 0 };
      totalsMinor.set(poolKey, entry);
    }
    return entry;
  };

  const advanceRowById = new Map(voucherRows.filter((row) => row.nature === "ADVANCE").map((row) => [row.id, row]));
  const resolveRow = (row: typeof voucherRows[number]) => resolveAdvancePoolOwnership(row, directory);

  const vouchers: AdvancePoolVoucher[] = [];
  const reviewVouchers: AdvancePoolLedger["reviewVouchers"] = [];
  const activity: AdvancePoolActivityEvent[] = [];

  for (const row of voucherRows) {
    if (row.nature !== "ADVANCE") continue;
    const ownership = resolveRow(row);
    const snapshot = snapshotOf(row.recipientSnapshot);
    const labourerId = advanceRecipientLabourerId(row);
    const labourer = labourerId ? directory.labourers.get(labourerId) ?? null : null;
    const currentGroupId = ownership.kind === "GROUP" ? ownership.groupId : null;
    const voucher: AdvancePoolVoucher = {
      id: row.id,
      voucherNumber: row.voucherNumber,
      voucherDate: row.voucherDate,
      status: row.status,
      description: row.description,
      paymentAmount: toMajor(toMinor(row.paymentAmount)),
      paymentAccountId: row.paymentAccountId,
      paymentAccountName: (row.paymentAccountId ? accountNameById.get(row.paymentAccountId) : null)
        ?? text(snapshot.sourceAccountName),
      labourerId,
      labourerName: labourer?.name ?? text(snapshot.labourerName),
      recipientName: text(snapshot.receivedByNameSnapshot) ?? labourer?.name ?? text(snapshot.labourerName)
        ?? text(snapshot.labourGroupName) ?? text(snapshot.recipientName),
      recipientScope: row.recipientScope,
      ownership,
      currentGroupId,
      currentGroupName: currentGroupId ? directory.groups.get(currentGroupId)?.name ?? null : null,
      createdAt: row.createdAt,
    };
    vouchers.push(voucher);
    if (row.status === "POSTED") {
      if (ownership.poolKey) {
        const entry = poolTotals(ownership.poolKey);
        entry.total += toMinor(row.paymentAmount);
        entry.voucherCount += 1;
      } else {
        reviewVouchers.push({ ...voucher, reviewReason: ownership.kind === "REVIEW" ? ownership.reviewReason : "UNRESOLVED" });
      }
    }
    activity.push({
      id: `advance:${row.id}`,
      poolKey: ownership.poolKey,
      type: "ADVANCE_RECORDED",
      date: row.voucherDate,
      amount: toMajor(toMinor(row.paymentAmount)),
      direction: 1,
      voucherNumber: row.voucherNumber,
      dueNumber: null,
      description: row.description,
      recipientName: voucher.recipientName,
    });
  }

  for (const row of applicationRows) {
    const poolKey = duePoolKey({
      recipientScope: row.dueRecipientScope,
      labourGroupId: row.dueLabourGroupId,
      labourerId: row.dueLabourerId,
      financialScopeKey: row.dueFinancialScopeKey,
    }, directory);
    if (row.status === "ACTIVE" && poolKey) poolTotals(poolKey).applied += toMinor(row.amount);
    const dueSnapshot = snapshotOf(row.dueRecipientSnapshot);
    activity.push({
      id: `application:${row.id}${row.status === "REVERSED" ? ":reversed" : ""}`,
      poolKey,
      type: row.status === "REVERSED" ? "APPLICATION_REVERSED" : "APPLIED_TO_DUE",
      date: (row.status === "REVERSED" && row.reversedAt ? row.reversedAt : row.createdAt)?.toISOString().slice(0, 10) ?? "",
      amount: toMajor(toMinor(row.amount)),
      direction: row.status === "REVERSED" ? 1 : -1,
      voucherNumber: null,
      dueNumber: row.dueNumber,
      description: null,
      recipientName: text(dueSnapshot.groupName) ?? text(dueSnapshot.labourGroupName) ?? text(dueSnapshot.labourerName),
    });
  }

  for (const row of voucherRows) {
    if (row.nature === "REFUND_RECOVERY") {
      if (row.status !== "POSTED") continue;
      // A recovery recorded against a specific historical voucher follows that
      // voucher's current pool; a pool-level recovery follows its own recorded
      // group (frozen) or labourer (current pool).
      const related = row.relatedAdvanceVoucherId ? advanceRowById.get(row.relatedAdvanceVoucherId) : null;
      const ownership = related ? resolveRow(related) : resolveRow(row);
      if (ownership.poolKey) poolTotals(ownership.poolKey).recovered += toMinor(row.paymentAmount);
      activity.push({
        id: `recovery:${row.id}`,
        poolKey: ownership.poolKey,
        type: "RECOVERY_RECORDED",
        date: row.voucherDate,
        amount: toMajor(toMinor(row.paymentAmount)),
        direction: -1,
        voucherNumber: row.voucherNumber,
        dueNumber: null,
        description: row.description,
        recipientName: null,
      });
      continue;
    }
    if (row.nature === "REVERSAL") {
      if (row.status !== "POSTED" || !row.reversalReference) continue;
      const original = advanceRowById.get(row.reversalReference);
      if (!original) continue;
      const ownership = resolveRow(original);
      activity.push({
        id: `reversal:${row.id}`,
        poolKey: ownership.poolKey,
        type: "VOUCHER_REVERSED",
        date: row.voucherDate,
        amount: toMajor(toMinor(row.paymentAmount)),
        direction: -1,
        voucherNumber: original.voucherNumber,
        dueNumber: null,
        description: row.description,
        recipientName: null,
      });
    }
  }

  // Every current group appears as a pool even before its first advance, so
  // the page always shows the group, its leader, and a zero balance.
  for (const group of directory.groups.values()) {
    const poolKey = `group:${group.id}`;
    if (!totalsMinor.has(poolKey)) totalsMinor.set(poolKey, { total: 0, applied: 0, recovered: 0, voucherCount: 0 });
  }

  const farmWideMinor = { total: 0, applied: 0, recovered: 0 };
  for (const [poolKey, entry] of totalsMinor) {
    farmWideMinor.total += entry.total;
    farmWideMinor.applied += entry.applied;
    farmWideMinor.recovered += entry.recovered;
    const availableMinor = entry.total - entry.applied - entry.recovered;
    if (poolKey.startsWith("group:")) {
      const groupId = poolKey.slice("group:".length);
      const group = directory.groups.get(groupId);
      pools.set(poolKey, {
        poolKey,
        kind: "GROUP",
        groupId,
        groupName: group?.name ?? null,
        groupLeaderId: group?.leaderId ?? null,
        groupLeaderName: group?.leaderName ?? null,
        memberCount: group?.memberCount ?? 0,
        labourerId: null,
        labourerName: null,
        totalAdvances: toMajor(entry.total),
        appliedAdvances: toMajor(entry.applied),
        recoveredAdvances: toMajor(entry.recovered),
        availableAdvances: toMajor(availableMinor),
        voucherCount: entry.voucherCount,
      });
    } else if (poolKey.startsWith("individual:")) {
      const labourerId = poolKey.slice("individual:".length);
      pools.set(poolKey, {
        poolKey,
        kind: "INDIVIDUAL",
        groupId: null,
        groupName: null,
        groupLeaderId: null,
        groupLeaderName: null,
        memberCount: 0,
        labourerId,
        labourerName: directory.labourers.get(labourerId)?.name ?? null,
        totalAdvances: toMajor(entry.total),
        appliedAdvances: toMajor(entry.applied),
        recoveredAdvances: toMajor(entry.recovered),
        availableAdvances: toMajor(availableMinor),
        voucherCount: entry.voucherCount,
      });
    } else {
      pools.set(poolKey, {
        poolKey,
        kind: "SCOPE",
        groupId: null,
        groupName: null,
        groupLeaderId: null,
        groupLeaderName: null,
        memberCount: 0,
        labourerId: null,
        labourerName: null,
        totalAdvances: toMajor(entry.total),
        appliedAdvances: toMajor(entry.applied),
        recoveredAdvances: toMajor(entry.recovered),
        availableAdvances: toMajor(availableMinor),
        voucherCount: entry.voucherCount,
      });
    }
  }

  activity.sort((left, right) => right.date.localeCompare(left.date) || right.id.localeCompare(left.id));

  return {
    directory,
    vouchers,
    pools,
    reviewVouchers,
    activity,
    farmWide: {
      totalAdvances: toMajor(farmWideMinor.total),
      appliedAdvances: toMajor(farmWideMinor.applied),
      recoveredAdvances: toMajor(farmWideMinor.recovered),
      availableAdvances: toMajor(farmWideMinor.total - farmWideMinor.applied - farmWideMinor.recovered),
    },
  };
}

/**
 * Pool availability for one due, with the settlement-date rule applied:
 * vouchers dated after the settlement date do not fund it. Signed pool math —
 * when the pool is negative, nothing further can be applied until the data is
 * corrected through a reversal/adjustment flow.
 */
export function dueAdvancePoolPosition(ledger: AdvancePoolLedger, due: DueLike, settlementDate?: string) {
  const poolKey = duePoolKey(due, ledger.directory);
  const pool = poolKey ? ledger.pools.get(poolKey) ?? null : null;
  let availableMinor = pool ? Math.round(pool.availableAdvances * 100) : 0;
  if (pool && settlementDate) {
    for (const voucher of ledger.vouchers) {
      if (voucher.status !== "POSTED") continue;
      if (voucher.ownership.poolKey !== poolKey) continue;
      if (voucher.voucherDate > settlementDate) availableMinor -= Math.round(voucher.paymentAmount * 100);
    }
  }
  return { poolKey, pool, availableAdvances: toMajor(availableMinor) };
}
