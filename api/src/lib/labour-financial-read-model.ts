import { and, eq, inArray, or } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  accounts,
  accountTransactions,
  advanceRecords,
  auditLogs,
  labourAccountingEntries,
  labourAdvanceApplications,
  labourDues,
  labourGroups,
  labourPaymentAllocations,
  labourPaymentVouchers,
  labourers,
  labourWageSettlementAdvanceAllocations,
  operationalRecords,
  users,
} from "../db/schema.js";
import { resolveAccountIdentity, type AccountIdentityLike } from "./account-identity.js";
import { legacyAdvancePosition, mergeAdvancePositions, type LegacyAdvanceReadRow } from "./labour-advance-read-model.js";

const amount = (value: unknown) => Number(Number(value ?? 0).toFixed(2));
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const originalEventBase = (entryKey: string) => entryKey.replace(/:(debit|credit)$/, "");

const firstText = (...values: unknown[]) => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
};

const asSnapshot = (value: unknown) => (value && typeof value === "object" ? value as Record<string, unknown> : {});

const mergeSnapshotFields = (...values: unknown[]) => {
  const merged: Record<string, unknown> = {};
  const absorb = (value: unknown) => {
    const snapshot = asSnapshot(value);
    for (const [key, candidate] of Object.entries(snapshot)) {
      if (!(key in merged) && !(typeof candidate === "string" && !candidate.trim()) && candidate != null) merged[key] = candidate;
    }
    const nested = asSnapshot(snapshot.recipientSnapshot);
    for (const [key, candidate] of Object.entries(nested)) {
      if (!(key in merged) && !(typeof candidate === "string" && !candidate.trim()) && candidate != null) merged[key] = candidate;
    }
  };
  for (const value of values) absorb(value);
  return merged;
};

const unresolvedRecipientLabel = "Unresolved recipient";
const unresolvedPaymentSourceLabel = "Unresolved payment source";

const resolveRecipientDisplayName = (args: {
  snapshot: Record<string, unknown>;
  recipientScope?: string | null;
  labourerName?: string | null;
  labourGroupName?: string | null;
}) => {
  const { snapshot, recipientScope, labourerName, labourGroupName } = args;
  if (recipientScope === "LABOUR_GROUP") {
    return firstText(
      snapshot.labourGroupName,
      labourGroupName,
      snapshot.recipientName,
      snapshot.groupName,
      snapshot.manualRecipientName,
      snapshot.crewReference,
      snapshot.contractorReference,
      snapshot.batchIdentity,
      snapshot.recipientReference,
    ) ?? unresolvedRecipientLabel;
  }
  if (recipientScope === "INDIVIDUAL") {
    return firstText(
      snapshot.labourerName,
      labourerName,
      snapshot.recipientName,
      snapshot.receivedByNameSnapshot,
      snapshot.receivedBy,
      snapshot.manualRecipientName,
      snapshot.contactPerson,
      snapshot.recipientReference,
    ) ?? unresolvedRecipientLabel;
  }
  return firstText(
    snapshot.recipientName,
    snapshot.manualRecipientName,
    snapshot.contactPerson,
    snapshot.recipientReference,
    snapshot.crewReference,
    snapshot.contractorReference,
    snapshot.batchIdentity,
    labourGroupName,
    labourerName,
    snapshot.labourGroupName,
    snapshot.labourerName,
  ) ?? unresolvedRecipientLabel;
};

const resolveReceivedByDisplayName = (args: {
  snapshot: Record<string, unknown>;
  recipientScope?: string | null;
  labourerName?: string | null;
  recipientDisplayName: string;
}) => {
  const { snapshot, recipientScope, labourerName, recipientDisplayName } = args;
  if (recipientScope === "LABOUR_GROUP") {
    return firstText(
      snapshot.receivedByNameSnapshot,
      snapshot.receivedBy,
      snapshot.labourerName,
      labourerName,
    );
  }
  return recipientDisplayName;
};

const resolvePaymentSourceDisplayName = (args: {
  funding: ResolvedFundingAccount;
  snapshot?: Record<string, unknown>;
  sourcePayload?: Record<string, unknown>;
}) =>
  firstText(
    args.funding.partnerName,
    args.funding.accountName,
    args.snapshot?.paymentAccountName,
    args.snapshot?.sourceAccountName,
    args.snapshot?.partnerName,
    args.sourcePayload?.paymentAccountName,
    args.sourcePayload?.sourceAccountName,
    args.sourcePayload?.partnerName,
  ) ?? unresolvedPaymentSourceLabel;

type ResolvedFundingAccount = {
  accountId: string | null;
  accountName: string | null;
  accountType: string | null;
  partnerId: string | null;
  partnerName: string | null;
  needsReview: boolean;
  reviewReason: string | null;
};

type UnifiedAdvancePosition = {
  advancePositionId: string;
  canonicalVoucherId: string | null;
  legacySourceRecordId: string | null;
  sourceClassification: "CANONICAL" | "CANONICAL_LINKED_LEGACY" | "LEGACY_OPERATIONAL" | "LEGACY_NORMALIZED";
  voucherId: string;
  voucherNumber: string;
  voucherDate: string;
  advanceDate: string;
  labourerId: string | null;
  labourerName: string | null;
  labourGroupId: string | null;
  labourGroupName: string | null;
  recipientScope: string;
  recipientName: string;
  recipientDisplayName: string;
  receivedByDisplayName: string | null;
  fundingAccountId: string | null;
  fundingAccountName: string | null;
  paymentSourceId: string | null;
  paymentSourceDisplayName: string;
  paymentSourceType: string | null;
  accountId: string | null;
  accountName: string | null;
  fundingType: string | null;
  partnerId: string | null;
  partnerName: string | null;
  originalAmount: number;
  appliedAmount: number;
  recoveredAmount: number;
  outstandingAmount: number;
  status: string;
  description: string;
  sourceId: string | null;
  relatedApplicationIds: string[];
  relatedRecoveryVoucherIds: string[];
  needsReview: boolean;
  reviewReason: string | null;
  legacy: boolean;
  canonical: boolean;
};

type AdvanceApplicationParent = {
  id: string;
  parentVoucherId: string | null;
  voucherNumber: string;
  displayVoucherNumber: string;
  date: string;
  postedAt: string;
  dueId: string;
  dueNumber: string | null;
  workFromDate: string | null;
  workToDate: string | null;
  recipientScope: string | null;
  labourerId: string | null;
  labourGroupId: string | null;
  recipientName: string;
  description: string;
  paymentMethod: "Applied advances";
  originalAmount: number;
  activeAmount: number;
  recoveredAmount: number;
  status: "POSTED" | "PARTIALLY_REVERSED" | "REVERSED";
  createdAt: string;
  createdByName: string | null;
  childApplicationIds: string[];
  activeChildApplicationIds: string[];
  childAllocationTotal: number;
  activeChildAllocationTotal: number;
  dueOutstandingAfterPosting: number | null;
  sourceType: "AUDIT_EVENT" | "PARENT_VOUCHER";
};

