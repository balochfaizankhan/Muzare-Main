import type { FastifyInstance } from "fastify";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { db } from "../db/client.js";
import { accountTransactions, auditLogs, labourAdvanceApplications, labourDues, labourPaymentAllocations, labourWageSettlementAdvanceAllocations, labourWageSettlementCreateRequests, operationalRecords, userSessions } from "../db/schema.js";
import { listLabourEarnings, normalizeLabourEarningPayload } from "../lib/labour-earnings.js";
import { isDeletedOperationalPayload } from "../operational-record-state.js";
import { hasFarmAccess } from "../workspace-access.js";
import { hasModulePermission } from "../permissions.js";
import { validateTenantReferences } from "../tenant-ownership.js";
import { ATTENDANCE_DUES_RETIRED_MESSAGE, ensureSettlementLabourDue, reverseLabourJournal } from "../lib/labour-payments.js";
import {
  allocateSettlementNumber,
  calculateLabourWageSettlementTotals,
  inspectSettlementAccountingIntegrity,
  listCanonicalPaymentAccounts,
  listLabourWageSettlements,
  normalizeSettlementPayload,
  previewLabourWageSettlement,
  repairPostedSettlementAccounting,
  resolveCanonicalPaymentAccountId,
  validateLabourSettlementPaymentAccount,
  settlementAccountingStatus,
  settlementAccountingTransactionCounts,
  settlementRangesOverlap,
} from "../lib/labour-wage-settlements.js";

const paramsSchema = z.object({ workspaceId: z.string().uuid() });
const baseSchema = z.object({
  farmId: z.string().uuid(),
  seasonId: z.string().uuid(),
  fromDate: z.string().date(),
  toDate: z.string().date(),
  settlementDate: z.string().date(),
});
const settlementSelectionSchema = z.object({
  settlementMode: z.enum(["individual", "group"]).optional(),
  labourerId: z.string().uuid().optional().nullable(),
  foremanId: z.unknown().optional().nullable(),
  groupId: z.string().uuid().optional().nullable(),
  labourIds: z.array(z.string().uuid()).optional(),
});
const previewSchema = baseSchema.extend(settlementSelectionSchema.shape).extend({
  paymentAccountId: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
  paidAmount: z.coerce.number().nonnegative().optional(),
  manualAdjustment: z.coerce.number().optional(),
});

function validationIssuePaths(error: z.ZodError) {
  return [...new Set(error.issues.flatMap((issue) => {
    const path = issue.path.join(".");
    return path ? [path] : [];
  }))];
}
const createSchema = baseSchema.extend({
  ...settlementSelectionSchema.shape,
  clientRequestId: z.string().uuid().optional(),
  paymentAccountId: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
  paidAmount: z.coerce.number().nonnegative().default(0),
  manualAdjustment: z.coerce.number().default(0),
  manualAdjustmentNote: z.string().trim().max(500).optional().nullable(),
  notes: z.string().trim().max(500).optional(),
});
const settlementParamsSchema = z.object({
  workspaceId: z.string().uuid(),
  settlementId: z.string().uuid(),
});
const settlementStatusQuerySchema = z.object({
  farmId: z.string().uuid(),
  seasonId: z.string().uuid(),
  clientRequestId: z.string().uuid(),
});
const updateSchema = z.object({
  fromDate: z.string().date().optional(),
  toDate: z.string().date().optional(),
  settlementDate: z.string().date().optional(),
  accountId: z.string().min(1).optional(),
  paymentAccountId: z.string().min(1).optional(),
  notes: z.string().trim().max(500).optional().nullable(),
  voidReason: z.string().trim().max(500).optional().nullable(),
});

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type SettlementSelectionScope = {
  settlementMode: "individual" | "group";
  labourerId?: string | null;
  foremanId?: string | null;
  groupId?: string | null;
  labourIds?: string[];
};

type SettlementCreateRequestInternalState =
  | "request_received"
  | "validation_complete"
  | "selection_resolved"
  | "preview_recalculated"
  | "transaction_started"
  | "settlement_inserted"
  | "allocations_inserted"
  | "earnings_linked"
  | "linking_attendance"
  | "attendance_linked"
  | "posting_accounting"
  | "accounting_posted"
  | "committed"
  | "rolled_back"
  | "already_created";

type SettlementCreatePublicState = "SUCCESS" | "FAILED" | "ALREADY_CREATED" | "IN_PROGRESS";

type SettlementCreateRequestRow = {
  id: string;
  workspaceId: string;
  farmId: string;
  seasonId: string;
  clientRequestId: string;
  operationType: string;
  state: string;
  stage: string | null;
  settlementOperationalRecordId: string | null;
  settlementClientRecordId: string | null;
  settlementNumber: string | null;
  errorCode: string | null;
  safeToRetry: boolean;
  message: string | null;
  correlationId: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type SettlementCreateStatusResponse = {
  clientRequestId: string;
  state: SettlementCreatePublicState;
  safeToRetry: boolean;
  settlementId: string | null;
  settlementNumber: string | null;
  accountingStatus: "COMPLETE" | "MISSING" | "REPAIR_REQUIRED" | "FAILED" | null;
  accountingMessage: string | null;
  errorCode: string | null;
  message: string | null;
  lifecycleErrorCode: string | null;
  lifecycleMessage: string | null;
  stage: string | null;
  updatedAt: string;
  settlement: ReturnType<typeof settlementResponseFromRow>["settlement"] | null;
};

const settlementCreateOperationType = "labour_wage_settlement_create";

function settlementPublicState(state: string | null | undefined): SettlementCreatePublicState {
  if (state === "committed") return "SUCCESS";
  if (state === "already_created") return "ALREADY_CREATED";
  if (state === "rolled_back") return "FAILED";
  return "IN_PROGRESS";
}

function settlementCreateStageMessage(stage: string | null | undefined) {
  switch (stage) {
    case "request_received":
      return "Creating settlement...";
    case "validation_complete":
    case "selection_resolved":
    case "preview_recalculated":
      return "Validating settlement...";
    case "transaction_started":
      return "Starting settlement transaction...";
    case "settlement_inserted":
      return "Saving settlement...";
    case "allocations_inserted":
      return "Linking advances...";
    case "earnings_linked":
      return "Linking labour earnings...";
    case "linking_attendance":
      return "Linking attendance...";
    case "attendance_linked":
      return "Attendance linked. Posting accounting...";
    case "posting_accounting":
      return "Posting accounting...";
    case "accounting_posted":
      return "Accounting posted. Finalizing settlement...";
    case "committed":
      return "Settlement created successfully.";
    case "already_created":
      return "This settlement was already created.";
    case "rolled_back":
      return "Settlement could not be created. No changes were saved.";
    default:
      return "Settlement creation is still processing. Do not submit it again.";
  }
}

const failedSettlementCreateMessage = "Settlement could not be created. No changes were saved.";

function settlementCreateLifecycleMessage(row: SettlementCreateRequestRow, state: SettlementCreatePublicState) {
  if (state === "FAILED") return failedSettlementCreateMessage;
  return row.message ?? settlementCreateStageMessage(row.stage ?? row.state);
}

async function validateContext(sessionId: string | undefined, workspaceId: string, farmId: string, seasonId: string) {
  const [session] = await db.select({
    activeFarmId: userSessions.activeFarmId,
    activeSeasonId: userSessions.activeSeasonId,
  }).from(userSessions).where(and(eq(userSessions.id, sessionId ?? ""), eq(userSessions.workspaceId, workspaceId))).limit(1);
  return session?.activeFarmId === farmId && session.activeSeasonId === seasonId;
}

async function loadSettlementRow(tx: DbTransaction, workspaceId: string, settlementId: string) {
  const settlements = await tx.select({
    id: operationalRecords.id,
    clientRecordId: operationalRecords.clientRecordId,
    workspaceId: operationalRecords.workspaceId,
    farmId: operationalRecords.farmId,
    seasonId: operationalRecords.seasonId,
    clientUpdatedAt: operationalRecords.clientUpdatedAt,
    payload: operationalRecords.payload,
  }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, workspaceId),
    eq(operationalRecords.entityType, "labourWageSettlement"),
    eq(operationalRecords.clientRecordId, settlementId),
  )).limit(1);
  return settlements[0] ?? null;
}

