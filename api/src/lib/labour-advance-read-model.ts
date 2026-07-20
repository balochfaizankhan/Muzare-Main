import { calculateAdvancePosition } from "./labour-payments.js";

export type LegacyAdvanceReadRow = {
  id: string;
  sourceId: string;
  voucherNumber: string;
  voucherDate: string;
  recipientScope: "INDIVIDUAL" | "LABOUR_GROUP";
  financialScopeKey: string;
  labourerId: string | null;
  labourGroupId: string | null;
  recipientSnapshot: Record<string, unknown>;
  description: string;
  originalAmount: number;
  appliedAmount: number;
  refundedAmount?: number;
  reversedAmount?: number;
  paymentAccountId: string | null;
  paymentAccountName: string | null;
  status: "POSTED" | "VOIDED";
  createdAt: string;
  sourceKind: "LEGACY_OPERATIONAL" | "LEGACY_NORMALIZED";
};

export function legacyAdvancePosition(row: LegacyAdvanceReadRow) {
  const reversedAmount = row.status === "VOIDED" ? row.originalAmount : Math.max(0, row.reversedAmount ?? 0);
  const position = calculateAdvancePosition({
    originalAmount: row.originalAmount,
    appliedAmount: row.appliedAmount,
    refundedAmount: (row.refundedAmount ?? 0) + reversedAmount,
    voided: row.status === "VOIDED",
  });
  return {
    id: row.id,
    workspaceId: "",
    farmId: null,
    seasonId: null,
    voucherNumber: row.voucherNumber,
    voucherDate: row.voucherDate,
    nature: "ADVANCE",
    status: row.status,
    recipientScope: row.recipientScope,
    financialScopeKey: row.financialScopeKey,
    labourerId: row.labourerId,
    labourGroupId: row.labourGroupId,
    recipientSnapshot: row.recipientSnapshot,
    description: row.description,
    paymentAmount: String(row.originalAmount),
    paymentAccountId: row.paymentAccountId,
    paymentMethod: null,
    transactionReference: row.sourceId,
    sourceType: row.sourceKind,
    sourceId: row.sourceId,
    linkedDueId: null,
    legacySourceRecordId: row.sourceKind === "LEGACY_OPERATIONAL" ? row.sourceId : null,
    accountTransactionId: null,
    idempotencyKey: row.id,
    createdBy: "",
    postedBy: null,
    postedAt: row.createdAt,
    voidReason: null,
    voidedBy: null,
    voidedAt: row.status === "VOIDED" ? row.createdAt : null,
    reversalReference: null,
    relatedAdvanceVoucherId: null,
    legacy: true,
    reconciliationStatus: "LEGACY_READ_MODEL",
    createdAt: row.createdAt,
    updatedAt: row.createdAt,
    paymentAccountName: row.paymentAccountName,
    reversedAmount,
    readOnlyLegacy: true,
    ...position,
  };
}

type MergeableAdvance = { sourceId?: string | null; legacySourceRecordId?: string | null; voucherDate: string; createdAt: string | Date; status: string; outstandingAmount: number };

export function mergeAdvancePositions<C extends MergeableAdvance, L extends MergeableAdvance>(canonical: C[], legacy: L[]): Array<C | L> {
  const covered = new Set(canonical.flatMap((row) => [row.sourceId, row.legacySourceRecordId]).filter((value): value is string => Boolean(value)));
  return [...canonical, ...legacy.filter((row) => !covered.has(row.sourceId ?? "") && !covered.has(row.legacySourceRecordId ?? ""))]
    .sort((left, right) => right.voucherDate.localeCompare(left.voucherDate) || String(right.createdAt).localeCompare(String(left.createdAt)));
}