function resolveFundingAccount(args: {
  accountById: Map<string, typeof accounts.$inferSelect>;
  storedAccountId?: string | null;
  transactionAccountId?: string | null;
  sourceSnapshot?: Record<string, unknown>;
  sourcePayload?: Record<string, unknown>;
}): ResolvedFundingAccount {
  const accountLike = [...args.accountById.values()] as AccountIdentityLike[];
  const fromStored = args.storedAccountId ? args.accountById.get(args.storedAccountId) : undefined;
  if (fromStored) {
    return {
      accountId: fromStored.id,
      accountName: fromStored.name,
      accountType: fromStored.accountType,
      partnerId: fromStored.accountType === "partner" ? fromStored.id : null,
      partnerName: fromStored.accountType === "partner" ? fromStored.name : null,
      needsReview: false,
      reviewReason: null,
    };
  }
  const fromTransaction = args.transactionAccountId ? args.accountById.get(args.transactionAccountId) : undefined;
  if (fromTransaction) {
    return {
      accountId: fromTransaction.id,
      accountName: fromTransaction.name,
      accountType: fromTransaction.accountType,
      partnerId: fromTransaction.accountType === "partner" ? fromTransaction.id : null,
      partnerName: fromTransaction.accountType === "partner" ? fromTransaction.name : null,
      needsReview: false,
      reviewReason: null,
    };
  }
  const payload = args.sourcePayload ?? {};
  const snapshot = args.sourceSnapshot ?? {};
  const stableCandidates = [
    firstText(payload.paymentAccountCanonicalId, payload.paymentAccountId, payload.linkedAccountId, payload.accountId, payload.partnerAccountId),
    firstText(snapshot.paymentAccountCanonicalId, snapshot.paymentAccountId, snapshot.linkedAccountId, snapshot.accountId, snapshot.partnerAccountId),
    firstText(payload.oldPaymentAccountId, payload.oldAccountId, payload.payment_account_id, payload.account_id),
    firstText(snapshot.oldPaymentAccountId, snapshot.oldAccountId, snapshot.payment_account_id, snapshot.account_id),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of stableCandidates) {
    const resolved = resolveAccountIdentity(candidate, accountLike);
    if (!resolved.canonicalAccountId || !resolved.matchedAccount) continue;
    if (resolved.matchedBy === "name_fallback") break;
    const account = args.accountById.get(resolved.canonicalAccountId) ?? null;
    if (!account) continue;
    return {
      accountId: account.id,
      accountName: account.name,
      accountType: account.accountType,
      partnerId: account.accountType === "partner" ? account.id : null,
      partnerName: account.accountType === "partner" ? account.name : null,
      needsReview: false,
      reviewReason: null,
    };
  }
  const sourceName = firstText(
    payload.paymentAccountName,
    payload.sourceAccountName,
    payload.partnerName,
    snapshot.paymentAccountName,
    snapshot.sourceAccountName,
    snapshot.partnerName,
  );
  return {
    accountId: null,
    accountName: sourceName ?? null,
    accountType: null,
    partnerId: null,
    partnerName: null,
    needsReview: true,
    reviewReason: sourceName ? "Stable account mapping is missing for this historical funding source." : "Funding account could not be resolved from canonical or preserved legacy identifiers.",
  };
}

function positionStatus(args: { status: string; outstandingAmount: number; appliedAmount: number; recoveredAmount: number }) {
  if (args.status === "VOIDED") return "VOIDED";
  if (args.outstandingAmount <= 0.005 && args.recoveredAmount > 0) return "FULLY_REFUNDED";
  if (args.outstandingAmount <= 0.005 && args.appliedAmount > 0) return "FULLY_APPLIED";
  if (args.recoveredAmount > 0) return "PARTIALLY_REFUNDED";
  if (args.appliedAmount > 0) return "PARTIALLY_APPLIED";
  return "OUTSTANDING";
}

function aggregateApplicationVoucherNumber(value: string) {
  return `LPV-AP-${value.slice(0, 8).toUpperCase()}`;
}