async function findSettlementByClientRequestId(
  tx: DbTransaction,
  workspaceId: string,
  farmId: string,
  seasonId: string,
  clientRequestId: string,
) {
  const settlements = await tx.select({
    id: operationalRecords.id,
    clientRecordId: operationalRecords.clientRecordId,
    workspaceId: operationalRecords.workspaceId,
    farmId: operationalRecords.farmId,
    seasonId: operationalRecords.seasonId,
    clientUpdatedAt: operationalRecords.clientUpdatedAt,
    payload: operationalRecords.payload,
  }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, workspaceId),
    eq(operationalRecords.farmId, farmId),
    eq(operationalRecords.seasonId, seasonId),
    eq(operationalRecords.entityType, "labourWageSettlement"),
    sql`${operationalRecords.payload}->>'clientRequestId' = ${clientRequestId}`,
  )).limit(1);
  return settlements[0] ?? null;
}

async function loadSettlementCreateRequest(
  tx: DbTransaction | typeof db,
  workspaceId: string,
  clientRequestId: string,
) {
  const rows = await tx.select({
    id: labourWageSettlementCreateRequests.id,
    workspaceId: labourWageSettlementCreateRequests.workspaceId,
    farmId: labourWageSettlementCreateRequests.farmId,
    seasonId: labourWageSettlementCreateRequests.seasonId,
    clientRequestId: labourWageSettlementCreateRequests.clientRequestId,
    operationType: labourWageSettlementCreateRequests.operationType,
    state: labourWageSettlementCreateRequests.state,
    stage: labourWageSettlementCreateRequests.stage,
    settlementOperationalRecordId: labourWageSettlementCreateRequests.settlementOperationalRecordId,
    settlementClientRecordId: labourWageSettlementCreateRequests.settlementClientRecordId,
    settlementNumber: labourWageSettlementCreateRequests.settlementNumber,
    errorCode: labourWageSettlementCreateRequests.errorCode,
    safeToRetry: labourWageSettlementCreateRequests.safeToRetry,
    message: labourWageSettlementCreateRequests.message,
    correlationId: labourWageSettlementCreateRequests.correlationId,
    completedAt: labourWageSettlementCreateRequests.completedAt,
    createdAt: labourWageSettlementCreateRequests.createdAt,
    updatedAt: labourWageSettlementCreateRequests.updatedAt,
  }).from(labourWageSettlementCreateRequests).where(and(
    eq(labourWageSettlementCreateRequests.workspaceId, workspaceId),
    eq(labourWageSettlementCreateRequests.clientRequestId, clientRequestId),
    eq(labourWageSettlementCreateRequests.operationType, settlementCreateOperationType),
  )).limit(1);
  return (rows[0] ?? null) as SettlementCreateRequestRow | null;
}

async function upsertSettlementCreateRequestState(args: {
  workspaceId: string;
  farmId: string;
  seasonId: string;
  clientRequestId: string;
  state: SettlementCreateRequestInternalState;
  stage?: string | null;
  settlementOperationalRecordId?: string | null;
  settlementClientRecordId?: string | null;
  settlementNumber?: string | null;
  errorCode?: string | null;
  safeToRetry?: boolean;
  message?: string | null;
  correlationId?: string | null;
  completedAt?: Date | null;
}) {
  const updatedAt = new Date();
  await db.execute(sql`
    INSERT INTO labour_wage_settlement_create_requests (
      workspace_id,
      farm_id,
      season_id,
      client_request_id,
      operation_type,
      state,
      stage,
      settlement_operational_record_id,
      settlement_client_record_id,
      settlement_number,
      error_code,
      safe_to_retry,
      message,
      correlation_id,
      completed_at,
      created_at,
      updated_at
    )
    VALUES (
      ${args.workspaceId}::uuid,
      ${args.farmId}::uuid,
      ${args.seasonId}::uuid,
      ${args.clientRequestId}::uuid,
      ${settlementCreateOperationType},
      ${args.state},
      ${args.stage ?? args.state},
      ${args.settlementOperationalRecordId ?? null}::uuid,
      ${args.settlementClientRecordId ?? null},
      ${args.settlementNumber ?? null},
      ${args.errorCode ?? null},
      ${args.safeToRetry ?? false},
      ${args.message ?? settlementCreateStageMessage(args.stage ?? args.state)},
      ${args.correlationId ?? null},
      ${args.completedAt ?? null},
      ${updatedAt},
      ${updatedAt}
    )
    ON CONFLICT (workspace_id, client_request_id, operation_type)
    DO UPDATE SET
      state = EXCLUDED.state,
      stage = EXCLUDED.stage,
      settlement_operational_record_id = COALESCE(EXCLUDED.settlement_operational_record_id, labour_wage_settlement_create_requests.settlement_operational_record_id),
      settlement_client_record_id = COALESCE(EXCLUDED.settlement_client_record_id, labour_wage_settlement_create_requests.settlement_client_record_id),
      settlement_number = COALESCE(EXCLUDED.settlement_number, labour_wage_settlement_create_requests.settlement_number),
      error_code = EXCLUDED.error_code,
      safe_to_retry = EXCLUDED.safe_to_retry,
      message = EXCLUDED.message,
      correlation_id = COALESCE(EXCLUDED.correlation_id, labour_wage_settlement_create_requests.correlation_id),
      completed_at = COALESCE(EXCLUDED.completed_at, labour_wage_settlement_create_requests.completed_at),
      updated_at = EXCLUDED.updated_at
  `);
}

async function isSettlementRequestProcessing(
  tx: DbTransaction,
  workspaceId: string,
  farmId: string,
  clientRequestId: string,
) {
  const requestScopeKey = `${workspaceId}:${farmId}:labour-wage-settlement:${clientRequestId}`;
  const lockResult = await tx.execute(sql`SELECT pg_try_advisory_lock(hashtext(${requestScopeKey}), 1) AS acquired`);
  const acquired = (lockResult.rows[0] as Record<string, unknown> | undefined)?.acquired === true;
  if (acquired) {
    await tx.execute(sql`SELECT pg_advisory_unlock(hashtext(${requestScopeKey}), 1)`);
    return false;
  }
  return true;
}

