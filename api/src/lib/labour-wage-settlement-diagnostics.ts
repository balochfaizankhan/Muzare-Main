import { buildAccountIdentityLookup, resolveCanonicalAccountId, type AccountIdentityLike, type AccountIdentityLookup } from "./account-identity.js";
import { normalizeLabourEarningPayload } from "./labour-earnings.js";
import { normalizeSettlementPayload, type LabourWageSettlementPayload } from "./labour-wage-settlements.js";

export type LabourWageSettlementDiagnosticsLookup = {
  workspaceId: string;
  settlementNumber?: string;
  settlementId?: string;
  clientRequestId?: string;
  farmId?: string | null;
};

export type LabourWageSettlementDiagnosticsSettlement = {
  exists: boolean;
  operationalRecordId: string | null;
  clientRecordId: string | null;
  settlementNumber: string | null;
  status: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  fromDate: string | null;
  toDate: string | null;
  settlementDate: string | null;
  groupId: string | null;
  foremanId: string | null;
  paidAmount: number | null;
  advanceAdjustedNow: number | null;
  grossWages: number | null;
};

export type LabourWageSettlementDiagnosticsLifecycle = {
  exists: boolean;
  state: string | null;
  stage: string | null;
  errorCode: string | null;
  safeMessage: string | null;
  safeToRetry: boolean | null;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
};

export type LabourWageSettlementDiagnosticsPaymentAccountSnapshot = {
  paymentAccountId: string | null;
  paymentAccountCanonicalId: string | null;
  paymentAccountLegacyId: string | null;
  linkedAccountId: string | null;
  paymentAccountName: string | null;
  paymentAccountType: string | null;
};

export type LabourWageSettlementDiagnosticsPaymentAccountResolution = {
  canonicalAccountFound: boolean;
  legacyAccountFound: boolean;
  partnerAccountFound: boolean;
  operationalAccountFound: boolean;
  resolvedCanonicalId: string | null;
  resolvedLegacyId: string | null;
  resolvedName: string | null;
  resolvedType: string | null;
  active: boolean | null;
  archived: boolean | null;
  workspaceMatches: boolean;
  resolutionFailureReason: string | null;
  nameOnlyCandidates: Array<{ id: string; name: string; accountType: string | null; active: boolean | null; source: "canonical" | "operational" }>;
};

export type LabourWageSettlementDiagnosticsAccounting = {
  status: "COMPLETE" | "MISSING" | "REPAIR_REQUIRED" | "FAILED";
  transactionCount: number;
  activeTransactionCount: number;
  reversalCount: number;
  matchingReferenceIds: string[];
  expectedPaymentAccountId: string | null;
  storedPaymentAccountId: string | null;
  identifierMismatch: boolean;
  mismatchDescription: string | null;
};

export type LabourWageSettlementDiagnosticsCollections = {
  count: number;
  absorbedTotal: number;
  missingAdvanceReferences: number;
};

export type LabourWageSettlementDiagnosticsLinks = {
  linkedCount: number;
};

export type LabourWageSettlementDiagnosticsLabourEarnings = {
  linkedCount: number;
  settledCount: number;
};

export type LabourWageSettlementDiagnosticsClassification = {
  settlementState: "FULLY_COMMITTED" | "COMMITTED_ACCOUNTING_MISSING" | "ROLLED_BACK" | "PARTIAL_OR_INCONSISTENT" | "NOT_FOUND";
  recommendedAction: string;
  safeToRetryCreate: boolean;
};

export type LabourWageSettlementDiagnosticsResponse = {
  lookup: LabourWageSettlementDiagnosticsLookup;
  settlement: LabourWageSettlementDiagnosticsSettlement;
  lifecycle: LabourWageSettlementDiagnosticsLifecycle;
  paymentAccountSnapshot: LabourWageSettlementDiagnosticsPaymentAccountSnapshot;
  paymentAccountResolution: LabourWageSettlementDiagnosticsPaymentAccountResolution;
  accounting: LabourWageSettlementDiagnosticsAccounting;
  allocations: LabourWageSettlementDiagnosticsCollections;
  attendance: LabourWageSettlementDiagnosticsLinks;
  labourEarnings: LabourWageSettlementDiagnosticsLabourEarnings;
  classification: LabourWageSettlementDiagnosticsClassification;
};