async function loadUnifiedAdvancePositions(input: { workspaceId: string; farmId: string; seasonId: string }, scopedAccounts: typeof accounts.$inferSelect[], transactions: typeof accountTransactions.$inferSelect[], vouchers: typeof labourPaymentVouchers.$inferSelect[]) {
  const accountById = new Map(scopedAccounts.map((row) => [row.id, row]));
  const transactionById = new Map(transactions.map((row) => [row.id, row]));
  const voucherSourceRecordIds = [...new Set(vouchers.flatMap((row) => [row.legacySourceRecordId]).filter((value): value is string => Boolean(value)))];
  const voucherSourceClientIds = [...new Set(vouchers.flatMap((row) => [row.sourceId]).filter((value): value is string => Boolean(value)))];
  const sourceQueries: Array<Promise<typeof operationalRecords.$inferSelect[]>> = [];
  if (voucherSourceRecordIds.length) {
    sourceQueries.push(db.select().from(operationalRecords).where(and(eq(operationalRecords.workspaceId, input.workspaceId), inArray(operationalRecords.id, voucherSourceRecordIds))));
  }
  if (voucherSourceClientIds.length) {
    sourceQueries.push(db.select().from(operationalRecords).where(and(eq(operationalRecords.workspaceId, input.workspaceId), inArray(operationalRecords.clientRecordId, voucherSourceClientIds))));
  }
  sourceQueries.push(
    db.select().from(operationalRecords).where(and(eq(operationalRecords.workspaceId, input.workspaceId), eq(operationalRecords.entityType, "advance"))),
  );
  const [applicationRows, labourerRows, groupRows, operationalLabourerRows, operationalGroupRows, legacySettlementApplications, normalizedRows, ...sourceResultSets] = await Promise.all([
    db.select().from(labourAdvanceApplications).where(eq(labourAdvanceApplications.workspaceId, input.workspaceId)),
    db.select().from(labourers),
    db.select().from(labourGroups),
    db.select({ clientRecordId: operationalRecords.clientRecordId, payload: operationalRecords.payload }).from(operationalRecords).where(and(eq(operationalRecords.workspaceId, input.workspaceId), eq(operationalRecords.farmId, input.farmId), eq(operationalRecords.entityType, "labourer"))),
    db.select({ clientRecordId: operationalRecords.clientRecordId, payload: operationalRecords.payload }).from(operationalRecords).where(and(eq(operationalRecords.workspaceId, input.workspaceId), eq(operationalRecords.farmId, input.farmId), eq(operationalRecords.entityType, "labourGroup"))),
    db.select().from(labourWageSettlementAdvanceAllocations).where(eq(labourWageSettlementAdvanceAllocations.workspaceId, input.workspaceId)),
    db.select().from(advanceRecords).where(and(eq(advanceRecords.farmId, input.farmId), eq(advanceRecords.seasonId, input.seasonId))),
    ...sourceQueries,
  ]);
  const sourceRecords = sourceResultSets.flat();
  const sourceById = new Map(sourceRecords.map((row) => [row.id, row]));
  const sourceByClientId = new Map(sourceRecords.map((row) => [row.clientRecordId, row]));
  const labourerById = new Map(labourerRows.map((row) => [row.id, row]));
  const groupById = new Map(groupRows.map((row) => [row.id, row]));
  const operationalLabourerNameByClientId = new Map(operationalLabourerRows.map((row) => [row.clientRecordId, firstText(asSnapshot(row.payload).name) ?? null]));
  const operationalGroupNameByClientId = new Map(operationalGroupRows.map((row) => [row.clientRecordId, firstText(asSnapshot(row.payload).name) ?? null]));
  const canonicalAdvances = vouchers.filter((row) => row.nature === "ADVANCE").map((advance) => {
    const appliedAmount = applicationRows.filter((row) => row.advanceVoucherId === advance.id && row.status === "ACTIVE").reduce((sum, row) => sum + amount(row.amount), 0);
    const recoveredAmount = vouchers
      .filter((row) => row.relatedAdvanceVoucherId === advance.id && row.nature === "REFUND_RECOVERY" && row.status === "POSTED")
      .reduce((sum, row) => sum + amount(row.paymentAmount), 0);
    const sourceRecord = (advance.legacySourceRecordId ? sourceById.get(advance.legacySourceRecordId) : undefined) ?? (advance.sourceId ? sourceByClientId.get(advance.sourceId) : undefined);
    const mergedSnapshot = mergeSnapshotFields(advance.recipientSnapshot, sourceRecord?.payload);
    const funding = resolveFundingAccount({
      accountById,
      storedAccountId: advance.paymentAccountId,
      transactionAccountId: advance.accountTransactionId ? transactionById.get(advance.accountTransactionId)?.accountId ?? null : null,
      sourceSnapshot: mergedSnapshot,
      sourcePayload: asSnapshot(sourceRecord?.payload),
    });
    const snapshot = mergedSnapshot;
    const labourerId = advance.labourerId
      ?? (advance.recipientScope === "INDIVIDUAL" ? firstText(snapshot.labourerId, snapshot.labourId, snapshot.receivedByLabourerId) : null);
    const labourGroupId = advance.labourGroupId ?? firstText(snapshot.labourGroupId, snapshot.groupId, snapshot.recipientGroupId);
    const labourerName = firstText(
      snapshot.labourerName,
      snapshot.receivedByNameSnapshot,
      labourerId && uuidPattern.test(labourerId) ? labourerById.get(labourerId)?.name ?? null : null,
      labourerId ? operationalLabourerNameByClientId.get(labourerId) ?? null : null,
    );
    const labourGroupName = firstText(
      snapshot.labourGroupName,
      snapshot.groupName,
      labourGroupId && uuidPattern.test(labourGroupId) ? groupById.get(labourGroupId)?.name ?? null : null,
      labourGroupId ? operationalGroupNameByClientId.get(labourGroupId) ?? null : null,
    );
    const recipientDisplayName = resolveRecipientDisplayName({
      snapshot,
      recipientScope: advance.recipientScope,
      labourerName,
      labourGroupName,
    });
    const receivedByDisplayName = resolveReceivedByDisplayName({
      snapshot,
      recipientScope: advance.recipientScope,
      labourerName,
      recipientDisplayName,
    });
    const paymentSourceDisplayName = resolvePaymentSourceDisplayName({
      funding,
      snapshot,
      sourcePayload: asSnapshot(sourceRecord?.payload),
    });
    const originalAmount = amount(advance.paymentAmount);
    const outstandingAmount = advance.status === "VOIDED" ? 0 : amount(Math.max(originalAmount - appliedAmount - recoveredAmount, 0));
    return {
      id: advance.id,
      advancePositionId: `voucher:${advance.id}`,
      canonicalVoucherId: advance.id,
      legacySourceRecordId: advance.legacySourceRecordId ?? null,
      sourceClassification: advance.legacySourceRecordId || sourceByClientId.has(advance.sourceId ?? "") ? "CANONICAL_LINKED_LEGACY" : "CANONICAL",
      voucherId: advance.id,
      voucherNumber: advance.voucherNumber,
      voucherDate: advance.voucherDate,
      advanceDate: advance.voucherDate,
      labourerId: labourerId ?? null,
      labourerName,
      labourGroupId: labourGroupId ?? null,
      labourGroupName,
      recipientScope: advance.recipientScope,
      recipientName: recipientDisplayName,
      recipientDisplayName,
      receivedByDisplayName,
      fundingAccountId: funding.accountId,
      fundingAccountName: paymentSourceDisplayName,
      paymentSourceId: funding.partnerId ?? funding.accountId,
      paymentSourceDisplayName,
      paymentSourceType: funding.accountType ?? advance.paymentMethod ?? null,
      fundingType: funding.accountType ?? advance.paymentMethod ?? null,
      partnerId: funding.partnerId,
      partnerName: funding.partnerName ?? firstText(snapshot.partnerName),
      originalAmount,
      appliedAmount: amount(appliedAmount),
      recoveredAmount: amount(recoveredAmount),
      outstandingAmount,
      status: positionStatus({ status: advance.status, outstandingAmount, appliedAmount, recoveredAmount }),
      description: advance.description,
      sourceId: advance.sourceId ?? null,
      createdAt: advance.createdAt.toISOString(),
      relatedApplicationIds: applicationRows.filter((row) => row.advanceVoucherId === advance.id).map((row) => row.id),
      relatedRecoveryVoucherIds: vouchers.filter((row) => row.relatedAdvanceVoucherId === advance.id && row.nature === "REFUND_RECOVERY").map((row) => row.id),
      needsReview: funding.needsReview || advance.reconciliationStatus === "NEEDS_REVIEW" || advance.reconciliationStatus === "LEGACY_UNLINKED",
      reviewReason: funding.reviewReason ?? (advance.reconciliationStatus === "NEEDS_REVIEW" || advance.reconciliationStatus === "LEGACY_UNLINKED" ? "Historical voucher is still marked for reconciliation review." : null),
      legacy: advance.legacy,
      canonical: true,
      accountId: funding.accountId,
      accountName: funding.accountName,
      groupName: labourGroupName,
      partnerAccountId: funding.partnerId,
    };
  });

  const coveredLegacyIds = new Set(canonicalAdvances.flatMap((row) => [row.legacySourceRecordId, row.sourceId]).filter((value): value is string => Boolean(value)));
  const legacyOperationalRows: LegacyAdvanceReadRow[] = sourceRecords
    .filter((record) => record.entityType === "advance")
    .filter((record) => {
      const payload = asSnapshot(record.payload);
      const amountValue = Number(payload.amount ?? 0);
      if (!Number.isFinite(amountValue) || amountValue <= 0) return false;
      const farmMatches = record.farmId === input.farmId || record.farmId === null;
      const seasonMatches = record.seasonId === input.seasonId || record.seasonId === null;
      return farmMatches && seasonMatches && !coveredLegacyIds.has(record.id) && !coveredLegacyIds.has(record.clientRecordId);
    })
    .map((record) => {
      const payload = mergeSnapshotFields(record.payload);
      const funding = resolveFundingAccount({
        accountById,
        sourcePayload: payload,
        sourceSnapshot: payload,
      });
      const labourGroupId = firstText(payload.labourGroupId, payload.groupId, payload.recipientGroupId);
      const labourerId = firstText(payload.labourerId, payload.labourId, payload.receivedByLabourerId);
      return {
        id: record.id,
        sourceId: record.id,
        voucherNumber: firstText(payload.voucherNumber, payload.voucherNo, payload.reference) ?? `ADV-L-${record.clientRecordId.slice(0, 8).toUpperCase()}`,
        voucherDate: firstText(payload.date, payload.advanceDate) ?? record.createdAt.toISOString().slice(0, 10),
        recipientScope: labourGroupId ? "LABOUR_GROUP" : "INDIVIDUAL",
        financialScopeKey: labourGroupId ? `group:${labourGroupId}` : `individual:${firstText(labourerId, record.clientRecordId)}`,
        labourerId,
        labourGroupId,
        recipientSnapshot: payload,
        description: firstText(payload.notes) ?? "Legacy labour advance",
        originalAmount: amount(payload.amount),
        appliedAmount: legacySettlementApplications.filter((row) => row.advanceRecordId === record.id).reduce((sum, row) => sum + amount(row.absorbedAmount), 0),
        refundedAmount: 0,
        reversedAmount: firstText(payload.deletedAt, payload.voidedAt, payload.reversedAt) || ["voided", "deleted", "reversed"].includes(String(payload.status ?? "").toLowerCase()) ? amount(payload.amount) : 0,
        paymentAccountId: funding.accountId,
        paymentAccountName: funding.accountName,
        status: firstText(payload.deletedAt, payload.voidedAt, payload.reversedAt) || ["voided", "deleted", "reversed"].includes(String(payload.status ?? "").toLowerCase()) ? "VOIDED" : "POSTED",
        createdAt: record.createdAt.toISOString(),
        sourceKind: "LEGACY_OPERATIONAL",
      } satisfies LegacyAdvanceReadRow;
    });
  const legacyNormalizedRows: LegacyAdvanceReadRow[] = normalizedRows
    .filter((record) => !coveredLegacyIds.has(record.id))
    .filter((record) => !sourceRecords.some((source) => source.entityType === "advance" && asSnapshot(source.payload).normalizedAdvanceRecordId === record.id))
    .map((record) => {
      const funding = resolveFundingAccount({ accountById, storedAccountId: record.accountId });
      const labourer = labourerById.get(record.labourerId);
      return {
        id: record.id,
        sourceId: record.id,
        voucherNumber: `ADV-N-${record.id.slice(0, 8).toUpperCase()}`,
        voucherDate: record.advanceDate,
        recipientScope: "INDIVIDUAL",
        financialScopeKey: `individual:${record.labourerId}`,
        labourerId: record.labourerId,
        labourGroupId: null,
        recipientSnapshot: { labourerName: labourer?.name ?? operationalLabourerNameByClientId.get(record.labourerId) ?? "Labour" },
        description: record.description ?? "Legacy labour advance",
        originalAmount: amount(record.amount),
        appliedAmount: 0,
        refundedAmount: 0,
        reversedAmount: 0,
        paymentAccountId: funding.accountId,
        paymentAccountName: funding.accountName,
        status: "POSTED",
        createdAt: record.createdAt.toISOString(),
        sourceKind: "LEGACY_NORMALIZED",
      } satisfies LegacyAdvanceReadRow;
    });

  const unified = mergeAdvancePositions(canonicalAdvances, [...legacyOperationalRows.map(legacyAdvancePosition), ...legacyNormalizedRows.map(legacyAdvancePosition)]) as unknown as Array<UnifiedAdvancePosition & Record<string, unknown>>;
  return unified.map((row) => {
    const classification = row.canonicalVoucherId
      ? row.sourceClassification
      : row.legacySourceRecordId
        ? "LEGACY_OPERATIONAL"
        : "LEGACY_NORMALIZED";
    const sourcePayload = row.legacySourceRecordId ? sourceById.get(row.legacySourceRecordId)?.payload : undefined;
    const resolvedFunding = row.canonicalVoucherId ? null : resolveFundingAccount({
      accountById,
      storedAccountId: typeof row.paymentAccountId === "string" ? row.paymentAccountId : null,
      sourcePayload: asSnapshot(sourcePayload),
      sourceSnapshot: mergeSnapshotFields(row.recipientSnapshot, sourcePayload),
    });
    const sourceSnapshot = mergeSnapshotFields(row.recipientSnapshot, sourcePayload);
    const labourerId = typeof row.labourerId === "string" && row.labourerId.trim()
      ? row.labourerId
      : String(row.recipientScope) === "INDIVIDUAL"
        ? firstText(sourceSnapshot.labourerId, sourceSnapshot.labourId, sourceSnapshot.receivedByLabourerId)
        : null;
    const labourGroupId = typeof row.labourGroupId === "string" && row.labourGroupId.trim()
      ? row.labourGroupId
      : firstText(sourceSnapshot.labourGroupId, sourceSnapshot.groupId, sourceSnapshot.recipientGroupId);
    const labourerName = firstText(
      sourceSnapshot.labourerName,
      sourceSnapshot.receivedByNameSnapshot,
      labourerId && uuidPattern.test(labourerId) ? labourerById.get(labourerId)?.name ?? null : null,
      labourerId ? operationalLabourerNameByClientId.get(labourerId) ?? null : null,
    );
    const labourGroupName = firstText(
      sourceSnapshot.labourGroupName,
      sourceSnapshot.groupName,
      labourGroupId && uuidPattern.test(labourGroupId) ? groupById.get(labourGroupId)?.name ?? null : null,
      labourGroupId ? operationalGroupNameByClientId.get(labourGroupId) ?? null : null,
    );
    const recipientDisplayName = resolveRecipientDisplayName({
      snapshot: sourceSnapshot,
      recipientScope: String(row.recipientScope),
      labourerName,
      labourGroupName,
    });
    const receivedByDisplayName = resolveReceivedByDisplayName({
      snapshot: sourceSnapshot,
      recipientScope: String(row.recipientScope),
      labourerName,
      recipientDisplayName,
    });
    const paymentSourceDisplayName = resolvePaymentSourceDisplayName({
      funding: resolvedFunding ?? {
        accountId: null,
        accountName: typeof row.fundingAccountName === "string" ? row.fundingAccountName : typeof row.paymentAccountName === "string" ? row.paymentAccountName : null,
        accountType: typeof row.fundingType === "string" ? row.fundingType : null,
        partnerId: typeof row.partnerId === "string" ? row.partnerId : null,
        partnerName: typeof row.partnerName === "string" ? row.partnerName : null,
        needsReview: Boolean(row.needsReview),
        reviewReason: typeof row.reviewReason === "string" ? row.reviewReason : null,
      },
      snapshot: sourceSnapshot,
      sourcePayload: asSnapshot(sourcePayload),
    });
    return {
      advancePositionId: row.advancePositionId ?? `legacy:${row.id}`,
      canonicalVoucherId: row.canonicalVoucherId ?? null,
      legacySourceRecordId: row.legacySourceRecordId ?? (classification === "LEGACY_OPERATIONAL" ? String(row.sourceId ?? row.id) : null),
      sourceClassification: classification,
      voucherId: String(row.id),
      voucherNumber: String(row.voucherNumber),
      voucherDate: String(row.voucherDate),
      advanceDate: String(row.voucherDate),
      labourerId,
      labourerName,
      labourGroupId,
      labourGroupName,
      recipientScope: String(row.recipientScope),
      recipientName: recipientDisplayName,
      recipientDisplayName,
      receivedByDisplayName,
      fundingAccountId: typeof row.fundingAccountId === "string" ? row.fundingAccountId : resolvedFunding?.accountId ?? null,
      fundingAccountName: paymentSourceDisplayName,
      paymentSourceId: typeof row.partnerId === "string" ? row.partnerId : typeof row.fundingAccountId === "string" ? row.fundingAccountId : resolvedFunding?.partnerId ?? resolvedFunding?.accountId ?? null,
      paymentSourceDisplayName,
      paymentSourceType: typeof row.fundingType === "string" ? row.fundingType : resolvedFunding?.accountType ?? null,
      accountId: typeof row.fundingAccountId === "string" ? row.fundingAccountId : resolvedFunding?.accountId ?? null,
      accountName: paymentSourceDisplayName,
      fundingType: typeof row.fundingType === "string" ? row.fundingType : resolvedFunding?.accountType ?? null,
      partnerId: typeof row.partnerId === "string" ? row.partnerId : resolvedFunding?.partnerId ?? null,
      partnerName: typeof row.partnerName === "string" ? row.partnerName : resolvedFunding?.partnerName ?? null,
      originalAmount: amount(row.originalAmount),
      appliedAmount: amount(row.appliedAmount),
      recoveredAmount: amount(row.recoveredAmount ?? row.refundedAmount ?? 0),
      outstandingAmount: amount(row.outstandingAmount),
      status: String(row.status),
      description: String(row.description ?? "Labour advance"),
      sourceId: typeof row.sourceId === "string" ? row.sourceId : null,
      relatedApplicationIds: Array.isArray(row.relatedApplicationIds) ? row.relatedApplicationIds.map(String) : [],
      relatedRecoveryVoucherIds: Array.isArray(row.relatedRecoveryVoucherIds) ? row.relatedRecoveryVoucherIds.map(String) : [],
      needsReview: Boolean(row.needsReview ?? resolvedFunding?.needsReview),
      reviewReason: typeof row.reviewReason === "string" ? row.reviewReason : resolvedFunding?.reviewReason ?? null,
      legacy: Boolean(row.legacy ?? !row.canonicalVoucherId),
      canonical: Boolean(row.canonical ?? row.canonicalVoucherId),
    } satisfies UnifiedAdvancePosition;
  });
}

