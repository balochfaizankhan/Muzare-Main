import type { FastifyInstance } from "fastify";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { db } from "../db/client.js";
import { accountTransactions, auditLogs, labourWageSettlementAdvanceAllocations, labourWageSettlementCreateRequests, operationalRecords, userSessions } from "../db/schema.js";
import { listLabourEarnings, normalizeLabourEarningPayload } from "../lib/labour-earnings.js";
import { isDeletedOperationalPayload } from "../operational-record-state.js";
import { hasFarmAccess } from "../workspace-access.js";
import { hasModulePermission } from "../permissions.js";
import { validateTenantReferences } from "../tenant-ownership.js";
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

  app.post("/v1/workspace/:workspaceId/labour-wage-settlements/preview", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser || !request.sessionId) return reply.code(401).send({ message: "A valid session is required." });
    const params = paramsSchema.safeParse(request.params);
    const parsed = previewSchema.safeParse(request.body);
    if (!params.success || !parsed.success || parsed.data.fromDate > parsed.data.toDate) {
      const fields = [
        ...(!params.success ? validationIssuePaths(params.error) : []),
        ...(!parsed.success ? validationIssuePaths(parsed.error) : []),
        ...(parsed.success && parsed.data.fromDate > parsed.data.toDate ? ["fromDate", "toDate"] : []),
      ];
      const uniqueFields = [...new Set(fields)];
      return reply.code(400).send({
        message: parsed.success && parsed.data.fromDate > parsed.data.toDate
          ? "From date must be on or before the to date."
          : "Labour settlement preview validation failed.",
        fields: uniqueFields,
        details: !params.success
          ? params.error.issues
          : !parsed.success
            ? parsed.error.issues
            : { fromDate: parsed.data.fromDate, toDate: parsed.data.toDate },
      });
    }
    const { workspaceId } = params.data;
    const { farmId, seasonId, fromDate, toDate, settlementDate, settlementMode, labourerId, foremanId, groupId, labourIds, paidAmount, manualAdjustment } = parsed.data;
    if (process.env.NODE_ENV !== "production") {
      request.log.info({
        workspaceId,
        farmId,
        seasonId,
        settlementMode: settlementMode ?? "individual",
        labourerId: labourerId ?? null,
        foremanId: typeof foremanId === "string" ? foremanId : null,
        groupId: groupId ?? null,
      }, "labour wage settlement preview request parsed");
    }
    if (request.appUser.workspaceId !== workspaceId) return reply.code(403).send({ message: "Select this workspace before previewing labour settlements." });
    if (!hasModulePermission(request.appUser, workspaceId, "wages", "view")) return reply.code(403).send({ message: "Workspace wage settlement view permission is required." });
    if (!hasFarmAccess(request.appUser, workspaceId, farmId)) return reply.code(403).send({ message: "You do not have access to this farm." });
    if (!(await validateContext(request.sessionId, workspaceId, farmId, seasonId))) {
      return reply.code(403).send({ message: "Select this farm and season before previewing labour settlements." });
    }
    const ownershipError = await validateTenantReferences(workspaceId, { farmId, seasonId });
    if (ownershipError) return reply.code(403).send({ message: ownershipError });
    let resolvedSelection;
    try {
      resolvedSelection = await db.transaction((tx) => resolveSettlementSelection(tx, workspaceId, farmId, {
        settlementMode,
        labourerId,
        foremanId,
        groupId,
        labourIds,
      }));
    } catch (error) {
      return reply.code(400).send({
        message: error instanceof Error ? error.message : "Unable to resolve the selected labour settlement group.",
        fields: ["groupId"],
      });
    }
    if (process.env.NODE_ENV !== "production") {
      request.log.info({
        workspaceId,
        farmId,
        seasonId,
        resolvedForemanId: resolvedSelection.foremanId ?? null,
        resolvedGroupId: resolvedSelection.groupId ?? null,
      }, "labour wage settlement preview selection resolved");
    }
    const preview = await db.transaction((tx) => previewLabourWageSettlement(tx, workspaceId, farmId, seasonId, fromDate, toDate, settlementDate, undefined, {
      settlementMode,
      labourerId: resolvedSelection.labourerId,
      foremanId: resolvedSelection.foremanId,
      groupId: resolvedSelection.groupId,
      labourIds: resolvedSelection.labourIds,
    }));
    const effectiveAdvanceAdjustedNow = effectiveAdvanceAdjustmentForPosting(preview, Number(manualAdjustment ?? 0));
    const updated = calculateLabourWageSettlementTotals(
      preview.attendanceWages,
      preview.labourWorkWages ?? preview.pendingLabourEarnings,
      preview.availableAdvanceBalanceBeforeSettlement ?? preview.advancesAvailableUpToSettlementDate ?? 0,
      Number(paidAmount ?? 0),
      Number(manualAdjustment ?? 0),
      effectiveAdvanceAdjustedNow,
    );
    preview.paidAmount = Number(paidAmount ?? 0);
    preview.manualAdjustment = Number(manualAdjustment ?? 0);
    preview.netPayableBeforePayment = updated.netPayableBeforePayment;
    preview.balanceAfterPayment = updated.balanceAfterPayment;
    preview.payableBalance = updated.payableBalance;
    preview.advanceAdjustedNow = updated.advanceAdjustedNow;
    preview.settledAdvanceAmount = updated.advanceAdjustedNow;
    preview.appliedAdvances = updated.advanceAdjustedNow;
    preview.remainingAdvanceCarryForward = updated.remainingAdvanceCarryForward;
    preview.carryForwardAdvance = updated.remainingAdvanceCarryForward;
    return { preview, valid: preview.unresolvedRows.length === 0 && preview.overlappingSettlements.length === 0 };
  });

  app.post("/v1/workspace/:workspaceId/labour-wage-settlements", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser || !request.sessionId) return reply.code(401).send({ message: "A valid session is required." });
    const params = paramsSchema.safeParse(request.params);
    const parsed = createSchema.safeParse(request.body);
    if (!params.success || !parsed.success || parsed.data.fromDate > parsed.data.toDate) {
      const fields = [
        ...(!params.success ? validationIssuePaths(params.error) : []),
        ...(!parsed.success ? validationIssuePaths(parsed.error) : []),
        ...(parsed.success && parsed.data.fromDate > parsed.data.toDate ? ["fromDate", "toDate"] : []),
      ];
      const uniqueFields = [...new Set(fields)];
      return reply.code(400).send({
        message: parsed.success && parsed.data.fromDate > parsed.data.toDate
          ? "From date must be on or before the to date."
          : "Labour settlement validation failed.",
        fields: uniqueFields,
        details: !params.success
          ? params.error.issues
          : !parsed.success
            ? parsed.error.issues
            : { fromDate: parsed.data.fromDate, toDate: parsed.data.toDate },
      });
    }
    const { workspaceId } = params.data;
    const {
      farmId,
      seasonId,
      fromDate,
      toDate,
      settlementDate,
      settlementMode,
      labourerId,
      foremanId,
      groupId,
      labourIds,
      clientRequestId,
      paymentAccountId,
      accountId,
      paidAmount,
      manualAdjustment,
      manualAdjustmentNote,
      notes,
    } = parsed.data;
    const requestStartTime = Date.now();
    const effectiveClientRequestId = clientRequestId ?? crypto.randomUUID();
    const createRequestBase = {
      workspaceId,
      farmId,
      seasonId,
      clientRequestId: effectiveClientRequestId,
      correlationId: request.id,
    } as const;
    const updateCreateRequestState = async (
      state: SettlementCreateRequestInternalState,
      options: {
        stage?: SettlementCreateRequestInternalState | null;
        settlementOperationalRecordId?: string | null;
        settlementClientRecordId?: string | null;
        settlementNumber?: string | null;
        errorCode?: string | null;
        safeToRetry?: boolean;
        message?: string | null;
        completedAt?: Date | null;
      } = {},
    ) => {
      await upsertSettlementCreateRequestState({
        ...createRequestBase,
        state,
        stage: options.stage ?? state,
        settlementOperationalRecordId: options.settlementOperationalRecordId ?? null,
        settlementClientRecordId: options.settlementClientRecordId ?? null,
        settlementNumber: options.settlementNumber ?? null,
        errorCode: options.errorCode ?? null,
        safeToRetry: options.safeToRetry ?? false,
        message: options.message ?? settlementCreateStageMessage(options.stage ?? state),
        completedAt: options.completedAt ?? null,
      });
      request.log.info({
        ...createRequestBase,
        state,
        stage: options.stage ?? state,
        elapsedMs: Date.now() - requestStartTime,
      }, "labour wage settlement request state updated");
    };
    if (request.appUser.workspaceId !== workspaceId) return reply.code(403).send({ message: "Select this workspace before creating labour settlements." });
    if (!hasModulePermission(request.appUser, workspaceId, "wages", "create")) return reply.code(403).send({ message: "Workspace wage settlement create permission is required." });
    if (!hasFarmAccess(request.appUser, workspaceId, farmId)) return reply.code(403).send({ message: "You do not have access to this farm." });
    if (!(await validateContext(request.sessionId, workspaceId, farmId, seasonId))) {
      return reply.code(403).send({ message: "Select this farm and season before creating labour settlements." });
    }
    const ownershipError = await validateTenantReferences(workspaceId, { farmId, seasonId });
    if (ownershipError) return reply.code(403).send({ message: ownershipError });
    if (Number(manualAdjustment ?? 0) !== 0 && !manualAdjustmentNote?.trim()) {
      return reply.code(400).send({ message: "Manual adjustment note is required when manual adjustment is non-zero." });
    }

    request.log.info({
      workspaceId,
      farmId,
      seasonId,
      fromDate,
      toDate,
      settlementDate,
      settlementMode: settlementMode ?? "individual",
      clientRequestId: effectiveClientRequestId,
    }, "labour wage settlement create request received");
    const existingRequestState = await loadSettlementCreateRequest(db, workspaceId, effectiveClientRequestId);
    if (existingRequestState && settlementPublicState(existingRequestState.state) === "IN_PROGRESS") {
      const inProgressStatus = settlementCreateStatusFromRequest(existingRequestState);
      request.log.info({
        ...createRequestBase,
        state: inProgressStatus.state,
        stage: inProgressStatus.stage,
      }, "labour wage settlement create request already in progress");
      return reply.code(202).send(inProgressStatus);
    }
    await updateCreateRequestState("request_received");
    if (process.env.NODE_ENV !== "production") {
      request.log.info({
        workspaceId,
        farmId,
        seasonId,
        labourerId: labourerId ?? null,
        foremanId: typeof foremanId === "string" ? foremanId : null,
        groupId: groupId ?? null,
      }, "labour wage settlement create request parsed");
    }
    await updateCreateRequestState("validation_complete");

    let resolvedSelection;
    try {
      resolvedSelection = await db.transaction((tx) => resolveSettlementSelection(tx, workspaceId, farmId, {
        settlementMode,
        labourerId,
        foremanId,
        groupId,
        labourIds,
      }));
    } catch (error) {
      await updateCreateRequestState("rolled_back", {
        errorCode: "SETTLEMENT_SCOPE_INVALID",
        safeToRetry: true,
        message: error instanceof Error ? error.message : "Unable to resolve the selected labour settlement group.",
        completedAt: new Date(),
      });
      return reply.code(400).send({
        message: error instanceof Error ? error.message : "Unable to resolve the selected labour settlement group.",
        fields: ["groupId"],
      });
    }
    await updateCreateRequestState("selection_resolved");
    if (process.env.NODE_ENV !== "production") {
      request.log.info({
        workspaceId,
        farmId,
        seasonId,
        resolvedForemanId: resolvedSelection.foremanId ?? null,
        resolvedGroupId: resolvedSelection.groupId ?? null,
      }, "labour wage settlement create selection resolved");
    }

    const existingSettlement = await db.transaction((tx) => findSettlementByClientRequestId(tx, workspaceId, farmId, seasonId, effectiveClientRequestId));
    if (existingSettlement) {
      const accounting = await db.transaction((tx) => inspectSettlementAccountingIntegrity(tx, {
        ...existingSettlement,
        payload: normalizeSettlementPayload(existingSettlement.payload as Record<string, unknown>),
      }));
      await updateCreateRequestState("already_created", {
        settlementOperationalRecordId: existingSettlement.id,
        settlementClientRecordId: existingSettlement.clientRecordId,
        settlementNumber: normalizeSettlementPayload(existingSettlement.payload as Record<string, unknown>).settlementNumber,
        safeToRetry: false,
        completedAt: new Date(),
      });
      request.log.info({
        workspaceId,
        farmId,
        seasonId,
        settlementId: existingSettlement.clientRecordId,
        clientRequestId: effectiveClientRequestId,
      }, "labour wage settlement create request matched existing settlement");
      const settlement = settlementResponseFromRow({
        clientRecordId: existingSettlement.clientRecordId,
        payload: existingSettlement.payload as Record<string, unknown>,
      });
      return reply.send({
        clientRequestId: effectiveClientRequestId,
        state: "ALREADY_CREATED" as const,
        safeToRetry: false,
        settlementId: settlement.settlement.id,
        settlementNumber: settlement.settlement.settlementNumber,
        accountingStatus: accounting.accountingStatus,
        accountingMessage: accounting.accountingMessage,
        errorCode: null,
        message: `This settlement was already created as ${settlement.settlement.settlementNumber}.`,
        lifecycleErrorCode: null,
        lifecycleMessage: `This settlement was already created as ${settlement.settlement.settlementNumber}.`,
        stage: "already_created",
        updatedAt: new Date().toISOString(),
        settlement: settlement.settlement,
      } satisfies SettlementCreateStatusResponse);
    }

    const previewStartedAt = Date.now();
    const preview = await db.transaction((tx) => previewLabourWageSettlement(tx, workspaceId, farmId, seasonId, fromDate, toDate, settlementDate, undefined, {
      settlementMode,
      labourerId: resolvedSelection.labourerId,
      foremanId: resolvedSelection.foremanId,
      groupId: resolvedSelection.groupId,
      labourIds: resolvedSelection.labourIds,
    }));
    request.log.info({
      workspaceId,
      farmId,
      seasonId,
      previewDurationMs: Date.now() - previewStartedAt,
      includedLabourCount: preview.includedLabourRows?.length ?? 0,
      includedAttendanceCount: preview.sourceAttendanceIds?.length ?? 0,
      includedEarningCount: preview.includedEarnings?.length ?? 0,
      overlappingSettlementCount: preview.overlappingSettlements.length,
      unresolvedRowCount: preview.unresolvedRows.length,
    }, "labour wage settlement preview revalidated for posting");
    await updateCreateRequestState("preview_recalculated");
    if (preview.unresolvedRows.length) {
      await updateCreateRequestState("rolled_back", {
        errorCode: "SETTLEMENT_PREVIEW_INVALID",
        safeToRetry: true,
        message: "Attendance wages cannot be settled until missing wage rates are fixed.",
        completedAt: new Date(),
      });
      return reply.code(409).send({
        message: "Attendance wages cannot be settled until missing wage rates are fixed.",
        details: { code: "missing_wage_rates", unresolvedRows: preview.unresolvedRows },
      });
    }
    if (preview.overlappingSettlements.length) {
      await updateCreateRequestState("rolled_back", {
        errorCode: "SETTLEMENT_OVERLAP",
        safeToRetry: true,
        message: "An active labour wage settlement already exists for an overlapping date range.",
        completedAt: new Date(),
      });
      return reply.code(409).send({
        message: "An active labour wage settlement already exists for an overlapping date range.",
        details: {
          code: "overlapping_labour_wage_settlement",
          overlaps: preview.overlappingSettlements,
        },
      });
    }
    try {
      const transactionStartedAt = Date.now();
      await updateCreateRequestState("transaction_started");
      request.log.info({
        workspaceId,
        farmId,
        seasonId,
        clientRequestId: effectiveClientRequestId,
      }, "labour wage settlement transaction started");
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
        await tx.execute(sql`SET LOCAL statement_timeout = '90s'`);
        {
          const requestScopeKey = `${workspaceId}:${farmId}:labour-wage-settlement:${effectiveClientRequestId}`;
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${requestScopeKey}), 1)`);
          const existingByRequest = await findSettlementByClientRequestId(tx, workspaceId, farmId, seasonId, effectiveClientRequestId);
          if (existingByRequest) {
            request.log.info({
              workspaceId,
              farmId,
              seasonId,
              settlementId: existingByRequest.clientRecordId,
              clientRequestId: effectiveClientRequestId,
            }, "labour wage settlement duplicate request reused existing settlement inside transaction");
            const settlement = settlementResponseFromRow({
              clientRecordId: existingByRequest.clientRecordId,
              payload: existingByRequest.payload as Record<string, unknown>,
            });
            const accounting = await inspectSettlementAccountingIntegrity(tx, {
              ...existingByRequest,
              payload: normalizeSettlementPayload(existingByRequest.payload as Record<string, unknown>),
            });
            return {
              state: "ALREADY_CREATED" as const,
              settlementOperationalRecordId: existingByRequest.id,
              settlementClientRecordId: settlement.settlement.id,
              settlementNumber: settlement.settlement.settlementNumber,
              accountingStatus: accounting.accountingStatus,
              accountingMessage: accounting.accountingMessage,
              settlement: settlement.settlement,
            };
          }
        }
        const effectivePaidAmount = Number(paidAmount ?? 0);
        const paymentAccountInput = paymentAccountId ?? accountId ?? "";
        logSettlementAccountValidation(request, {
          paymentAccountId: paymentAccountInput,
          selectedFarmId: farmId,
          selectedSeasonId: seasonId,
        });
        const resolvedAccount = paymentAccountInput
          ? await resolveCanonicalPaymentAccountId(tx, workspaceId, farmId, paymentAccountInput)
          : null;
        logSettlementAccountValidation(request, {
          paymentAccountId: paymentAccountInput,
          selectedFarmId: farmId,
          selectedSeasonId: seasonId,
          accountRowFound: Boolean(resolvedAccount),
          accountFarmId: resolvedAccount?.farmId ?? null,
          accountType: resolvedAccount?.accountType ?? null,
          accountActive: resolvedAccount?.active ?? null,
          accountSourceType: resolvedAccount?.sourceType ?? null,
        });
        if (effectivePaidAmount > 0) {
          const accountValidation = validateLabourSettlementPaymentAccount(resolvedAccount, farmId);
          if (!accountValidation.valid) {
            logSettlementAccountValidation(request, {
              paymentAccountId: paymentAccountInput,
              selectedFarmId: farmId,
              selectedSeasonId: seasonId,
              validationReason: accountValidation.reason,
              validationMessage: accountValidation.message,
            });
            throw new Error(accountValidation.message ?? "Payment account validation failed.");
          }
          if (!resolvedAccount) {
            throw new Error("Payment account is not mapped. Please repair imported accounts.");
          }
        }
        const account = resolvedAccount;
        const createdAt = new Date();
        const settlementClientRecordId = crypto.randomUUID();
        const settlementNumber = await allocateSettlementNumber(tx, workspaceId, farmId);
        const effectiveAdvanceAdjustedNow = effectiveAdvanceAdjustmentForPosting(preview, Number(manualAdjustment ?? 0));
        const settlementTotals = calculateLabourWageSettlementTotals(
          preview.attendanceWages,
          preview.labourWorkWages ?? preview.pendingLabourEarnings,
          preview.availableAdvanceBalanceBeforeSettlement ?? preview.advancesAvailableUpToSettlementDate ?? 0,
          effectivePaidAmount,
          Number(manualAdjustment ?? 0),
          effectiveAdvanceAdjustedNow,
        );
        const description = `Labour wage settlement: ${fromDate} to ${toDate} (attendance wages + labour work)`;
        const paymentAccountIdValue = effectivePaidAmount > 0 ? account?.id ?? resolvedAccount?.id ?? paymentAccountInput : null;
        const legacyUnallocatedAdvanceConsumption = Number((preview as { legacyUnallocatedPreviouslySettledAdvances?: unknown }).legacyUnallocatedPreviouslySettledAdvances ?? 0);
        if (legacyUnallocatedAdvanceConsumption > 0.005) {
          request.log.error({
            workspaceId,
            farmId,
            seasonId,
            settlementClientRecordId,
            settlementNumber,
            legacyUnallocatedAdvanceConsumption,
            ambiguousHistoricalSettlements: (preview as { ambiguousHistoricalSettlements?: unknown }).ambiguousHistoricalSettlements ?? [],
          }, "labour wage settlement posting blocked by ambiguous historical advance consumption");
          throw new Error("Historical settlement advance allocations need review before posting a new settlement.");
        }
        const advanceAbsorptionRows: Array<{
          allocationIndex: number;
          advanceRecordId: string;
          sourceAdvanceId: string;
          absorbedAmount: number;
          remainingAvailableAmount: number;
        }> = [];
        const advanceAbsorptionByCanonicalId = new Map<string, {
          allocationIndex: number;
          advanceRecordId: string;
          sourceAdvanceId: string;
          absorbedAmount: number;
          remainingAvailableAmount: number;
        }>();
        let absorbedAdvanceTotal = 0;
        for (const [allocationIndex, row] of (preview.advanceReconciliation ?? []).entries()) {
          if (!row.includedInPreview || row.remainingAvailableAmount <= 0) continue;
          const canonicalAdvanceRecordId = typeof row.advanceRecordId === "string" ? row.advanceRecordId.trim() : "";
          if (!canonicalAdvanceRecordId) {
            request.log.error({
              workspaceId,
              farmId,
              seasonId,
              settlementClientRecordId,
              settlementNumber,
              allocationIndex,
              sourceAdvanceId: row.sourceAdvanceId ?? row.advanceId,
            }, "labour wage settlement allocation missing canonical advance id");
            throw new Error("Settlement could not be created because its advance records could not be linked. No changes were saved.");
          }
          const sourceAdvanceId = typeof row.sourceAdvanceId === "string" && row.sourceAdvanceId.trim()
            ? row.sourceAdvanceId.trim()
            : row.advanceId;
          const remainingTarget = Math.max(0, settlementTotals.advanceAdjustedNow - absorbedAdvanceTotal);
          if (remainingTarget <= 0) break;
          const absorbedAmount = Math.min(remainingTarget, row.remainingAvailableAmount);
          if (absorbedAmount <= 0) continue;
          if (advanceAbsorptionByCanonicalId.has(canonicalAdvanceRecordId)) {
            if (process.env.NODE_ENV !== "production") {
              request.log.warn({
              workspaceId,
              farmId,
              seasonId,
              settlementClientRecordId,
              settlementNumber,
                allocationIndex,
                canonicalAdvanceRecordId,
                sourceAdvanceId,
              }, "duplicate settlement advance allocation skipped during preparation");
            }
            continue;
          }
          const allocation = {
            allocationIndex,
            advanceRecordId: canonicalAdvanceRecordId,
            sourceAdvanceId,
            absorbedAmount,
            remainingAvailableAmount: row.remainingAvailableAmount,
          };
          advanceAbsorptionByCanonicalId.set(canonicalAdvanceRecordId, allocation);
          advanceAbsorptionRows.push(allocation);
          absorbedAdvanceTotal += absorbedAmount;
        }
        if (Math.abs(absorbedAdvanceTotal - settlementTotals.advanceAdjustedNow) > 0.005) {
          request.log.error({
            workspaceId,
            farmId,
            seasonId,
            settlementClientRecordId,
            settlementNumber,
            expectedAdvanceAdjustedNow: settlementTotals.advanceAdjustedNow,
            preparedAdvanceAbsorptionTotal: absorbedAdvanceTotal,
          }, "labour wage settlement advance absorption total drift detected before allocation insert");
          throw new Error("The advance balance changed after preview. Please preview again.");
        }
        const advanceAllocationRecordIds = [...new Set(advanceAbsorptionRows.map((row) => row.advanceRecordId))];
        const existingAdvanceRows = advanceAllocationRecordIds.length ? await tx.select({
          id: operationalRecords.id,
          clientRecordId: operationalRecords.clientRecordId,
          workspaceId: operationalRecords.workspaceId,
          farmId: operationalRecords.farmId,
          seasonId: operationalRecords.seasonId,
        }).from(operationalRecords).where(and(
          eq(operationalRecords.workspaceId, workspaceId),
          eq(operationalRecords.entityType, "advance"),
          inArray(operationalRecords.id, advanceAllocationRecordIds),
        )) : [];
        const existingAdvanceById = new Map(existingAdvanceRows.map((row) => [row.id, row] as const));
        const missingAdvanceRecordIds = advanceAllocationRecordIds.filter((advanceRecordId) => {
          const row = existingAdvanceById.get(advanceRecordId);
          if (!row) return true;
          return !sameLegacyAdvanceScope({ farmId: row.farmId, seasonId: row.seasonId }, { farmId, seasonId });
        });
        if (missingAdvanceRecordIds.length) {
          request.log.error({
            workspaceId,
            farmId,
            seasonId,
            settlementClientRecordId,
            settlementNumber,
            missingAdvanceRecordIds,
          }, "labour wage settlement advance lookup failed before allocation insert");
          throw new Error("One or more advance records are no longer available. Please preview again.");
        }
        const settlementPayload = {
          id: settlementClientRecordId,
          clientRequestId: effectiveClientRequestId,
          settlementNumber,
        linkedVoucherId: "",
        linkedVoucherNumber: settlementNumber,
        linkedAccountId: paymentAccountIdValue ?? "",
        linkedAccountName: account?.name ?? resolvedAccount?.name ?? "",
        paymentAccountId: paymentAccountIdValue,
        paymentAccountCanonicalId: paymentAccountIdValue,
        paymentAccountLegacyId: resolvedAccount?.oldAndroidId ?? null,
        paymentAccountName: account?.name ?? resolvedAccount?.name ?? "",
        paymentAccountType: account?.accountType ?? resolvedAccount?.accountType ?? null,
        settlementMode: settlementMode ?? "individual",
          foremanId: preview.foremanId ?? resolvedSelection.foremanId ?? null,
          groupId: preview.groupId ?? resolvedSelection.groupId ?? null,
          groupName: preview.groupName ?? null,
          includedLabourIds: preview.includedLabourIds ?? [],
          includedInactiveLabourIds: preview.includedInactiveLabourIds ?? [],
          includedActiveLabourIds: preview.includedActiveLabourIds ?? [],
          includedLabourRows: preview.includedLabourRows ?? [],
          excludedLabourers: preview.excludedLabourers ?? [],
          attendanceTotals: preview.attendanceTotals ?? undefined,
          fromDate,
          toDate,
          settlementDate,
          attendanceWages: settlementTotals.attendanceWages,
          labourWorkWages: settlementTotals.labourWorkWages,
          pendingLabourEarnings: settlementTotals.pendingLabourEarnings,
          grossWages: settlementTotals.grossWages,
          totalEarned: settlementTotals.totalEarned,
          totalLabourCost: settlementTotals.grossWages,
          availableAdvanceBalanceBeforeSettlement: settlementTotals.availableAdvanceBalanceBeforeSettlement,
          advancesPaid: settlementTotals.advancesPaid,
          advancesAvailableUpToSettlementDate: settlementTotals.availableAdvanceBalanceBeforeSettlement,
          rawAdvancesUpToSettlementDate: preview.rawAdvancesUpToSettlementDate,
          previouslySettledAdvances: preview.previouslySettledAdvances,
          advanceAdjustedNow: settlementTotals.advanceAdjustedNow,
          settledAdvanceAmount: settlementTotals.advanceAdjustedNow,
          appliedAdvances: settlementTotals.advanceAdjustedNow,
          remainingAdvanceCarryForward: settlementTotals.remainingAdvanceCarryForward,
          carryForwardAdvance: settlementTotals.carryForwardAdvance,
          manualAdjustment: Number(manualAdjustment ?? 0),
          manualAdjustmentNote: manualAdjustment ? (manualAdjustmentNote ?? "") : null,
          netPayableBeforePayment: settlementTotals.netPayableBeforePayment,
          expenseAmount: settlementTotals.expenseAmount,
          paidAmount: settlementTotals.paidAmount,
          balanceAfterPayment: settlementTotals.balanceAfterPayment,
          payableBalance: settlementTotals.payableBalance,
          cashPayable: settlementTotals.payableBalance,
          notes: notes?.trim() || "",
          status: "posted" as const,
          createdBy: request.appUser!.id,
          createdAt: createdAt.toISOString(),
          updatedAt: createdAt.toISOString(),
          sourceAttendanceIds: preview.sourceAttendanceIds ?? [],
          sourceLabourWorkIds: preview.sourceLabourWorkIds ?? [],
          advanceAdjustmentAllocations: [],
          settlementScopeSnapshot: preview.settlementScopeSnapshot ?? {
            settlementMode: settlementMode ?? "individual",
            groupId: preview.groupId ?? resolvedSelection.groupId ?? null,
            groupName: preview.groupName ?? null,
            fromDate,
            toDate,
            includedLabourIds: preview.includedLabourIds ?? [],
            includedInactiveLabourIds: preview.includedInactiveLabourIds ?? [],
            attendanceWageTotal: preview.attendanceWages,
            attendanceCountTotals: preview.attendanceTotals ?? { labourers: 0, present: 0, halfDay: 0, absent: 0, payableDays: 0 },
            advanceAdjustedNow: settlementTotals.advanceAdjustedNow,
            netPayable: settlementTotals.netPayableBeforePayment,
            paymentAccountId: paymentAccountIdValue,
            paidNow: settlementTotals.paidAmount,
          },
        };
        request.log.info({
          workspaceId,
          farmId,
          seasonId,
          settlementClientRecordId,
          settlementNumber,
        }, "labour wage settlement record insert started");
        const [insertedSettlementRecord] = await tx.insert(operationalRecords).values([{
          workspaceId,
          farmId,
          seasonId,
          clientRecordId: settlementClientRecordId,
          entityType: "labourWageSettlement",
          payload: settlementPayload,
          recordedBy: request.appUser!.id,
          clientUpdatedAt: createdAt,
          createdAt,
          updatedAt: createdAt,
        }]).returning({
          operationalRecordId: operationalRecords.id,
          clientRecordId: operationalRecords.clientRecordId,
        });
        if (!insertedSettlementRecord?.operationalRecordId) {
          throw new Error("Settlement could not be created. No changes were saved.");
        }
        const settlementOperationalRecordId = insertedSettlementRecord.operationalRecordId;
        await updateCreateRequestState("settlement_inserted", {
          settlementOperationalRecordId,
          settlementClientRecordId,
          settlementNumber,
        });
        if (advanceAbsorptionRows.length) {
          const allocationsStartedAt = Date.now();
          for (const row of advanceAbsorptionRows) {
            try {
              await tx.insert(labourWageSettlementAdvanceAllocations).values({
                workspaceId,
                farmId,
                seasonId,
                settlementRecordId: settlementOperationalRecordId,
                advanceRecordId: row.advanceRecordId,
                absorbedAmount: row.absorbedAmount.toFixed(2),
              });
            } catch (error) {
              const dbError = toDatabaseErrorInfo(error);
              logSettlementAllocationInsertFailure(request, {
                workspaceId,
                farmId,
                seasonId,
                settlementId: settlementClientRecordId,
                settlementNumber,
                allocationIndex: row.allocationIndex,
                canonicalAdvanceRecordId: row.advanceRecordId,
                sourceAdvanceId: row.sourceAdvanceId,
                absorbedAmount: row.absorbedAmount,
                error: dbError,
              });
              throw new Error(settlementPostingErrorMessage(dbError));
            }
          }
          request.log.info({
            workspaceId,
            farmId,
            seasonId,
            settlementClientRecordId,
            settlementNumber,
            allocationRowCount: advanceAbsorptionRows.length,
            durationMs: Date.now() - allocationsStartedAt,
          }, "labour wage settlement allocation insert completed");
        }
        await updateCreateRequestState("allocations_inserted", {
          settlementOperationalRecordId,
          settlementClientRecordId,
          settlementNumber,
        });
        request.log.info({
          workspaceId,
          farmId,
          seasonId,
          settlementClientRecordId,
        }, "labour wage settlement record insert completed");
        const includedEarningIds = [...new Set(preview.includedEarnings.map((item) => item.id).filter(Boolean))];
        const earningsToSettle = includedEarningIds.length
          ? await tx.select({
            id: operationalRecords.id,
            clientRecordId: operationalRecords.clientRecordId,
            payload: operationalRecords.payload,
          }).from(operationalRecords).where(and(
            eq(operationalRecords.workspaceId, workspaceId),
            eq(operationalRecords.farmId, farmId),
            eq(operationalRecords.seasonId, seasonId),
            eq(operationalRecords.entityType, "labourEarning"),
            inArray(operationalRecords.clientRecordId, includedEarningIds),
          ))
          : [];
        request.log.info({
          workspaceId,
          farmId,
          seasonId,
          settlementClientRecordId,
          includedEarningCount: earningsToSettle.length,
        }, "labour wage settlement labour earning update started");
        const earningsStartedAt = Date.now();
        for (const earning of earningsToSettle) {
          const nextPayload = {
            ...normalizeLabourEarningPayload(earning.payload as Record<string, unknown>),
            status: "settled",
            linkedSettlementId: settlementClientRecordId,
            linkedVoucherId: null,
            settlementDate,
            updatedBy: request.appUser!.id,
            updatedAt: createdAt.toISOString(),
          };
          await tx.update(operationalRecords).set({
            payload: nextPayload,
            clientUpdatedAt: createdAt,
            updatedAt: createdAt,
          }).where(eq(operationalRecords.id, earning.id));
        }
        request.log.info({
          workspaceId,
          farmId,
          seasonId,
          settlementClientRecordId,
          includedEarningCount: earningsToSettle.length,
          durationMs: Date.now() - earningsStartedAt,
        }, "labour wage settlement labour earning update completed");
        await updateCreateRequestState("earnings_linked", {
          settlementOperationalRecordId,
          settlementClientRecordId,
          settlementNumber,
        });
        const includedAttendanceIds = [...new Set((preview.sourceAttendanceIds ?? []).filter(Boolean))];
        const attendanceRows = includedAttendanceIds.length ? await tx.select({
          id: operationalRecords.id,
          clientRecordId: operationalRecords.clientRecordId,
          payload: operationalRecords.payload,
        }).from(operationalRecords).where(and(
          eq(operationalRecords.workspaceId, workspaceId),
          eq(operationalRecords.farmId, farmId),
          eq(operationalRecords.seasonId, seasonId),
          eq(operationalRecords.entityType, "attendance"),
          inArray(operationalRecords.clientRecordId, includedAttendanceIds),
        )) : [];
        request.log.info({
          workspaceId,
          farmId,
          seasonId,
          settlementClientRecordId,
          includedAttendanceCount: attendanceRows.length,
        }, "labour wage settlement attendance update started");
        await updateCreateRequestState("linking_attendance", {
          settlementOperationalRecordId,
          settlementClientRecordId,
          settlementNumber,
        });
        const attendanceStartedAt = Date.now();
        for (const attendance of attendanceRows) {
          const nextPayload = {
            ...(attendance.payload as Record<string, unknown>),
            linkedSettlementId: settlementClientRecordId,
            settlementDate,
            updatedAt: createdAt.toISOString(),
          };
          await tx.update(operationalRecords).set({
            payload: nextPayload,
            clientUpdatedAt: createdAt,
            updatedAt: createdAt,
          }).where(eq(operationalRecords.id, attendance.id));
        }
        if (attendanceRows.length !== includedAttendanceIds.length) {
          request.log.error({
            workspaceId,
            farmId,
            seasonId,
            settlementClientRecordId,
            expectedIncludedAttendanceCount: includedAttendanceIds.length,
            linkedAttendanceCount: attendanceRows.length,
          }, "labour wage settlement attendance reconciliation failed before accounting");
          throw new Error("Settlement attendance reconciliation failed. No changes were saved.");
        }
        request.log.info({
          workspaceId,
          farmId,
          seasonId,
          settlementClientRecordId,
          includedAttendanceCount: attendanceRows.length,
          expectedIncludedAttendanceCount: includedAttendanceIds.length,
          durationMs: Date.now() - attendanceStartedAt,
        }, "labour wage settlement attendance update completed");
        await updateCreateRequestState("attendance_linked", {
          settlementOperationalRecordId,
          settlementClientRecordId,
          settlementNumber,
        });
        const settlementRecord = {
          id: settlementOperationalRecordId,
          clientRecordId: settlementClientRecordId,
          workspaceId,
          farmId,
          seasonId,
          clientUpdatedAt: createdAt,
          payload: settlementPayload,
        };
        request.log.info({
          workspaceId,
          farmId,
          seasonId,
          settlementClientRecordId,
        }, "labour wage settlement accounting repair started");
        await updateCreateRequestState("posting_accounting", {
          settlementOperationalRecordId,
          settlementClientRecordId,
          settlementNumber,
        });
        const accountingStartedAt = Date.now();
        await repairPostedSettlementAccounting(tx, settlementRecord, request.appUser!.id);
        request.log.info({
          workspaceId,
          farmId,
          seasonId,
          settlementClientRecordId,
          durationMs: Date.now() - accountingStartedAt,
        }, "labour wage settlement accounting repair completed");
        await updateCreateRequestState("accounting_posted", {
          settlementOperationalRecordId,
          settlementClientRecordId,
          settlementNumber,
        });
        request.log.info({
          workspaceId,
          farmId,
          seasonId,
          settlementClientRecordId,
          settlementNumber,
        }, "labour wage settlement transaction ready to commit");
        return {
          state: "SUCCESS" as const,
          settlementOperationalRecordId,
          settlementClientRecordId,
          settlementNumber,
          accountingStatus: "COMPLETE" as const,
          accountingMessage: null,
          settlement: { ...settlementPayload, id: settlementClientRecordId, accountingStatus: "posted" as const, accountingMessage: null },
        };
      });
      await updateCreateRequestState(result.state === "ALREADY_CREATED" ? "already_created" : "committed", {
        settlementOperationalRecordId: result.settlementOperationalRecordId,
        settlementClientRecordId: result.settlementClientRecordId,
        settlementNumber: result.settlementNumber,
        safeToRetry: false,
        completedAt: new Date(),
        message: result.state === "ALREADY_CREATED"
          ? `This settlement was already created as ${result.settlementNumber}.`
          : `Settlement ${result.settlementNumber} was created successfully.`,
      });
      request.log.info({
        workspaceId,
        farmId,
        seasonId,
        settlementId: result.settlement.id,
        settlementNumber: result.settlement.settlementNumber,
        durationMs: Date.now() - transactionStartedAt,
      }, "labour wage settlement create request completed");
      return reply.send({
        clientRequestId: effectiveClientRequestId,
        state: result.state,
        safeToRetry: false,
        settlementId: result.settlement.id,
        settlementNumber: result.settlement.settlementNumber,
        accountingStatus: result.accountingStatus,
        accountingMessage: result.accountingMessage,
        errorCode: null,
        message: result.state === "ALREADY_CREATED"
          ? `This settlement was already created as ${result.settlement.settlementNumber}.`
          : `Settlement ${result.settlement.settlementNumber} was created successfully.`,
        lifecycleErrorCode: null,
        lifecycleMessage: result.state === "ALREADY_CREATED"
          ? `This settlement was already created as ${result.settlement.settlementNumber}.`
          : `Settlement ${result.settlement.settlementNumber} was created successfully.`,
        stage: result.state === "ALREADY_CREATED" ? "already_created" : "committed",
        updatedAt: new Date().toISOString(),
        settlement: result.settlement,
      } satisfies SettlementCreateStatusResponse);
    } catch (error) {
      const dbError = toDatabaseErrorInfo(error);
      const failureCode = dbError ? settlementPostingErrorCode(dbError) : "SETTLEMENT_POSTING_FAILED";
      request.log.error({
        workspaceId,
        farmId,
        seasonId,
        clientRequestId: effectiveClientRequestId,
        requestId: request.id,
        errorCode: dbError?.code ?? null,
        errorConstraint: dbError?.constraint ?? null,
        errorTable: dbError?.table ?? null,
        errorColumn: dbError?.column ?? null,
        errorDetail: dbError?.detail ?? null,
        errorHint: dbError?.hint ?? null,
        errorSchema: dbError?.schema ?? null,
        errorPosition: dbError?.position ?? null,
        errorRoutine: dbError?.routine ?? null,
      }, "labour wage settlement create request rolled back");
      await updateCreateRequestState("rolled_back", {
        errorCode: failureCode,
        safeToRetry: true,
        message: failedSettlementCreateMessage,
        completedAt: new Date(),
      });
      if (dbError) {
        return reply.code(400).send({
          code: failureCode,
          message: failedSettlementCreateMessage,
          requestId: request.id,
        });
      }
      if (error instanceof Error) {
        return reply.code(400).send({
          code: failureCode,
          message: failedSettlementCreateMessage,
          requestId: request.id,
        });
      }
      throw error;
    }
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
    const params = settlementParamsSchema.safeParse(request.params);
    const parsed = updateSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ message: "A valid settlement update request is required." });
    const { workspaceId, settlementId } = params.data;
    if (request.appUser.workspaceId !== workspaceId) return reply.code(403).send({ message: "Select this workspace before updating labour settlements." });
    if (!hasModulePermission(request.appUser, workspaceId, "wages", "edit")) return reply.code(403).send({ message: "Workspace wage settlement edit permission is required." });

    const settlement = await db.transaction(async (tx) => loadSettlementRow(tx, workspaceId, settlementId));
    if (!settlement) return reply.code(404).send({ message: "Labour settlement not found." });
    if (!settlement.farmId || !settlement.seasonId) return reply.code(400).send({ message: "Labour settlement is missing farm or season context." });
    if (!hasFarmAccess(request.appUser, workspaceId, settlement.farmId)) return reply.code(403).send({ message: "You do not have access to this farm." });
    if (!(await validateContext(request.sessionId, workspaceId, settlement.farmId, settlement.seasonId))) {
      return reply.code(403).send({ message: "Select this farm and season before updating labour settlements." });
    }
    const ownershipError = await validateTenantReferences(workspaceId, { farmId: settlement.farmId, seasonId: settlement.seasonId });
    if (ownershipError) return reply.code(403).send({ message: ownershipError });

    const payload = normalizeSettlementPayload(settlement.payload as Record<string, unknown>);
    if (payload.status === "deleted") return reply.code(409).send({ message: "Deleted settlements cannot be updated." });
    if (payload.status === "voided") return reply.code(409).send({ message: "Voided settlements cannot be updated. Create a new settlement instead." });

    const nextFromDate = parsed.data.fromDate ?? payload.fromDate;
    const nextToDate = parsed.data.toDate ?? payload.toDate;
    const nextSettlementDate = parsed.data.settlementDate ?? payload.settlementDate;
    const nextAccountId = parsed.data.paymentAccountId ?? parsed.data.accountId ?? payload.paymentAccountId ?? payload.linkedAccountId;
    const nextNotes = parsed.data.notes === undefined ? payload.notes : (parsed.data.notes ?? "");
    const financialChanges = nextFromDate !== payload.fromDate
      || nextToDate !== payload.toDate
      || nextSettlementDate !== payload.settlementDate
      || nextAccountId !== (payload.paymentAccountId ?? payload.linkedAccountId);

    const transactionCount = await db.transaction((tx) => settlementAccountingTransactionCounts(tx, [settlementId])).then((result) => result.get(settlementId) ?? 0);
    const hasHealthyAccounting = transactionCount > 0 && settlementAccountingStatus(payload, transactionCount) === "posted";
    if (financialChanges && hasHealthyAccounting) {
      return reply.code(409).send({ message: "Posted accounting settlements must be voided/reversed before changing settlement dates or account." });
    }

    const updatedAt = new Date();
    const nextPayloadBase = {
      ...payload,
      fromDate: nextFromDate,
      toDate: nextToDate,
      settlementDate: nextSettlementDate,
      notes: nextNotes ?? "",
      updatedAt: updatedAt.toISOString(),
    };

    const result = await db.transaction(async (tx) => {
      let resolvedAccount = null;
      if (financialChanges) {
        resolvedAccount = await resolveCanonicalPaymentAccountId(tx, workspaceId, settlement.farmId!, nextAccountId);
        const accountValidation = validateLabourSettlementPaymentAccount(resolvedAccount, settlement.farmId!);
        if (!accountValidation.valid) throw new Error(accountValidation.message ?? "Payment account validation failed.");
        if (!resolvedAccount) throw new Error("Payment account is not mapped. Please repair imported accounts.");
        const storedSelection = selectionScopeFromSettlementPayload(payload);
        const preview = await previewLabourWageSettlement(
          tx,
          workspaceId,
          settlement.farmId!,
          settlement.seasonId!,
          nextFromDate,
          nextToDate,
          nextSettlementDate,
          settlement.clientRecordId,
          storedSelection,
        );
        if (preview.unresolvedRows.length) {
          throw new Error("Attendance wages cannot be settled until missing wage rates are fixed.");
        }
        const overlaps = preview.overlappingSettlements.filter((item) => item.id !== settlement.clientRecordId);
        if (overlaps.length) {
          throw new Error("An active labour wage settlement already exists for an overlapping date range.");
        }
        const nextTotals = {
          attendanceWages: preview.attendanceWages,
          pendingLabourEarnings: preview.pendingLabourEarnings,
          totalEarned: preview.totalEarned,
          advancesPaid: preview.advancesPaid,
          settledAdvanceAmount: preview.settledAdvanceAmount,
          expenseAmount: preview.expenseAmount,
          carryForwardAdvance: preview.carryForwardAdvance,
          payableBalance: preview.payableBalance,
        };
        const nextPayload = {
          ...nextPayloadBase,
          linkedAccountId: resolvedAccount.id,
          linkedAccountName: resolvedAccount.name,
          attendanceWages: nextTotals.attendanceWages,
          pendingLabourEarnings: nextTotals.pendingLabourEarnings,
          labourWork: nextTotals.pendingLabourEarnings,
          totalEarned: nextTotals.totalEarned,
          totalLabourCost: nextTotals.totalEarned,
          advancesPaid: nextTotals.advancesPaid,
          advancesAvailableUpToSettlementDate: nextTotals.advancesPaid,
          settledAdvanceAmount: nextTotals.settledAdvanceAmount,
          appliedAdvances: nextTotals.settledAdvanceAmount,
          expenseAmount: nextTotals.expenseAmount,
          carryForwardAdvance: nextTotals.carryForwardAdvance,
          payableBalance: nextTotals.payableBalance,
          cashPayable: nextTotals.payableBalance,
        };
        await tx.update(operationalRecords).set({
          payload: nextPayload,
          clientUpdatedAt: updatedAt,
          updatedAt,
          recordedBy: request.appUser!.id,
        }).where(eq(operationalRecords.id, settlement.id));
        const earningsToSettle = await listLabourEarnings(tx, workspaceId, settlement.farmId!, settlement.seasonId!);
        const includedEarningIds = new Set(preview.includedEarnings.map((item) => item.id));
        for (const earning of earningsToSettle) {
          if (!includedEarningIds.has(earning.clientRecordId)) continue;
          const nextEarningPayload = {
            ...normalizeLabourEarningPayload(earning.payload as Record<string, unknown>),
            status: "settled",
            linkedSettlementId: settlement.clientRecordId,
            settlementDate: nextSettlementDate,
            updatedBy: request.appUser!.id,
            updatedAt: updatedAt.toISOString(),
          };
          await tx.update(operationalRecords).set({
            payload: nextEarningPayload,
            clientUpdatedAt: updatedAt,
            updatedAt,
          }).where(eq(operationalRecords.id, earning.id));
        }
        await tx.insert(auditLogs).values({
          workspaceId,
          userId: request.appUser!.id,
          farmId: settlement.farmId,
          action: "labour_wage_settlement_updated",
          entityType: "labourWageSettlement",
          entityId: settlement.id,
          details: { before: payload, after: nextPayload, financialChanges: true },
        });
        return {
          settlementId,
          settlementNumber: payload.settlementNumber,
          accountingEntries: transactionCount,
          settlement: {
            ...nextPayload,
            id: settlement.clientRecordId,
            workspaceId,
            farmId: settlement.farmId,
            seasonId: settlement.seasonId,
            accountingStatus: "posted" as const,
            accountingMessage: null,
            updatedAt: updatedAt.toISOString(),
          },
        };
      }

      const nextPayload = {
        ...nextPayloadBase,
        ...(parsed.data.notes !== undefined ? { notes: nextNotes ?? "" } : {}),
      };
      await tx.update(operationalRecords).set({
        payload: nextPayload,
        clientUpdatedAt: updatedAt,
        updatedAt,
        recordedBy: request.appUser!.id,
      }).where(eq(operationalRecords.id, settlement.id));
      await tx.insert(auditLogs).values({
        workspaceId,
        userId: request.appUser!.id,
        farmId: settlement.farmId,
        action: "labour_wage_settlement_updated",
        entityType: "labourWageSettlement",
        entityId: settlement.id,
        details: { before: payload, after: nextPayload, financialChanges: false },
      });
      return {
        settlementId,
        settlementNumber: payload.settlementNumber,
        accountingEntries: transactionCount,
        settlement: {
          ...nextPayload,
          id: settlement.clientRecordId,
          workspaceId,
          farmId: settlement.farmId,
          seasonId: settlement.seasonId,
          accountingStatus: settlementAccountingStatus(payload, transactionCount),
          accountingMessage: null,
          updatedAt: updatedAt.toISOString(),
        },
      };
    });

    return result;
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
    if (transactionCount === 0) {
      return reply.code(409).send({ message: "This settlement has no accounting entries to reverse. Delete the settlement instead." });
    }

    const voidedAt = new Date();
    const voidedIso = voidedAt.toISOString();
    const voidReason = parsed.data.voidReason?.trim() || "Voided settlement";
    const result = await db.transaction(async (tx) => {
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