async function resolveSettlementSelection(
  tx: DbTransaction,
  workspaceId: string,
  farmId: string,
  selection: {
    settlementMode?: "individual" | "group";
    labourerId?: string | null;
    foremanId?: unknown;
    groupId?: string | null;
    labourIds?: string[];
  },
) {
  if (selection.settlementMode !== "group") {
    return {
      labourerId: selection.labourerId ?? undefined,
      foremanId: typeof selection.foremanId === "string" ? selection.foremanId : undefined,
      groupId: selection.groupId ?? undefined,
      labourIds: selection.labourIds,
    };
  }
  if (!selection.groupId) {
    throw new Error("Select a labour group.");
  }

  const groupRows = await tx.select({
    clientRecordId: operationalRecords.clientRecordId,
    payload: operationalRecords.payload,
  }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, workspaceId),
    eq(operationalRecords.farmId, farmId),
    eq(operationalRecords.entityType, "labourGroup"),
    eq(operationalRecords.clientRecordId, selection.groupId),
  )).limit(1);

  const groupRow = groupRows[0];
  if (!groupRow || isDeletedOperationalPayload(groupRow.payload)) {
    throw new Error("Selected labour group was not found.");
  }
  const payload = groupRow.payload as Record<string, unknown>;
  const resolvedForemanId = typeof payload?.foremanLabourId === "string"
    ? payload.foremanLabourId
    : typeof payload?.foremanId === "string"
      ? payload.foremanId
      : "";

  if (!resolvedForemanId) {
    throw new Error("The selected labour group has no foreman assigned. Assign a foreman in Labour Groups before creating a settlement.");
  }
  const submittedForemanId = typeof selection.foremanId === "string" ? selection.foremanId.trim() : "";
  if (submittedForemanId && submittedForemanId !== resolvedForemanId) {
    throw new Error("The submitted foreman does not match the selected labour group.");
  }
  const [foreman] = await tx.select({
    clientRecordId: operationalRecords.clientRecordId,
    payload: operationalRecords.payload,
  }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, workspaceId),
    eq(operationalRecords.farmId, farmId),
    eq(operationalRecords.entityType, "labourer"),
    eq(operationalRecords.clientRecordId, resolvedForemanId),
  )).limit(1);
  if (!foreman || isDeletedOperationalPayload(foreman.payload)) {
    throw new Error("The assigned foreman record is invalid. Reassign the group foreman.");
  }

  return {
    labourerId: selection.labourerId ?? undefined,
    foremanId: resolvedForemanId,
    groupId: selection.groupId,
    labourIds: selection.labourIds,
  };
}

function settlementResponseFromRow(
  row: {
    clientRecordId: string;
    payload: Record<string, unknown>;
  },
) {
  const payload = normalizeSettlementPayload(row.payload);
  return {
    settlement: {
      ...payload,
      id: row.clientRecordId,
      accountingStatus: payload.accountingStatus ?? "posted" as const,
      accountingMessage: payload.accountingMessage ?? null,
    },
  };
}

function settlementCreateStatusFromSettlement(
  clientRequestId: string,
  row: {
    clientRecordId: string;
    payload: Record<string, unknown>;
  },
  accounting: {
    accountingStatus: "COMPLETE" | "MISSING" | "REPAIR_REQUIRED" | "FAILED";
    accountingMessage: string | null;
  },
  state: SettlementCreatePublicState = "SUCCESS",
): SettlementCreateStatusResponse {
  const settlement = settlementResponseFromRow(row).settlement;
  return {
    clientRequestId,
    state,
    safeToRetry: false,
    settlementId: settlement.id,
    settlementNumber: settlement.settlementNumber,
    accountingStatus: accounting.accountingStatus,
    accountingMessage: accounting.accountingMessage,
    errorCode: null,
    message: state === "ALREADY_CREATED"
      ? `This settlement was already created as ${settlement.settlementNumber}.`
      : `Settlement ${settlement.settlementNumber} was created successfully.`,
    lifecycleErrorCode: null,
    lifecycleMessage: state === "ALREADY_CREATED"
      ? `This settlement was already created as ${settlement.settlementNumber}.`
      : `Settlement ${settlement.settlementNumber} was created successfully.`,
    stage: state === "ALREADY_CREATED" ? "already_created" : "committed",
    updatedAt: new Date().toISOString(),
    settlement,
  };
}

function settlementCreateStatusFromRequest(
  row: SettlementCreateRequestRow,
): SettlementCreateStatusResponse {
  const state = settlementPublicState(row.state);
  const lifecycleMessage = settlementCreateLifecycleMessage(row, state);
  return {
    clientRequestId: row.clientRequestId,
    state,
    safeToRetry: row.safeToRetry,
    settlementId: row.settlementClientRecordId,
    settlementNumber: row.settlementNumber,
    accountingStatus: null,
    accountingMessage: null,
    errorCode: row.errorCode,
    message: lifecycleMessage,
    lifecycleErrorCode: row.errorCode,
    lifecycleMessage,
    stage: row.stage ?? row.state,
    updatedAt: row.updatedAt.toISOString(),
    settlement: null,
  };
}

function logSettlementAccountValidation(request: { log: { info: (...args: unknown[]) => void } }, details: Record<string, unknown>) {
  if (process.env.NODE_ENV !== "production") {
    request.log.info({ ...details, context: "labour_settlement_payment_account_validation" }, "labour settlement payment account validation");
  }
}

function sameLegacyAdvanceScope(row: { farmId: string | null; seasonId: string | null }, scope: { farmId: string; seasonId: string }) {
  return (row.farmId === scope.farmId || row.farmId === null)
    && (row.seasonId === scope.seasonId || row.seasonId === null);
}

function selectionScopeFromSettlementPayload(payload: ReturnType<typeof normalizeSettlementPayload>): SettlementSelectionScope {
  if (payload.settlementMode === "group") {
    return {
      settlementMode: "group",
      groupId: payload.groupId ?? null,
      foremanId: payload.foremanId ?? null,
      labourIds: payload.includedLabourIds?.length ? [...payload.includedLabourIds] : undefined,
    };
  }
  return {
    settlementMode: "individual",
    labourerId: payload.includedLabourIds?.[0] ?? null,
    labourIds: payload.includedLabourIds?.length ? [...payload.includedLabourIds] : undefined,
  };
}

type DatabaseErrorLike = {
  code?: unknown;
  constraint?: unknown;
  table?: unknown;
  column?: unknown;
  detail?: unknown;
  hint?: unknown;
  schema?: unknown;
  position?: unknown;
  routine?: unknown;
  message?: unknown;
  cause?: unknown;
};