async function loadVoucherSourceMaps(workspaceId: string, vouchers: typeof labourPaymentVouchers.$inferSelect[]) {
  const voucherSourceRecordIds = [...new Set(vouchers.flatMap((row) => [row.legacySourceRecordId]).filter((value): value is string => Boolean(value)))];
  const voucherSourceClientIds = [...new Set(vouchers.flatMap((row) => [row.sourceId]).filter((value): value is string => Boolean(value)))];
  const sourceQueries: Array<Promise<typeof operationalRecords.$inferSelect[]>> = [];
  if (voucherSourceRecordIds.length) {
    sourceQueries.push(db.select().from(operationalRecords).where(and(eq(operationalRecords.workspaceId, workspaceId), inArray(operationalRecords.id, voucherSourceRecordIds))));
  }
  if (voucherSourceClientIds.length) {
    sourceQueries.push(db.select().from(operationalRecords).where(and(eq(operationalRecords.workspaceId, workspaceId), inArray(operationalRecords.clientRecordId, voucherSourceClientIds))));
  }
  const sourceRows = (await Promise.all(sourceQueries)).flat();
  return {
    sourceById: new Map(sourceRows.map((row) => [row.id, row])),
    sourceByClientId: new Map(sourceRows.map((row) => [row.clientRecordId, row])),
  };
}