export type LabourWageSettlementDiagnosticsInput = {
  lookup: LabourWageSettlementDiagnosticsLookup;
  settlementRecord: {
    id: string;
    clientRecordId: string;
    farmId: string | null;
    seasonId: string | null;
    createdAt: Date;
    updatedAt: Date;
    clientUpdatedAt: Date;
    payload: Record<string, unknown>;
  } | null;
  lifecycleRecord: {
    clientRequestId: string;
    state: string;
    stage: string | null;
    errorCode: string | null;
    message: string | null;
    safeToRetry: boolean;
    createdAt: Date;
    updatedAt: Date;
    completedAt: Date | null;
  } | null;
  paymentAccounts: AccountIdentityLike[];
  operationalAccountRecords: Array<{
    id: string;
    clientRecordId: string;
    farmId: string | null;
    payload: Record<string, unknown>;
    createdAt: Date;
    updatedAt: Date;
  }>;
  accountTransactions: Array<{
    referenceId: string | null;
    accountId: string;
    source?: string | null;
    sourceType?: string | null;
    type: "credit" | "debit" | string;
  }>;
  allocations: Array<{
    advanceRecordId: string;
    absorbedAmount: string | number;
  }>;
  attendanceLinks: Array<{ id: string }>;
  labourEarnings: Array<{
    id: string;
    payload: Record<string, unknown>;
  }>;
};

export type LabourWageSettlementDiagnosticsFarmScope = {
  settlementFarmId: string | null;
  lifecycleFarmId: string | null;
  requestFarmId: string | null;
  legacyPayloadFarmId: string | null;
};