function toDatabaseErrorInfo(error: unknown) {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current; depth += 1) {
    if (typeof current === "object") {
      const candidate = current as DatabaseErrorLike;
      const message = typeof candidate.message === "string" ? candidate.message : "";
      const code = typeof candidate.code === "string" ? candidate.code : null;
      const constraint = typeof candidate.constraint === "string" ? candidate.constraint : null;
      const table = typeof candidate.table === "string" ? candidate.table : null;
      const column = typeof candidate.column === "string" ? candidate.column : null;
      const detail = typeof candidate.detail === "string" ? candidate.detail : null;
      const hint = typeof candidate.hint === "string" ? candidate.hint : null;
      const schema = typeof candidate.schema === "string" ? candidate.schema : null;
      const position = typeof candidate.position === "string" ? candidate.position : null;
      const routine = typeof candidate.routine === "string" ? candidate.routine : null;
      if (code || constraint || table || column || detail || hint || schema || position || routine || message.startsWith("Failed query")) {
        return {
          code,
          constraint,
          table,
          column,
          detail,
          hint,
          schema,
          position,
          routine,
          message,
        };
      }
      current = candidate.cause;
      continue;
    }
    break;
  }
  return null;
}

function settlementPostingErrorMessage(info: ReturnType<typeof toDatabaseErrorInfo>) {
  if (!info) return "Settlement could not be created. No changes were saved.";
  if (info.code === "57014") {
    return "Settlement creation took too long and was stopped. No changes were saved.";
  }
  if (info.code === "22P02" || info.code === "23503") {
    return "Settlement could not be created because its advance records could not be linked. No changes were saved.";
  }
  if (info.code === "23505" && info.constraint?.toLowerCase().includes("labour_wage_settlement_advance_allocations")) {
    return "This settlement has already been created.";
  }
  return "Settlement could not be created. No changes were saved.";
}

function settlementPostingErrorCode(info: ReturnType<typeof toDatabaseErrorInfo>) {
  if (!info) return "SETTLEMENT_POSTING_FAILED";
  if (info.code === "57014") return "SETTLEMENT_STAGE_TIMEOUT";
  if (info.code === "22P02" || info.code === "23503") return "SETTLEMENT_ADVANCE_LINK_FAILED";
  if (info.code === "23505" && info.constraint?.toLowerCase().includes("labour_wage_settlement_advance_allocations")) return "SETTLEMENT_ALREADY_CREATED";
  return "SETTLEMENT_POSTING_FAILED";
}

function logSettlementAllocationInsertFailure(
  request: { log: { error: (...args: unknown[]) => void } },
  details: {
    workspaceId: string;
    farmId: string;
    seasonId: string;
    settlementId: string;
    settlementNumber: string;
    allocationIndex: number;
    canonicalAdvanceRecordId: string;
    sourceAdvanceId: string;
    absorbedAmount: number;
    error: ReturnType<typeof toDatabaseErrorInfo>;
  },
) {
  request.log.error({
    context: "labour_wage_settlement_allocation_insert_failed",
    workspaceId: details.workspaceId,
    farmId: details.farmId,
    seasonId: details.seasonId,
    settlementRecordId: details.settlementId,
    settlementNumber: details.settlementNumber,
    failingAllocationIndex: details.allocationIndex,
    canonicalAdvanceRecordId: details.canonicalAdvanceRecordId,
    sourceAdvanceId: details.sourceAdvanceId,
    absorbedAmount: details.absorbedAmount,
    postgresCode: details.error?.code ?? null,
    postgresConstraint: details.error?.constraint ?? null,
    postgresTable: details.error?.table ?? null,
    postgresColumn: details.error?.column ?? null,
    postgresDetail: details.error?.detail ?? null,
    postgresHint: details.error?.hint ?? null,
    postgresSchema: details.error?.schema ?? null,
    postgresPosition: details.error?.position ?? null,
    postgresRoutine: details.error?.routine ?? null,
  }, "labour wage settlement advance allocation insert failed");
}

function effectiveAdvanceAdjustmentForPosting(preview: {
  settlementMode?: "individual" | "group";
  grossWages?: number;
  attendanceWages: number;
  labourWorkWages?: number;
  pendingLabourEarnings: number;
  availableAdvanceBalanceBeforeSettlement?: number;
  advancesAvailableUpToSettlementDate?: number;
  advanceAdjustedNow?: number;
  settledAdvanceAmount: number;
}, manualAdjustment = 0) {
  const labourWorkWages = Number(preview.labourWorkWages ?? preview.pendingLabourEarnings ?? 0);
  const grossWages = Number(preview.grossWages ?? (preview.attendanceWages + labourWorkWages));
  const availableAdvanceBalanceBeforeSettlement = Number(preview.availableAdvanceBalanceBeforeSettlement ?? preview.advancesAvailableUpToSettlementDate ?? 0);
  if (preview.settlementMode === "group") {
    return Math.max(0, Math.min(grossWages + manualAdjustment, availableAdvanceBalanceBeforeSettlement));
  }
  return Number(preview.advanceAdjustedNow ?? preview.settledAdvanceAmount ?? 0);
}

class SettlementOverlapConflict extends Error {
  constructor(readonly overlaps: unknown[]) {
    super("An active labour wage settlement already exists for an overlapping date range.");
  }
}