export async function loadLabourFinancialReadModel(input: { workspaceId: string; farmId: string; seasonId: string }) {
  const [scopeAccounts, transactions, vouchers, dues, applications, allocations, journal, logs, userRows, labourerRows, groupRows] = await Promise.all([
    db.select().from(accounts).where(eq(accounts.farmId, input.farmId)),
    db.select().from(accountTransactions).where(and(eq(accountTransactions.farmId, input.farmId), eq(accountTransactions.seasonId, input.seasonId))),
    db.select().from(labourPaymentVouchers).where(and(eq(labourPaymentVouchers.workspaceId, input.workspaceId), eq(labourPaymentVouchers.farmId, input.farmId), eq(labourPaymentVouchers.seasonId, input.seasonId))),
    db.select().from(labourDues).where(and(eq(labourDues.workspaceId, input.workspaceId), eq(labourDues.farmId, input.farmId), eq(labourDues.seasonId, input.seasonId))),
    db.select().from(labourAdvanceApplications).where(eq(labourAdvanceApplications.workspaceId, input.workspaceId)),
    db.select().from(labourPaymentAllocations).where(eq(labourPaymentAllocations.workspaceId, input.workspaceId)),
    db.select().from(labourAccountingEntries).where(and(eq(labourAccountingEntries.workspaceId, input.workspaceId), eq(labourAccountingEntries.farmId, input.farmId), eq(labourAccountingEntries.seasonId, input.seasonId))),
    db.select().from(auditLogs).where(and(eq(auditLogs.workspaceId, input.workspaceId), eq(auditLogs.farmId, input.farmId))),
    db.select({ id: users.id, displayName: users.displayName, email: users.email }).from(users),
    db.select().from(labourers),
    db.select().from(labourGroups),
  ]);
  const dueIds = new Set(dues.map((row) => row.id));
  const scopedApplications = applications.filter((row) => dueIds.has(row.dueId));
  const scopedAllocations = allocations.filter((row) => dueIds.has(row.dueId));
  const accountById = new Map(scopeAccounts.map((row) => [row.id, row]));
  const voucherById = new Map(vouchers.map((row) => [row.id, row]));
  const dueById = new Map(dues.map((row) => [row.id, row]));
  const applicationById = new Map(scopedApplications.map((row) => [row.id, row]));
  const transactionById = new Map(transactions.map((row) => [row.id, row]));
  const userById = new Map(userRows.map((row) => [row.id, row]));
  const labourerById = new Map(labourerRows.map((row) => [row.id, row]));
  const groupById = new Map(groupRows.map((row) => [row.id, row]));
  const advancePositions = await loadUnifiedAdvancePositions(input, scopeAccounts, transactions, vouchers);
  const advanceByVoucherId = new Map(advancePositions.filter((row) => row.canonicalVoucherId).map((row) => [row.canonicalVoucherId!, row]));
  const { sourceById, sourceByClientId } = await loadVoucherSourceMaps(input.workspaceId, vouchers);
  const resolvedFundingByVoucherId = new Map(vouchers.map((voucher) => {
    const sourceRecord = (voucher.legacySourceRecordId ? sourceById.get(voucher.legacySourceRecordId) : undefined)
      ?? (voucher.sourceId ? sourceByClientId.get(voucher.sourceId) : undefined);
    return [voucher.id, resolveFundingAccount({
      accountById,
      storedAccountId: voucher.paymentAccountId,
      transactionAccountId: voucher.accountTransactionId ? transactionById.get(voucher.accountTransactionId)?.accountId ?? null : null,
      sourceSnapshot: asSnapshot(voucher.recipientSnapshot),
      sourcePayload: asSnapshot(sourceRecord?.payload),
    })] as const;
  }));

  const accountEntries = vouchers.flatMap((voucher) => {
    const transaction = voucher.accountTransactionId ? transactionById.get(voucher.accountTransactionId) : undefined;
    const advancePosition = advanceByVoucherId.get(voucher.id);
    const resolvedFunding = resolvedFundingByVoucherId.get(voucher.id);
    const account = (advancePosition?.fundingAccountId ? accountById.get(advancePosition.fundingAccountId) : undefined)
      ?? (resolvedFunding?.accountId ? accountById.get(resolvedFunding.accountId) : undefined)
      ?? (voucher.paymentAccountId ? accountById.get(voucher.paymentAccountId) : undefined)
      ?? (transaction?.accountId ? accountById.get(transaction.accountId) : undefined);
    if (!transaction || !account) return [];
    const numericAmount = amount(transaction.amount);
    const originalVoucher = voucher.nature === "REVERSAL" && voucher.reversalReference
      ? voucherById.get(voucher.reversalReference)
      : undefined;
    const economicNature = originalVoucher?.nature ?? voucher.nature;
    return [{
      id: transaction.id,
      voucherId: voucher.id,
      voucherNumber: voucher.voucherNumber,
      sourceId: voucher.sourceId,
      legacySourceRecordId: voucher.legacySourceRecordId,
      accountId: account.id,
      accountName: account.name,
      accountType: account.accountType,
      transactionType: transaction.type,
      amount: numericAmount,
      balanceEffect: transaction.type === "credit" ? numericAmount : -numericAmount,
      date: transaction.transactionDate,
      nature: voucher.nature,
      economicNature,
      status: voucher.status,
      description: voucher.description,
      reversalReference: voucher.reversalReference,
      recipientScope: voucher.recipientScope,
      labourerId: voucher.labourerId,
      labourGroupId: voucher.labourGroupId,
      recipientName: resolveRecipientDisplayName({
        snapshot: asSnapshot(voucher.recipientSnapshot),
        recipientScope: voucher.recipientScope,
        labourerName: voucher.labourerId ? labourerById.get(voucher.labourerId)?.name ?? null : null,
        labourGroupName: voucher.labourGroupId ? groupById.get(voucher.labourGroupId)?.name ?? null : null,
      }),
      canonical: !voucher.legacy,
      legacy: voucher.legacy,
    }];
  }).sort((left, right) => right.date.localeCompare(left.date) || right.id.localeCompare(left.id));

  const originalById = new Map(journal.filter((row) => !row.reversalOf && row.eventType !== "REVERSAL").map((row) => [row.id, row]));
  const journalGroups = new Map<string, typeof journal>();
  for (const row of journal) {
    const original = row.reversalOf ? originalById.get(row.reversalOf) : row;
    const base = original ? originalEventBase(original.entryKey) : `orphan:${row.id}`;
    const key = row.reversalOf ? `reversal:${base}` : `original:${base}`;
    journalGroups.set(key, [...(journalGroups.get(key) ?? []), row]);
  }
  const journalEvents = [...journalGroups.entries()].map(([key, rows]) => {
    const representative = rows[0]!;
    const original = representative.reversalOf ? originalById.get(representative.reversalOf) : representative;
    const due = original?.dueId ? dueById.get(original.dueId) : undefined;
    const voucher = original?.voucherId ? voucherById.get(original.voucherId) : undefined;
    const application = original?.advanceApplicationId ? applicationById.get(original.advanceApplicationId) : undefined;
    const sourceAdvance = application?.advanceVoucherId ? voucherById.get(application.advanceVoucherId) : undefined;
    const snapshot = asSnapshot(due?.recipientSnapshot ?? voucher?.recipientSnapshot ?? {});
    const sum = (code: string, sign: "debit" | "credit") => rows.filter((row) => row.ledgerCode === code).reduce((total, row) => total + amount(row[sign]) - amount(row[sign === "debit" ? "credit" : "debit"]), 0);
    const isReversal = key.startsWith("reversal:");
    const sourceStatus = (() => {
      if (isReversal) return "REVERSED";
      if (original?.eventType === "ADVANCE_APPLICATION") return application?.status === "ACTIVE" ? "APPLIED" : "REVERSED";
      if (original?.eventType === "DUE_PAYMENT") return voucher?.status === "POSTED" ? "PAID" : voucher?.status ?? representative.status;
      if (original?.eventType === "ADVANCE_REFUND") return voucher?.status === "POSTED" ? "REFUNDED" : voucher?.status ?? representative.status;
      if (voucher) return voucher.status;
      if (due) return due.paymentStatus;
      return representative.status;
    })();
    return {
      id: key,
      eventType: isReversal ? "REVERSAL" : original?.eventType ?? representative.eventType,
      originalEventType: original?.eventType ?? null,
      status: sourceStatus,
      date: (voucher?.voucherDate ?? due?.workToDate ?? representative.postedAt.toISOString().slice(0, 10)),
      postedAt: representative.postedAt.toISOString(),
      dueId: original?.dueId ?? null,
      dueNumber: due?.dueNumber ?? null,
      voucherId: original?.voucherId ?? null,
      voucherNumber: voucher?.voucherNumber ?? null,
      advanceApplicationId: original?.advanceApplicationId ?? null,
      sourceAdvanceVoucherId: application?.advanceVoucherId ?? null,
      sourceAdvanceVoucherNumber: sourceAdvance?.voucherNumber ?? null,
      recipientScope: due?.recipientScope ?? voucher?.recipientScope ?? null,
      financialScopeKey: due?.financialScopeKey ?? voucher?.financialScopeKey ?? null,
      labourerId: due?.labourerId ?? voucher?.labourerId ?? null,
      labourGroupId: due?.labourGroupId ?? voucher?.labourGroupId ?? null,
      recipientName: resolveRecipientDisplayName({
        snapshot,
        recipientScope: due?.recipientScope ?? voucher?.recipientScope ?? null,
        labourerName: (due?.labourerId ?? voucher?.labourerId)
          ? labourerById.get(due?.labourerId ?? voucher?.labourerId ?? "")?.name ?? null
          : null,
        labourGroupName: (due?.labourGroupId ?? voucher?.labourGroupId)
          ? groupById.get(due?.labourGroupId ?? voucher?.labourGroupId ?? "")?.name ?? null
          : null,
      }),
      description: voucher?.description ?? due?.description ?? (isReversal ? "Financial reversal" : "Labour financial event"),
      legacy: Boolean(due?.legacy || voucher?.legacy),
      amount: amount(Math.max(Math.abs(sum("LABOUR_ADVANCE", "debit")), Math.abs(sum("LABOUR_PAYABLE", "credit")), Math.abs(sum("LABOUR_EXPENSE", "debit")))),
      labourDueEffect: sum("LABOUR_PAYABLE", "credit"),
      labourAdvanceEffect: sum("LABOUR_ADVANCE", "debit"),
      expenseEffect: sum("LABOUR_EXPENSE", "debit"),
      partnerEffect: sum("PARTNER_PAYABLE", "credit"),
      cashControlEffect: sum("CASH_CONTROL", "credit"),
      canonical: !Boolean(due?.legacy || voucher?.legacy),
    };
  }).sort((left, right) => right.postedAt.localeCompare(left.postedAt) || right.id.localeCompare(left.id));

  const aggregateParentVouchers = vouchers.filter((voucher) => voucher.nature === "ADVANCE_APPLICATION" && voucher.linkedDueId);
  const advanceApplicationParents: AdvanceApplicationParent[] = logs
    .filter((row) => row.action === "labour_due_settled" && row.entityType === "labour_due" && row.entityId && dueById.has(row.entityId))
    .map((row) => {
      const details = asSnapshot(row.details);
      const advancePool = asSnapshot(details.advancePool);
      const requestedAmount = amount(advancePool.requestedAmount);
      if (requestedAmount <= 0.005) return null;
      const due = row.entityId ? dueById.get(row.entityId) ?? null : null;
      if (!due) return null;
      const dueSnapshot = asSnapshot(due.recipientSnapshot);
      const applicationSpecs = Array.isArray(details.advanceApplications) ? details.advanceApplications : [];
      const childApplicationKeys = applicationSpecs
        .map((value) => (value && typeof value === "object" && typeof (value as Record<string, unknown>).idempotencyKey === "string" ? (value as Record<string, unknown>).idempotencyKey as string : null))
        .filter((value): value is string => Boolean(value));
      const childApplications = scopedApplications.filter((application) => application.dueId === due.id && childApplicationKeys.includes(application.idempotencyKey));
      const activeChildren = childApplications.filter((application) => application.status === "ACTIVE");
      const activeAmount = amount(activeChildren.reduce((sum, application) => sum + amount(application.amount), 0));
      const matchingParentVoucher = aggregateParentVouchers.find((voucher) => voucher.linkedDueId === due.id && voucher.sourceId === firstText(advancePool.idempotencyKey));
      const createdBy = row.actorUserId ? userById.get(row.actorUserId) : row.userId ? userById.get(row.userId) : null;
      const status: AdvanceApplicationParent["status"] = activeAmount <= 0.005
        ? "REVERSED"
        : activeChildren.length === childApplications.length
          ? "POSTED"
          : "PARTIALLY_REVERSED";
      const displayNumber = matchingParentVoucher?.voucherNumber ?? aggregateApplicationVoucherNumber(row.id);
      const settlementSummary = asSnapshot(details.settlementSummary);
      return {
        id: row.id,
        parentVoucherId: matchingParentVoucher?.id ?? null,
        voucherNumber: displayNumber,
        displayVoucherNumber: displayNumber,
        date: matchingParentVoucher?.voucherDate ?? row.createdAt.toISOString().slice(0, 10),
        postedAt: matchingParentVoucher?.postedAt?.toISOString() ?? row.createdAt.toISOString(),
        dueId: due.id,
        dueNumber: due.dueNumber,
        workFromDate: due.workFromDate,
        workToDate: due.workToDate,
        recipientScope: due.recipientScope,
        labourerId: due.labourerId,
        labourGroupId: due.labourGroupId,
        recipientName: resolveRecipientDisplayName({
          snapshot: dueSnapshot,
          recipientScope: due.recipientScope,
          labourerName: due.labourerId ? labourerById.get(due.labourerId)?.name ?? null : null,
          labourGroupName: due.labourGroupId ? groupById.get(due.labourGroupId)?.name ?? null : null,
        }),
        description: matchingParentVoucher?.description ?? `Applied advances to ${due.dueNumber}`,
        paymentMethod: "Applied advances",
        originalAmount: requestedAmount,
        activeAmount,
        recoveredAmount: amount(Math.max(requestedAmount - activeAmount, 0)),
        status,
        createdAt: row.createdAt.toISOString(),
        createdByName: createdBy?.displayName ?? createdBy?.email ?? null,
        childApplicationIds: childApplications.map((application) => application.id),
        activeChildApplicationIds: activeChildren.map((application) => application.id),
        childAllocationTotal: amount(childApplications.reduce((sum, application) => sum + amount(application.amount), 0)),
        activeChildAllocationTotal: activeAmount,
        dueOutstandingAfterPosting: typeof settlementSummary.remainingDue === "number" ? amount(settlementSummary.remainingDue) : null,
        sourceType: matchingParentVoucher ? "PARENT_VOUCHER" : "AUDIT_EVENT",
      } satisfies AdvanceApplicationParent;
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((left, right) => right.postedAt.localeCompare(left.postedAt) || right.id.localeCompare(left.id));

  const legacyPartnerAdvanceEntries = advancePositions
    .filter((row) => !row.canonical && row.partnerId && row.status !== "VOIDED")
    .map((row) => ({
      id: `legacy-advance:${row.advancePositionId}`,
      voucherId: row.voucherId,
      voucherNumber: row.voucherNumber,
      sourceId: row.sourceId,
      legacySourceRecordId: row.legacySourceRecordId,
      accountId: row.partnerId!,
      accountName: row.partnerName ?? row.fundingAccountName ?? "Partner account",
      accountType: "partner",
      transactionType: "credit" as const,
      amount: row.originalAmount,
      balanceEffect: row.originalAmount,
      date: row.advanceDate,
      nature: "ADVANCE" as const,
      economicNature: "ADVANCE" as const,
      status: row.status,
      description: row.description,
      reversalReference: null,
      recipientScope: row.recipientScope,
      labourerId: row.labourerId,
      labourGroupId: row.labourGroupId,
      recipientName: row.recipientName,
      canonical: false,
      legacy: true,
    }));
  const partnerLedger = [...accountEntries.filter((entry) => entry.accountType === "partner"), ...legacyPartnerAdvanceEntries]
    .sort((left, right) => right.date.localeCompare(left.date) || right.id.localeCompare(left.id));
  const partnerPositions = scopeAccounts.filter((account) => account.accountType === "partner").map((account) => {
    const ledger = partnerLedger.filter((entry) => entry.accountId === account.id);
    const labourAdvancesPaid = amount(ledger.filter((entry) => entry.economicNature === "ADVANCE").reduce((sum, entry) => sum + entry.balanceEffect, 0));
    const directLabourPayments = amount(ledger.filter((entry) => entry.economicNature !== "ADVANCE" && entry.economicNature !== "REFUND_RECOVERY").reduce((sum, entry) => sum + entry.balanceEffect, 0));
    const recoveries = amount(ledger.filter((entry) => entry.economicNature === "REFUND_RECOVERY").reduce((sum, entry) => sum - entry.balanceEffect, 0));
    const outstandingLabourAdvances = amount(advancePositions.filter((advance) => advance.partnerId === account.id).reduce((sum, advance) => sum + advance.outstandingAmount, 0));
    const appliedLabourAdvances = amount(advancePositions.filter((advance) => advance.partnerId === account.id).reduce((sum, advance) => sum + advance.appliedAmount, 0));
    const farmOwesPartner = amount(ledger.reduce((sum, entry) => sum + entry.balanceEffect, 0));
    return {
      accountId: account.id,
      accountName: account.name,
      farmOwesPartner,
      ledgerBalance: farmOwesPartner,
      labourAdvancesPaid,
      directLabourPayments,
      recoveries,
      outstandingLabourAdvances,
      appliedLabourAdvances,
      entryCount: ledger.length,
    };
  });
  const expenses = dues
    .filter((due) => !due.legacy)
    .map((due) => {
      const activePaidAmount = scopedAllocations
        .filter((row) => row.dueId === due.id && row.status === "ACTIVE")
        .reduce((sum, row) => sum + amount(row.amount), 0);
      const activeAppliedAmount = scopedApplications
        .filter((row) => row.dueId === due.id && row.status === "ACTIVE")
        .reduce((sum, row) => sum + amount(row.amount), 0);
      const activeAmount = due.paymentStatus === "VOIDED"
        ? 0
        : amount(Number(due.grossAmount) + Number(due.adjustmentAmount) - Number(due.authorizedDeductions));
      return {
        id: due.id,
        dueId: due.id,
        dueNumber: due.dueNumber,
        date: due.workToDate,
        recipientScope: due.recipientScope,
        labourerId: due.labourerId,
        labourGroupId: due.labourGroupId,
        recipientName: resolveRecipientDisplayName({
          snapshot: asSnapshot(due.recipientSnapshot),
          recipientScope: due.recipientScope,
          labourerName: due.labourerId ? labourerById.get(due.labourerId)?.name ?? null : null,
          labourGroupName: due.labourGroupId ? groupById.get(due.labourGroupId)?.name ?? null : null,
        }),
        description: due.description,
        status: due.paymentStatus,
        amount: activeAmount,
        paidAmount: activePaidAmount,
        appliedAdvanceAmount: activeAppliedAmount,
        outstandingAmount: amount(Math.max(activeAmount - activePaidAmount - activeAppliedAmount, 0)),
        active: due.paymentStatus !== "VOIDED",
        canonical: true as const,
      };
    })
    .filter((row) => row.amount !== 0 || !row.active);
  const labourLedger = journalEvents.filter((event) => !event.legacy && (event.labourDueEffect !== 0 || event.labourAdvanceEffect !== 0 || event.expenseEffect !== 0));
  const activity = journalEvents.filter((event) => !event.legacy).map((event) => ({
    id: `labour:${event.id}`, date: event.postedAt, module: "labour" as const,
    title: event.eventType === "REVERSAL" ? `Reversed ${event.originalEventType?.toLowerCase().replaceAll("_", " ") ?? "labour event"}` : event.eventType.toLowerCase().replaceAll("_", " "),
    detail: `${event.dueNumber ?? event.voucherNumber ?? event.recipientName} · ${event.description}`,
    status: event.status, sourceId: event.voucherId ?? event.dueId ?? event.advanceApplicationId,
    canonical: true as const,
  }));
  const canonicalJournalEvents = journalEvents.filter((event) => !event.legacy);
  const currentLedger = {
    LABOUR_EXPENSE: amount(canonicalJournalEvents.reduce((sum, event) => sum + event.expenseEffect, 0)),
    LABOUR_PAYABLE: amount(canonicalJournalEvents.reduce((sum, event) => sum - event.labourDueEffect, 0)),
    LABOUR_ADVANCE: amount(canonicalJournalEvents.reduce((sum, event) => sum + event.labourAdvanceEffect, 0)),
    CASH_CONTROL: amount(canonicalJournalEvents.reduce((sum, event) => sum - event.cashControlEffect, 0)),
    PARTNER_PAYABLE: amount(canonicalJournalEvents.reduce((sum, event) => sum - event.partnerEffect, 0)),
  };
  return {
    scope: input,
    accountEntries,
    partnerPositions,
    partnerLedger,
    labourLedger,
    advanceApplicationParents,
    expenses,
    activity,
    currentLedger,
    advancePositions,
    replacedLegacySourceIds: [...new Set([
      ...vouchers.flatMap((voucher) => [voucher.sourceId, voucher.legacySourceRecordId]),
      ...dues.flatMap((due) => [due.sourceClientRecordId, due.sourceRecordId]),
    ].filter((id): id is string => Boolean(id)))],
    summary: {
      labourDue: amount(canonicalJournalEvents.reduce((sum, event) => sum + event.labourDueEffect, 0)),
      outstandingAdvance: amount(advancePositions.filter((position) => position.status !== "VOIDED").reduce((sum, position) => sum + position.outstandingAmount, 0)),
      totalAdvance: amount(advancePositions.filter((position) => position.status !== "VOIDED").reduce((sum, position) => sum + position.originalAmount, 0)),
      recoveredAdvance: amount(advancePositions.filter((position) => position.status !== "VOIDED").reduce((sum, position) => sum + position.recoveredAmount, 0)),
      wageExpense: amount(canonicalJournalEvents.reduce((sum, event) => sum + event.expenseEffect, 0)),
      farmOwesPartner: amount(partnerPositions.reduce((sum, position) => sum + position.farmOwesPartner, 0)),
      accountMovement: amount(accountEntries.reduce((sum, entry) => sum + entry.balanceEffect, 0)),
      activePaymentAmount: amount(scopedAllocations.filter((row) => row.status === "ACTIVE").reduce((sum, row) => sum + amount(row.amount), 0)),
      activeAdvanceApplied: amount(advancePositions.filter((position) => position.status !== "VOIDED").reduce((sum, position) => sum + position.appliedAmount, 0)),
    },
  };
}