function trim(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeDiagnosticsScopeId(value: string | null | undefined) {
  const trimmed = trim(value);
  return trimmed ? trimmed : null;
}

export function resolveLabourWageSettlementDiagnosticsFarmId(scope: LabourWageSettlementDiagnosticsFarmScope) {
  const candidates = [
    normalizeDiagnosticsScopeId(scope.settlementFarmId),
    normalizeDiagnosticsScopeId(scope.lifecycleFarmId),
    normalizeDiagnosticsScopeId(scope.requestFarmId),
    normalizeDiagnosticsScopeId(scope.legacyPayloadFarmId),
  ];
  for (const candidate of candidates) {
    if (candidate) return candidate;
  }
  return null;
}

function toNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toIso(value: Date | string | null | undefined) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function detectNameOnlyCandidates(accounts: Array<AccountIdentityLike & { source: "canonical" | "operational" }>) {
  return accounts
    .filter((account) => trim(account.name))
    .map((account) => ({
      id: account.id,
      name: account.name,
      accountType: account.accountType ?? null,
      active: account.active ?? null,
      source: account.source,
    }));
}

function buildPaymentAccountResolution(
  paymentAccountSnapshot: LabourWageSettlementDiagnosticsPaymentAccountSnapshot,
  accountLookup: AccountIdentityLookup,
  canonicalAccounts: AccountIdentityLike[],
  operationalAccounts: AccountIdentityLike[],
  workspaceId: string,
) : LabourWageSettlementDiagnosticsPaymentAccountResolution {
  const canonicalCandidates = canonicalAccounts;
  const operationalCandidates = operationalAccounts;
  const canonicalId = paymentAccountSnapshot.paymentAccountCanonicalId
    ?? paymentAccountSnapshot.paymentAccountId
    ?? paymentAccountSnapshot.linkedAccountId;
  const legacyId = paymentAccountSnapshot.paymentAccountLegacyId ?? null;
  const resolvedCanonicalId = canonicalId ? resolveCanonicalAccountId(canonicalId, accountLookup) : null;
  const resolvedLegacyId = legacyId ? resolveCanonicalAccountId(legacyId, accountLookup) : null;
  const matchedCanonical = canonicalId ? canonicalCandidates.some((account) => account.id === canonicalId) : false;
  const matchedOperational = canonicalId ? operationalCandidates.some((account) => account.id === canonicalId || account.oldAndroidId === canonicalId) : false;
  const matchedLegacy = legacyId ? canonicalCandidates.some((account) => account.oldAndroidId === legacyId || account.id === legacyId) || operationalCandidates.some((account) => account.oldAndroidId === legacyId || account.id === legacyId) : false;
  const matchedAccount = resolvedCanonicalId
    ? canonicalCandidates.find((account) => account.id === resolvedCanonicalId) ?? operationalCandidates.find((account) => account.id === resolvedCanonicalId) ?? null
    : resolvedLegacyId
      ? canonicalCandidates.find((account) => account.id === resolvedLegacyId) ?? operationalCandidates.find((account) => account.id === resolvedLegacyId) ?? null
      : null;
  const partnerAccountFound = canonicalCandidates.some((account) => account.accountType === "partner" && (account.id === canonicalId || account.oldAndroidId === canonicalId || account.oldAndroidId === legacyId || account.id === legacyId));
  const archived = matchedAccount ? matchedAccount.active === false : null;
  const active = matchedAccount ? matchedAccount.active ?? null : null;
  const resolutionFailureReason = matchedAccount
    ? (matchedAccount.active === false ? "Resolved account is archived/inactive." : null)
    : (canonicalId || legacyId ? "No canonical, legacy, or operational account matched the stored payment-account identifiers." : "Settlement does not store a payment account identifier.");
  return {
    canonicalAccountFound: matchedCanonical,
    legacyAccountFound: matchedLegacy,
    partnerAccountFound,
    operationalAccountFound: matchedOperational,
    resolvedCanonicalId: resolvedCanonicalId ?? resolvedLegacyId,
    resolvedLegacyId,
    resolvedName: matchedAccount?.name ?? paymentAccountSnapshot.paymentAccountName ?? null,
    resolvedType: matchedAccount?.accountType ?? paymentAccountSnapshot.paymentAccountType ?? null,
    active,
    archived,
    workspaceMatches: Boolean(matchedAccount),
    resolutionFailureReason,
    nameOnlyCandidates: [
      ...detectNameOnlyCandidates(canonicalCandidates.map((account) => ({ ...account, source: "canonical" as const }))),
      ...detectNameOnlyCandidates(operationalCandidates.map((account) => ({ ...account, source: "operational" as const }))),
    ],
  };
}

export function buildLabourWageSettlementDiagnostics(input: LabourWageSettlementDiagnosticsInput): LabourWageSettlementDiagnosticsResponse {
  const settlementPayload = input.settlementRecord ? normalizeSettlementPayload(input.settlementRecord.payload) : null;
  const lifecycleState = input.lifecycleRecord?.state ?? null;
  const paymentAccountSnapshot: LabourWageSettlementDiagnosticsPaymentAccountSnapshot = settlementPayload ? {
    paymentAccountId: settlementPayload.paymentAccountId ?? settlementPayload.linkedAccountId ?? null,
    paymentAccountCanonicalId: settlementPayload.paymentAccountCanonicalId ?? settlementPayload.paymentAccountId ?? settlementPayload.linkedAccountId ?? null,
    paymentAccountLegacyId: settlementPayload.paymentAccountLegacyId ?? null,
    linkedAccountId: settlementPayload.linkedAccountId ?? null,
    paymentAccountName: settlementPayload.paymentAccountName ?? settlementPayload.linkedAccountName ?? null,
    paymentAccountType: settlementPayload.paymentAccountType ?? null,
  } : {
    paymentAccountId: null,
    paymentAccountCanonicalId: null,
    paymentAccountLegacyId: null,
    linkedAccountId: null,
    paymentAccountName: null,
    paymentAccountType: null,
  };

  const accountLookup = buildAccountIdentityLookup(input.paymentAccounts);
  const paymentAccountResolution = buildPaymentAccountResolution(
    paymentAccountSnapshot,
    accountLookup,
    input.paymentAccounts.filter((account) => account.sourceType !== "operational_account_repair"),
    input.operationalAccountRecords.map((record) => ({
      id: record.clientRecordId,
      name: trim(record.payload.name) || trim(record.payload.partnerName) || trim(record.payload.accountName),
      oldAndroidId: trim(record.payload.oldAndroidId) || trim(record.payload.old_android_id) || null,
      sourceType: trim(record.payload.sourceType) || trim(record.payload.type) || null,
      accountType: trim(record.payload.type) || trim(record.payload.accountType) || null,
      active: typeof record.payload.active === "boolean" ? record.payload.active : null,
    })),
    input.lookup.workspaceId,
  );

  const settlementExists = Boolean(input.settlementRecord && settlementPayload);
  const lifecycleExists = Boolean(input.lifecycleRecord);
  const accountingTransactionCount = input.accountTransactions.length;
  const activeTransactionCount = input.accountTransactions.filter((transaction) => transaction.sourceType === "labour_wage_settlement" || transaction.source === "settlement").length;
  const reversalCount = input.accountTransactions.filter((transaction) => transaction.type === "credit").length;
  const accountMismatch = Boolean(settlementPayload && (
    (paymentAccountSnapshot.paymentAccountCanonicalId && paymentAccountResolution.resolvedCanonicalId && paymentAccountSnapshot.paymentAccountCanonicalId !== paymentAccountResolution.resolvedCanonicalId)
    || (paymentAccountSnapshot.paymentAccountId && paymentAccountResolution.resolvedCanonicalId && paymentAccountSnapshot.paymentAccountId !== paymentAccountResolution.resolvedCanonicalId)
  ));
  const settlementHasCoreLinks = Boolean(
    input.allocations.length
    || input.attendanceLinks.length
    || input.labourEarnings.some((earning) => {
      const payload = normalizeLabourEarningPayload(earning.payload);
      return trim(payload.linkedSettlementId) === input.settlementRecord?.clientRecordId;
    })
    || accountingTransactionCount > 0
  );
  const accountingStatus = (() => {
    if (!settlementPayload) return "FAILED" as const;
    if (payloadStatusIsNonActive(settlementPayload)) return "COMPLETE" as const;
    if (paymentAccountResolution.resolvedCanonicalId) {
      if (paymentAccountResolution.active === false) return "REPAIR_REQUIRED" as const;
      if (accountingTransactionCount > 0) return "COMPLETE" as const;
      return "MISSING" as const;
    }
    if (paymentAccountSnapshot.paymentAccountCanonicalId || paymentAccountSnapshot.paymentAccountId || paymentAccountSnapshot.linkedAccountId) {
      return "REPAIR_REQUIRED" as const;
    }
    return "FAILED" as const;
  })();
  const classification: LabourWageSettlementDiagnosticsClassification = (() => {
    if (!settlementExists && !lifecycleExists) {
      return {
        settlementState: "NOT_FOUND",
        recommendedAction: "No settlement or lifecycle record exists; safe create retry is likely available once the user retries from the app.",
        safeToRetryCreate: true,
      };
    }
    if (!settlementExists && lifecycleState && ["rolled_back", "failed"].includes(lifecycleState)) {
      return {
        settlementState: "ROLLED_BACK",
        recommendedAction: "Allow a safe create retry because the request rolled back without a committed settlement.",
        safeToRetryCreate: true,
      };
    }
    if (settlementExists && accountingStatus === "COMPLETE" && lifecycleState !== "rolled_back" && lifecycleState !== "failed") {
      return {
        settlementState: "FULLY_COMMITTED",
        recommendedAction: "No repair required.",
        safeToRetryCreate: false,
      };
    }
    if (settlementExists && (accountingStatus === "MISSING" || accountingStatus === "REPAIR_REQUIRED") && settlementHasCoreLinks) {
      return {
        settlementState: "COMMITTED_ACCOUNTING_MISSING",
        recommendedAction: paymentAccountResolution.resolvedCanonicalId
          ? "Create missing accounting entry using an authoritative mapping."
          : "Mark accounting REPAIR_REQUIRED and request explicit admin account selection.",
        safeToRetryCreate: false,
      };
    }
    return {
      settlementState: "PARTIAL_OR_INCONSISTENT",
      recommendedAction: "Review the partial data before retrying; do not create a second settlement until the mismatch is explained.",
      safeToRetryCreate: false,
    };
  })();

  const settlement = settlementExists && input.settlementRecord && settlementPayload ? {
    exists: true,
    operationalRecordId: input.settlementRecord.id,
    clientRecordId: input.settlementRecord.clientRecordId,
    settlementNumber: settlementPayload.settlementNumber ?? null,
    status: settlementPayload.status ?? null,
    createdAt: toIso(input.settlementRecord.createdAt),
    updatedAt: toIso(input.settlementRecord.updatedAt),
    fromDate: settlementPayload.fromDate ?? null,
    toDate: settlementPayload.toDate ?? null,
    settlementDate: settlementPayload.settlementDate ?? null,
    groupId: settlementPayload.groupId ?? null,
    foremanId: settlementPayload.foremanId ?? null,
    paidAmount: settlementPayload.paidAmount ?? null,
    advanceAdjustedNow: settlementPayload.advanceAdjustedNow ?? null,
    grossWages: settlementPayload.grossWages ?? null,
  } : {
    exists: false,
    operationalRecordId: null,
    clientRecordId: null,
    settlementNumber: null,
    status: null,
    createdAt: null,
    updatedAt: null,
    fromDate: null,
    toDate: null,
    settlementDate: null,
    groupId: null,
    foremanId: null,
    paidAmount: null,
    advanceAdjustedNow: null,
    grossWages: null,
  };

  return {
    lookup: input.lookup,
    settlement,
    lifecycle: input.lifecycleRecord ? {
      exists: true,
      state: input.lifecycleRecord.state,
      stage: input.lifecycleRecord.stage,
      errorCode: input.lifecycleRecord.errorCode,
      safeMessage: input.lifecycleRecord.message,
      safeToRetry: input.lifecycleRecord.safeToRetry,
      createdAt: toIso(input.lifecycleRecord.createdAt),
      updatedAt: toIso(input.lifecycleRecord.updatedAt),
      completedAt: toIso(input.lifecycleRecord.completedAt),
    } : {
      exists: false,
      state: null,
      stage: null,
      errorCode: null,
      safeMessage: null,
      safeToRetry: null,
      createdAt: null,
      updatedAt: null,
      completedAt: null,
    },
    paymentAccountSnapshot,
    paymentAccountResolution,
    accounting: {
      status: accountingStatus,
      transactionCount: accountingTransactionCount,
      activeTransactionCount,
      reversalCount,
      matchingReferenceIds: input.accountTransactions.filter((transaction) => transaction.referenceId === input.settlementRecord?.clientRecordId).map((transaction) => transaction.referenceId!).filter(Boolean),
      expectedPaymentAccountId: paymentAccountSnapshot.paymentAccountCanonicalId,
      storedPaymentAccountId: paymentAccountSnapshot.paymentAccountId,
      identifierMismatch: accountMismatch,
      mismatchDescription: accountMismatch
        ? `Stored payment-account id ${paymentAccountSnapshot.paymentAccountCanonicalId ?? paymentAccountSnapshot.paymentAccountId ?? "null"} does not resolve to the live account snapshot.`
        : null,
    },
    allocations: {
      count: input.allocations.length,
      absorbedTotal: input.allocations.reduce((sum, allocation) => sum + toNumber(allocation.absorbedAmount), 0),
      missingAdvanceReferences: input.allocations.filter((allocation) => !trim(allocation.advanceRecordId)).length,
    },
    attendance: {
      linkedCount: input.attendanceLinks.length,
    },
    labourEarnings: {
      linkedCount: input.labourEarnings.filter((earning) => trim(normalizeLabourEarningPayload(earning.payload).linkedSettlementId) === input.settlementRecord?.clientRecordId).length,
      settledCount: input.labourEarnings.filter((earning) => normalizeLabourEarningPayload(earning.payload).status === "settled").length,
    },
    classification,
  };
}

function payloadStatusIsNonActive(payload: LabourWageSettlementPayload) {
  return payload.status === "deleted" || payload.status === "voided";
}