export async function labourWageSettlementRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/workspace/:workspaceId/labour-wage-settlements/status", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser || !request.sessionId) return reply.code(401).send({ message: "A valid session is required." });
    const params = paramsSchema.safeParse(request.params);
    const query = settlementStatusQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ message: "A valid labour settlement status request is required." });
    }
    const { workspaceId } = params.data;
    const { farmId, seasonId, clientRequestId } = query.data;
    if (request.appUser.workspaceId !== workspaceId) return reply.code(403).send({ message: "Select this workspace before checking labour settlement status." });
    if (!hasModulePermission(request.appUser, workspaceId, "wages", "view")) return reply.code(403).send({ message: "Workspace wage settlement view permission is required." });
    if (!hasFarmAccess(request.appUser, workspaceId, farmId)) return reply.code(403).send({ message: "You do not have access to this farm." });
    if (!(await validateContext(request.sessionId, workspaceId, farmId, seasonId))) {
      return reply.code(403).send({ message: "Select this farm and season before checking labour settlement status." });
    }
    const ownershipError = await validateTenantReferences(workspaceId, { farmId, seasonId });
    if (ownershipError) return reply.code(403).send({ message: ownershipError });

    const status = await db.transaction(async (tx) => {
      const existingSettlement = await findSettlementByClientRequestId(tx, workspaceId, farmId, seasonId, clientRequestId);
      if (existingSettlement) {
        const requestRow = await loadSettlementCreateRequest(tx, workspaceId, clientRequestId);
        return settlementCreateStatusFromSettlement(
          clientRequestId,
          {
            clientRecordId: existingSettlement.clientRecordId,
            payload: existingSettlement.payload as Record<string, unknown>,
          },
          await inspectSettlementAccountingIntegrity(tx, {
            ...existingSettlement,
            payload: normalizeSettlementPayload(existingSettlement.payload as Record<string, unknown>),
          }),
          requestRow?.state === "already_created" ? "ALREADY_CREATED" : "SUCCESS",
        );
      }
      const requestRow = await loadSettlementCreateRequest(tx, workspaceId, clientRequestId);
      if (requestRow) {
        const requestStatus = settlementCreateStatusFromRequest(requestRow);
        if (requestStatus.state === "IN_PROGRESS") {
          const processing = await isSettlementRequestProcessing(tx, workspaceId, farmId, clientRequestId);
          if (!processing) {
            return {
              ...requestStatus,
              state: "FAILED",
              safeToRetry: true,
              errorCode: requestStatus.errorCode ?? "SETTLEMENT_POSTING_FAILED",
              message: failedSettlementCreateMessage,
              lifecycleErrorCode: requestStatus.errorCode ?? "SETTLEMENT_POSTING_FAILED",
              lifecycleMessage: failedSettlementCreateMessage,
              stage: "rolled_back",
            } satisfies SettlementCreateStatusResponse;
          }
        }
        return requestStatus;
      }
      const processing = await isSettlementRequestProcessing(tx, workspaceId, farmId, clientRequestId);
      return {
        clientRequestId,
        state: processing ? "IN_PROGRESS" : "FAILED",
        safeToRetry: !processing,
        settlementId: null,
        settlementNumber: null,
        accountingStatus: null,
        accountingMessage: null,
        errorCode: processing ? null : "SETTLEMENT_POSTING_FAILED",
        message: processing
          ? "Settlement creation is still processing. Do not submit it again."
          : failedSettlementCreateMessage,
        lifecycleErrorCode: processing ? null : "SETTLEMENT_POSTING_FAILED",
        lifecycleMessage: processing
          ? "Settlement creation is still processing. Do not submit it again."
          : failedSettlementCreateMessage,
        stage: processing ? "transaction_started" : "rolled_back",
        updatedAt: new Date().toISOString(),
        settlement: null,
      } satisfies SettlementCreateStatusResponse;
    });

    request.log.info({
      workspaceId,
      farmId,
      seasonId,
      clientRequestId,
      state: status.state,
      stage: status.stage,
      safeToRetry: status.safeToRetry,
    }, "labour wage settlement status checked");

    return status;
  });

  app.get("/v1/workspace/:workspaceId/labour-wage-settlements/payment-accounts", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser || !request.sessionId) return reply.code(401).send({ message: "A valid session is required." });
    const params = paramsSchema.safeParse(request.params);
    const query = z.object({ farmId: z.string().uuid() }).safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ message: "A valid payment account request is required." });
    const { workspaceId } = params.data;
    const { farmId } = query.data;
    if (request.appUser.workspaceId !== workspaceId) return reply.code(403).send({ message: "Select this workspace before loading settlement payment accounts." });
    if (!hasModulePermission(request.appUser, workspaceId, "wages", "view")) return reply.code(403).send({ message: "Workspace wage settlement view permission is required." });
    if (!hasFarmAccess(request.appUser, workspaceId, farmId)) return reply.code(403).send({ message: "You do not have access to this farm." });
    const ownershipError = await validateTenantReferences(workspaceId, { farmId });
    if (ownershipError) return reply.code(403).send({ message: ownershipError });
    const accounts = await db.transaction((tx) => listCanonicalPaymentAccounts(tx, workspaceId, farmId));
    return { accounts };
  });

  app.get("/v1/workspace/:workspaceId/labour-wage-settlements", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser || !request.sessionId) return reply.code(401).send({ message: "A valid session is required." });
    const params = paramsSchema.safeParse(request.params);
    const query = z.object({
      farmId: z.string().uuid(),
      seasonId: z.string().uuid(),
    }).safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ message: "A valid settlement request is required." });
    const { workspaceId } = params.data;
    const { farmId, seasonId } = query.data;
    if (request.appUser.workspaceId !== workspaceId) return reply.code(403).send({ message: "Select this workspace before loading labour settlements." });
    if (!hasModulePermission(request.appUser, workspaceId, "wages", "view")) return reply.code(403).send({ message: "Workspace wage settlement view permission is required." });
    if (!hasFarmAccess(request.appUser, workspaceId, farmId)) return reply.code(403).send({ message: "You do not have access to this farm." });
    if (!(await validateContext(request.sessionId, workspaceId, farmId, seasonId))) {
      return reply.code(403).send({ message: "Select this farm and season before viewing labour settlements." });
    }
    const ownershipError = await validateTenantReferences(workspaceId, { farmId, seasonId });
    if (ownershipError) return reply.code(403).send({ message: ownershipError });

    const { rows, diagnostics } = await db.transaction(async (tx) => {
      const settlements = await listLabourWageSettlements(tx, workspaceId, farmId, seasonId);
      const vouchers = await tx.select({
        clientRecordId: operationalRecords.clientRecordId,
        payload: operationalRecords.payload,
      }).from(operationalRecords).where(and(
        eq(operationalRecords.workspaceId, workspaceId),
        eq(operationalRecords.farmId, farmId),
        eq(operationalRecords.seasonId, seasonId),
        eq(operationalRecords.entityType, "voucher"),
      ));
      const voucherById = new Map(vouchers.map((voucher) => [voucher.clientRecordId, voucher.payload as Record<string, unknown>]));
      const transactionCountBySettlementId = await settlementAccountingTransactionCounts(
        tx,
        settlements.map((row) => row.clientRecordId),
      );
      const rows = settlements.map((row) => ({
        id: row.clientRecordId,
        ...row.payload,
        accountingStatus: settlementAccountingStatus(row.payload, transactionCountBySettlementId.get(row.clientRecordId) ?? 0),
        accountingMessage: row.payload.status === "deleted"
          ? "Settlement deleted."
          : row.payload.status === "voided"
          ? "Settlement is voided."
          : (transactionCountBySettlementId.get(row.clientRecordId) ?? 0) > 0
            ? null
            : null,
        updatedAt: row.clientUpdatedAt.toISOString(),
      })).sort((left, right) => right.settlementDate.localeCompare(left.settlementDate) || right.updatedAt.localeCompare(left.updatedAt));
      const activeRows = rows.filter((row) => row.status !== "voided" && !isDeletedOperationalPayload(row));
      let overlappingActiveSettlements = 0;
      for (let index = 0; index < activeRows.length; index += 1) {
        for (let compareIndex = index + 1; compareIndex < activeRows.length; compareIndex += 1) {
          const current = activeRows[index];
          const next = activeRows[compareIndex];
          if (!current || !next) continue;
          if (settlementRangesOverlap(
            current.fromDate,
            current.toDate,
            next.fromDate,
            next.toDate,
          )) {
            overlappingActiveSettlements += 1;
          }
        }
      }
      const diagnostics = {
        settlementsWithoutLinkedVoucher: rows.filter((row) => String(row.linkedVoucherNumber ?? "").trim() !== row.settlementNumber).length,
        linkedVoucherReferenceMismatches: rows.filter((row) => {
          const linked = voucherById.get(row.linkedVoucherId);
          return row.linkedVoucherId && (!linked || linked.settlementId !== row.id);
        }).length,
        postedWithoutAccounting: rows.filter((row) => row.status === "posted" && row.accountingStatus !== "posted").length,
        voidedSettlementsWithActiveVoucher: rows.filter((row) => {
          const linked = voucherById.get(row.linkedVoucherId);
          return row.status === "voided" && linked && !isDeletedOperationalPayload(linked);
        }).length,
        overlappingActiveSettlements,
        pendingLabourEarnings: await tx.select({
          count: operationalRecords.id,
        }).from(operationalRecords).where(and(
          eq(operationalRecords.workspaceId, workspaceId),
          eq(operationalRecords.farmId, farmId),
          eq(operationalRecords.seasonId, seasonId),
          eq(operationalRecords.entityType, "labourEarning"),
        )).then((result) => result.filter(Boolean).length),
      };
      return { rows, diagnostics };
    });
    return { settlements: rows, diagnostics };
  });

  app.get("/v1/workspace/:workspaceId/labour-wage-settlements/:settlementId", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser || !request.sessionId) return reply.code(401).send({ message: "A valid session is required." });
    const params = settlementParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: "A valid settlement request is required." });
    const { workspaceId, settlementId } = params.data;
    if (request.appUser.workspaceId !== workspaceId) return reply.code(403).send({ message: "Select this workspace before loading labour settlements." });
    if (!hasModulePermission(request.appUser, workspaceId, "wages", "view")) return reply.code(403).send({ message: "Workspace wage settlement view permission is required." });
    const settlement = await db.transaction(async (tx) => loadSettlementRow(tx, workspaceId, settlementId));
    if (!settlement) return reply.code(404).send({ message: "Labour settlement not found." });
    if (!settlement.farmId || !settlement.seasonId) return reply.code(400).send({ message: "Labour settlement is missing farm or season context." });
    if (!hasFarmAccess(request.appUser, workspaceId, settlement.farmId)) return reply.code(403).send({ message: "You do not have access to this farm." });
    if (!(await validateContext(request.sessionId, workspaceId, settlement.farmId, settlement.seasonId))) {
      return reply.code(403).send({ message: "Select this farm and season before loading labour settlements." });
    }
    const ownershipError = await validateTenantReferences(workspaceId, { farmId: settlement.farmId, seasonId: settlement.seasonId });
    if (ownershipError) return reply.code(403).send({ message: ownershipError });
    const accountingEntries = await db.transaction((tx) => settlementAccountingTransactionCounts(tx, [settlementId])).then((result) => result.get(settlementId) ?? 0);
    const payload = normalizeSettlementPayload(settlement.payload as Record<string, unknown>);
    return {
      settlement: {
        ...payload,
        id: settlement.clientRecordId,
        workspaceId,
        farmId: settlement.farmId,
        seasonId: settlement.seasonId,
        accountingStatus: settlementAccountingStatus(payload, accountingEntries),
        accountingMessage: payload.status === "deleted"
          ? "Settlement deleted."
          : payload.status === "voided"
            ? "Settlement is voided."
            : accountingEntries > 0
              ? null
            : null,
        updatedAt: settlement.clientUpdatedAt.toISOString(),
        accountingEntries,
      },
    };
  });

  // Attendance-generated Labour Dues — and the attendance wage-settlement
  // flow that calculated and created them — are retired for all future use.
  // Attendance stays an independent operational module (recording, reports,
  // history); every new labour liability is a direct labour-group due.
  // Historical settlements remain readable, payable, voidable, and reversible
  // through the routes below; only calculation and creation are removed. The
  // rejection is a clear business error and never a silent conversion.
  app.post("/v1/workspace/:workspaceId/labour-wage-settlements/preview", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser || !request.sessionId) return reply.code(401).send({ message: "A valid session is required." });
    return reply.code(400).send({ message: ATTENDANCE_DUES_RETIRED_MESSAGE });
  });

  app.post("/v1/workspace/:workspaceId/labour-wage-settlements", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser || !request.sessionId) return reply.code(401).send({ message: "A valid session is required." });
    // This was the only route that created attendance-derived settlements and
    // their linked labour dues (ensureSettlementLabourDue). Queued or retried
    // creation requests receive the same clear rejection and are moved to
    // review by migration 0046 instead of being posted.
    return reply.code(400).send({ message: ATTENDANCE_DUES_RETIRED_MESSAGE });
  });

  app.post("/v1/workspace/:workspaceId/labour-wage-settlements/:settlementId/repair-accounting", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser || !request.sessionId) return reply.code(401).send({ message: "A valid session is required." });
    const params = settlementParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: "A valid settlement repair request is required." });
    const { workspaceId, settlementId } = params.data;
    if (request.appUser.workspaceId !== workspaceId) return reply.code(403).send({ message: "Select this workspace before repairing labour settlements." });
    if (!hasModulePermission(request.appUser, workspaceId, "wages", "edit")) return reply.code(403).send({ message: "Workspace wage settlement edit permission is required." });
    const settlements = await db.select({
      id: operationalRecords.id,
      clientRecordId: operationalRecords.clientRecordId,
      workspaceId: operationalRecords.workspaceId,
      farmId: operationalRecords.farmId,
      seasonId: operationalRecords.seasonId,
      clientUpdatedAt: operationalRecords.clientUpdatedAt,
      payload: operationalRecords.payload,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.entityType, "labourWageSettlement"),
      eq(operationalRecords.clientRecordId, settlementId),
    )).limit(1);
    const settlement = settlements[0];
    if (!settlement) return reply.code(404).send({ message: "Labour settlement not found." });
    if (!settlement.farmId || !settlement.seasonId) {
      return reply.code(400).send({ message: "Labour settlement is missing farm or season context." });
    }
    if (!hasFarmAccess(request.appUser, workspaceId, settlement.farmId)) {
      return reply.code(403).send({ message: "You do not have access to this farm." });
    }
    if (!(await validateContext(request.sessionId, workspaceId, settlement.farmId, settlement.seasonId))) {
      return reply.code(403).send({ message: "Select this farm and season before repairing labour settlement accounting." });
    }
    const ownershipError = await validateTenantReferences(workspaceId, { farmId: settlement.farmId, seasonId: settlement.seasonId });
    if (ownershipError) return reply.code(403).send({ message: ownershipError });

    const result = await db.transaction(async (tx) => {
      const repair = await repairPostedSettlementAccounting(tx, {
        ...settlement,
        payload: normalizeSettlementPayload(settlement.payload as Record<string, unknown>),
      }, request.appUser!.id);
      await tx.insert(auditLogs).values({
        workspaceId,
        userId: request.appUser!.id,
        farmId: settlement.farmId,
        action: "labour_wage_settlement_accounting_repaired",
        entityType: "labourWageSettlement",
        entityId: settlement.id,
        details: repair,
      });
      return repair;
    });
    return result;
  });

  app.patch("/v1/workspace/:workspaceId/labour-wage-settlements/:settlementId", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser || !request.sessionId) return reply.code(401).send({ message: "A valid session is required." });
    // Editing a historical settlement recalculated its wages from attendance,
    // which is retired. Historical settlements stay readable, payable,
    // voidable, and reversible — recalculation is the only thing removed.
    return reply.code(400).send({ message: ATTENDANCE_DUES_RETIRED_MESSAGE });
  });

  app.post("/v1/workspace/:workspaceId/labour-wage-settlements/:settlementId/void", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser || !request.sessionId) return reply.code(401).send({ message: "A valid session is required." });
    const params = settlementParamsSchema.safeParse(request.params);
    const parsed = z.object({ voidReason: z.string().trim().max(500).optional() }).safeParse(request.body ?? {});
    if (!params.success || !parsed.success) return reply.code(400).send({ message: "A valid settlement void request is required." });
    const { workspaceId, settlementId } = params.data;
    if (request.appUser.workspaceId !== workspaceId) return reply.code(403).send({ message: "Select this workspace before voiding labour settlements." });
    if (!hasModulePermission(request.appUser, workspaceId, "wages", "edit")) return reply.code(403).send({ message: "Workspace wage settlement edit permission is required." });

    const settlement = await db.transaction(async (tx) => loadSettlementRow(tx, workspaceId, settlementId));
    if (!settlement) return reply.code(404).send({ message: "Labour settlement not found." });
    if (!settlement.farmId || !settlement.seasonId) return reply.code(400).send({ message: "Labour settlement is missing farm or season context." });
    if (!hasFarmAccess(request.appUser, workspaceId, settlement.farmId)) return reply.code(403).send({ message: "You do not have access to this farm." });
    if (!(await validateContext(request.sessionId, workspaceId, settlement.farmId, settlement.seasonId))) {
      return reply.code(403).send({ message: "Select this farm and season before voiding labour settlements." });
    }
    const ownershipError = await validateTenantReferences(workspaceId, { farmId: settlement.farmId, seasonId: settlement.seasonId });
    if (ownershipError) return reply.code(403).send({ message: ownershipError });

    const payload = normalizeSettlementPayload(settlement.payload as Record<string, unknown>);
    if (payload.status === "deleted") return reply.code(409).send({ message: "Deleted settlements cannot be voided." });
    if (payload.status === "voided") {
      return {
        settlementId,
        settlementNumber: payload.settlementNumber,
        status: "voided" as const,
        voidedAt: payload.voidedAt,
        voidedBy: payload.voidedBy,
        voidReason: payload.voidReason,
      };
    }

    const transactionCount = await db.transaction((tx) => settlementAccountingTransactionCounts(tx, [settlementId])).then((result) => result.get(settlementId) ?? 0);

    const activeLinkedPayment = await db.select({ id: labourPaymentAllocations.id }).from(labourPaymentAllocations)
      .innerJoin(labourDues, eq(labourDues.id, labourPaymentAllocations.dueId))
      .where(and(eq(labourDues.sourceRecordId, settlement.id), eq(labourPaymentAllocations.status, "ACTIVE")))
      .limit(1);
    if (activeLinkedPayment.length) return reply.code(409).send({ message: "Void linked Labour Payment Vouchers before voiding this settlement." });

    const voidedAt = new Date();
    const voidedIso = voidedAt.toISOString();
    const voidReason = parsed.data.voidReason?.trim() || "Voided settlement";
    const result = await db.transaction(async (tx) => {
      const [linkedDue] = await tx.select({ id: labourDues.id }).from(labourDues).where(eq(labourDues.sourceRecordId, settlement.id)).limit(1);
      if (linkedDue) {
        const activePayments = await tx.select({ id: labourPaymentAllocations.id }).from(labourPaymentAllocations).where(and(
          eq(labourPaymentAllocations.dueId, linkedDue.id),
          eq(labourPaymentAllocations.status, "ACTIVE"),
        )).limit(1);
        if (activePayments.length) throw new Error("Void linked Labour Payment Vouchers before voiding this settlement.");
      }
      const accountingRows = await tx.select({
        id: accountTransactions.id,
        accountId: accountTransactions.accountId,
        type: accountTransactions.type,
        amount: accountTransactions.amount,
        transactionDate: accountTransactions.transactionDate,
        remarks: accountTransactions.remarks,
      }).from(accountTransactions).where(and(
        eq(accountTransactions.referenceId, settlementId),
        eq(accountTransactions.source, "settlement"),
        eq(accountTransactions.sourceType, "labour_wage_settlement"),
      ));
      const originalTransaction = accountingRows.find((row) => typeof row.remarks !== "string" || !row.remarks.startsWith("Reversal of Labour Wage Settlement"))
        ?? accountingRows[0];
      const reversalAlreadyExists = accountingRows.some((row) => typeof row.remarks === "string" && row.remarks.startsWith("Reversal of Labour Wage Settlement"));
      if (originalTransaction && !reversalAlreadyExists) {
        await tx.insert(accountTransactions).values({
          farmId: settlement.farmId!,
          seasonId: settlement.seasonId!,
          accountId: originalTransaction.accountId,
          source: "settlement",
          sourceType: "labour_wage_settlement",
          referenceId: settlementId,
          type: originalTransaction.type === "credit" ? "debit" : "credit",
          amount: originalTransaction.amount,
          transactionDate: payload.settlementDate,
          remarks: `Reversal of Labour Wage Settlement ${payload.settlementNumber}`,
          createdBy: request.appUser!.id,
        });
      }
      const nextPayload = {
        ...payload,
        status: "voided" as const,
        voidedAt: voidedIso,
        voidedBy: request.appUser!.id,
        voidReason,
        updatedAt: voidedIso,
        accountingStatus: "voided" as const,
        accountingMessage: "Settlement has been voided.",
      };
      await tx.update(operationalRecords).set({
        payload: nextPayload,
        clientUpdatedAt: voidedAt,
        updatedAt: voidedAt,
        recordedBy: request.appUser!.id,
      }).where(eq(operationalRecords.id, settlement.id));
      if (linkedDue) {
        const applicationsToReverse = await tx.select({ id: labourAdvanceApplications.id }).from(labourAdvanceApplications).where(and(
          eq(labourAdvanceApplications.dueId, linkedDue.id),
          eq(labourAdvanceApplications.status, "ACTIVE"),
        ));
        await tx.update(labourAdvanceApplications).set({
          status: "REVERSED",
          reversedAt: voidedAt,
          reversedBy: request.appUser!.id,
          updatedAt: voidedAt,
        }).where(and(
          eq(labourAdvanceApplications.dueId, linkedDue.id),
          eq(labourAdvanceApplications.status, "ACTIVE"),
        ));
        await tx.update(labourDues).set({
          calculationStatus: "VOIDED",
          paymentStatus: "VOIDED",
          voidReason,
          voidedAt,
          voidedBy: request.appUser!.id,
          updatedAt: voidedAt,
        }).where(eq(labourDues.id, linkedDue.id));
        await reverseLabourJournal(tx, {
          workspaceId, farmId: settlement.farmId!, seasonId: settlement.seasonId!, actorId: request.appUser!.id,
          reversalKey: `settlement-void:${settlement.id}:due`, originalEventKey: `due:${linkedDue.id}`,
          ignoreMissing: true,
        });
        for (const application of applicationsToReverse) await reverseLabourJournal(tx, {
          workspaceId, farmId: settlement.farmId!, seasonId: settlement.seasonId!, actorId: request.appUser!.id,
          reversalKey: `settlement-void:${settlement.id}:application:${application.id}`,
          originalEventKey: `advance-application:${application.id}`,
        });
      }
      const earningsToReopen = await listLabourEarnings(tx, workspaceId, settlement.farmId!, settlement.seasonId!);
      for (const earning of earningsToReopen) {
        if (earning.payload.linkedSettlementId !== settlementId) continue;
        const nextEarningPayload = {
          ...normalizeLabourEarningPayload(earning.payload as Record<string, unknown>),
          status: "pending_settlement" as const,
          linkedSettlementId: null,
          settlementDate: null,
          updatedBy: request.appUser!.id,
          updatedAt: voidedIso,
        };
        await tx.update(operationalRecords).set({
          payload: nextEarningPayload,
          clientUpdatedAt: voidedAt,
          updatedAt: voidedAt,
        }).where(eq(operationalRecords.id, earning.id));
      }
      const attendanceRows = await tx.select({
        id: operationalRecords.id,
        payload: operationalRecords.payload,
      }).from(operationalRecords).where(and(
        eq(operationalRecords.workspaceId, workspaceId),
        eq(operationalRecords.farmId, settlement.farmId!),
        eq(operationalRecords.seasonId, settlement.seasonId!),
        eq(operationalRecords.entityType, "attendance"),
        sql`${operationalRecords.payload}->>'linkedSettlementId' = ${settlementId}`,
      ));
      for (const attendance of attendanceRows) {
        const nextAttendancePayload = {
          ...(attendance.payload as Record<string, unknown>),
          linkedSettlementId: null,
          settlementDate: null,
          updatedAt: voidedIso,
        };
        await tx.update(operationalRecords).set({
          payload: nextAttendancePayload,
          clientUpdatedAt: voidedAt,
          updatedAt: voidedAt,
        }).where(eq(operationalRecords.id, attendance.id));
      }
      await tx.insert(auditLogs).values({
        workspaceId,
        userId: request.appUser!.id,
        farmId: settlement.farmId,
        action: "labour_wage_settlement_voided",
        entityType: "labourWageSettlement",
        entityId: settlement.id,
        details: {
          settlementId,
          settlementNumber: payload.settlementNumber,
          accountingEntries: transactionCount,
          voidReason,
          reopenedAttendanceCount: attendanceRows.length,
        },
      });
      return {
        settlementId,
        settlementNumber: payload.settlementNumber,
        status: "voided" as const,
        voidedAt: voidedIso,
        voidedBy: request.appUser!.id,
        voidReason,
        accountingEntries: transactionCount,
      };
    });

    return result;
  });

  app.delete("/v1/workspace/:workspaceId/labour-wage-settlements/:settlementId", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser || !request.sessionId) return reply.code(401).send({ message: "A valid session is required." });
    const params = settlementParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: "A valid settlement delete request is required." });
    const { workspaceId, settlementId } = params.data;
    if (request.appUser.workspaceId !== workspaceId) return reply.code(403).send({ message: "Select this workspace before deleting labour settlements." });
    if (!hasModulePermission(request.appUser, workspaceId, "wages", "delete")) return reply.code(403).send({ message: "Workspace wage settlement delete permission is required." });

    const settlements = await db.select({
      id: operationalRecords.id,
      clientRecordId: operationalRecords.clientRecordId,
      workspaceId: operationalRecords.workspaceId,
      farmId: operationalRecords.farmId,
      seasonId: operationalRecords.seasonId,
      clientUpdatedAt: operationalRecords.clientUpdatedAt,
      payload: operationalRecords.payload,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.entityType, "labourWageSettlement"),
      eq(operationalRecords.clientRecordId, settlementId),
    )).limit(1);
    const settlement = settlements[0];
    if (!settlement) return reply.code(404).send({ message: "Labour settlement not found." });

    const payload = normalizeSettlementPayload(settlement.payload as Record<string, unknown>);
    if (!settlement.farmId || !settlement.seasonId) {
      return reply.code(400).send({ message: "Labour settlement is missing farm or season context." });
    }
    if (!hasFarmAccess(request.appUser, workspaceId, settlement.farmId)) {
      return reply.code(403).send({ message: "You do not have access to this farm." });
    }
    if (!(await validateContext(request.sessionId, workspaceId, settlement.farmId, settlement.seasonId))) {
      return reply.code(403).send({ message: "Select this farm and season before deleting labour settlements." });
    }
    const ownershipError = await validateTenantReferences(workspaceId, { farmId: settlement.farmId, seasonId: settlement.seasonId });
    if (ownershipError) return reply.code(403).send({ message: ownershipError });

    if (payload.status === "deleted" || isDeletedOperationalPayload(payload)) {
      return {
        settlementId,
        settlementNumber: payload.settlementNumber,
        status: "deleted" as const,
        linkedVoucherId: payload.linkedVoucherId,
        linkedVoucherNumber: payload.linkedVoucherNumber,
        accountingEntries: 0,
      };
    }

    const transactionCounts = await db.transaction((tx) => settlementAccountingTransactionCounts(tx, [settlementId]));
    const accountingEntries = transactionCounts.get(settlementId) ?? 0;
    const canDelete = accountingEntries === 0 && payload.status !== "posted";
    if (!canDelete) {
      return reply.code(409).send({
        message: "This settlement has accounting entries. Use Void/Reverse instead.",
        details: {
          code: "settlement_accounting_exists",
          settlementId,
          settlementNumber: payload.settlementNumber,
          accountingEntries,
        },
      });
    }

    const deletedAt = new Date();
    const deletedIso = deletedAt.toISOString();
    const result = await db.transaction(async (tx) => {
      const nextSettlementPayload = {
        ...payload,
        status: "deleted" as const,
        deletedAt: deletedIso,
        deletedBy: request.appUser!.id,
        updatedAt: deletedIso,
        accountingStatus: "deleted" as const,
        accountingMessage: "Settlement deleted before accounting was posted.",
      };
      await tx.update(operationalRecords).set({
        payload: nextSettlementPayload,
        clientUpdatedAt: deletedAt,
        updatedAt: deletedAt,
        recordedBy: request.appUser!.id,
      }).where(eq(operationalRecords.id, settlement.id));

      await tx.insert(auditLogs).values({
        workspaceId,
        userId: request.appUser!.id,
        farmId: settlement.farmId,
        action: "labour_wage_settlement_deleted",
        entityType: "labourWageSettlement",
        entityId: settlement.id,
        details: {
          settlementId,
          settlementNumber: payload.settlementNumber,
          linkedVoucherId: payload.linkedVoucherId,
          linkedVoucherNumber: payload.linkedVoucherNumber,
          accountingEntries,
          reason: "deleted before accounting was posted",
        },
      });

      return {
        settlementId,
        settlementNumber: payload.settlementNumber,
        status: "deleted" as const,
        linkedVoucherId: payload.linkedVoucherId,
        linkedVoucherNumber: payload.linkedVoucherNumber,
        accountingEntries,
      };
    });

    return result;
  });
}
