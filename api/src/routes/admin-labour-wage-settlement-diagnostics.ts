import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireUser, type AuthenticatedUser } from "../auth.js";
import { db } from "../db/client.js";
import { accountTransactions, accounts, farms, labourWageSettlementAdvanceAllocations, labourWageSettlementCreateRequests, operationalRecords } from "../db/schema.js";
import { normalizeSettlementPayload } from "../lib/labour-wage-settlements.js";
import { buildLabourWageSettlementDiagnostics, normalizeDiagnosticsScopeId, resolveLabourWageSettlementDiagnosticsFarmId } from "../lib/labour-wage-settlement-diagnostics.js";
import { isDeletedOperationalPayload } from "../operational-record-state.js";

const paramsSchema = z.object({ workspaceId: z.string().uuid() });
const querySchema = z.object({
  settlementNumber: z.string().trim().min(1).optional(),
  settlementId: z.string().uuid().optional(),
  clientRequestId: z.string().uuid().optional(),
  farmId: z.string().uuid().optional(),
}).refine((value) => Boolean(value.settlementNumber || value.settlementId || value.clientRequestId), {
  message: "At least one lookup parameter is required.",
});

function readLegacyFarmId(payload: Record<string, unknown> | null | undefined) {
  const raw = payload?.farmId;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function isUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && z.string().uuid().safeParse(value).success;
}

export function canAccessDiagnostics(user: AuthenticatedUser, workspaceId: string) {
  if (user.platformRole === "platform_admin") return true;
  if (user.workspaceId !== workspaceId) return false;
  const membership = user.memberships.find((item) => item.workspaceId === workspaceId && item.active);
  return membership?.role === "workspace_owner";
}

export async function adminLabourWageSettlementDiagnosticsRoutes(app: FastifyInstance): Promise<void> {
  // Internal support tooling only; keep owner/admin protected and out of the production PWA.
  app.get("/v1/workspace/:workspaceId/admin/labour-wage-settlements/diagnostics", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply.code(401).send({ message: "Authentication token is required." });

    const params = paramsSchema.safeParse(request.params);
    const query = querySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ message: "A valid labour wage settlement diagnostics request is required." });
    }

    const { workspaceId } = params.data;
    const { settlementNumber, settlementId, clientRequestId } = query.data;
    if (!canAccessDiagnostics(request.appUser, workspaceId)) {
      return reply.code(403).send({ message: "Workspace owner or platform admin access is required." });
    }

    const [settlementRows, accountRows, operationalAccountRows] = await Promise.all([
      db.select({
        id: operationalRecords.id,
        clientRecordId: operationalRecords.clientRecordId,
        farmId: operationalRecords.farmId,
        seasonId: operationalRecords.seasonId,
        createdAt: operationalRecords.createdAt,
        updatedAt: operationalRecords.updatedAt,
        clientUpdatedAt: operationalRecords.clientUpdatedAt,
        payload: operationalRecords.payload,
      }).from(operationalRecords).where(and(
        eq(operationalRecords.workspaceId, workspaceId),
        eq(operationalRecords.entityType, "labourWageSettlement"),
        ...(settlementId ? [eq(operationalRecords.clientRecordId, settlementId)] : []),
        ...(settlementNumber ? [sql`${operationalRecords.payload}->>'settlementNumber' = ${settlementNumber}`] : []),
        ...(clientRequestId ? [sql`${operationalRecords.payload}->>'clientRequestId' = ${clientRequestId}`] : []),
      )).limit(2),
      db.select({
        id: accounts.id,
        name: accounts.name,
        oldAndroidId: accounts.oldAndroidId,
        sourceType: accounts.sourceType,
        accountType: accounts.accountType,
        active: accounts.active,
      }).from(accounts).innerJoin(farms, eq(farms.id, accounts.farmId)).where(eq(farms.workspaceId, workspaceId)),
      db.select({
        id: operationalRecords.id,
        clientRecordId: operationalRecords.clientRecordId,
        farmId: operationalRecords.farmId,
        createdAt: operationalRecords.createdAt,
        updatedAt: operationalRecords.updatedAt,
        payload: operationalRecords.payload,
      }).from(operationalRecords).where(and(
        eq(operationalRecords.workspaceId, workspaceId),
        eq(operationalRecords.entityType, "account"),
      )),
    ]);

    const settlementRow = settlementRows[0] ?? null;
    const settlementPayload = settlementRow ? normalizeSettlementPayload(settlementRow.payload as Record<string, unknown>) : null;

    const lifecycleRows = await db.select({
      clientRequestId: labourWageSettlementCreateRequests.clientRequestId,
      farmId: labourWageSettlementCreateRequests.farmId,
      state: labourWageSettlementCreateRequests.state,
      stage: labourWageSettlementCreateRequests.stage,
      errorCode: labourWageSettlementCreateRequests.errorCode,
      message: labourWageSettlementCreateRequests.message,
      safeToRetry: labourWageSettlementCreateRequests.safeToRetry,
      createdAt: labourWageSettlementCreateRequests.createdAt,
      updatedAt: labourWageSettlementCreateRequests.updatedAt,
      completedAt: labourWageSettlementCreateRequests.completedAt,
    }).from(labourWageSettlementCreateRequests).where(and(
      eq(labourWageSettlementCreateRequests.workspaceId, workspaceId),
      eq(labourWageSettlementCreateRequests.operationType, "labour_wage_settlement_create"),
      ...(clientRequestId ? [eq(labourWageSettlementCreateRequests.clientRequestId, clientRequestId)] : []),
      ...(settlementRow ? [eq(labourWageSettlementCreateRequests.settlementClientRecordId, settlementRow.clientRecordId)] : []),
      ...(settlementNumber ? [eq(labourWageSettlementCreateRequests.settlementNumber, settlementNumber)] : []),
    )).orderBy(labourWageSettlementCreateRequests.updatedAt);
    const lifecycleRow = lifecycleRows[lifecycleRows.length - 1] ?? null;

    const resolvedFarmId = resolveLabourWageSettlementDiagnosticsFarmId({
      settlementFarmId: normalizeDiagnosticsScopeId(settlementRow?.farmId),
      lifecycleFarmId: normalizeDiagnosticsScopeId(lifecycleRow?.farmId),
      requestFarmId: normalizeDiagnosticsScopeId(query.data.farmId ?? null),
      legacyPayloadFarmId: normalizeDiagnosticsScopeId(readLegacyFarmId(settlementRow?.payload as Record<string, unknown> | null)),
    });
    if (!isUuid(resolvedFarmId)) {
      return reply.code(422).send({
        code: "SETTLEMENT_DIAGNOSTICS_FARM_SCOPE_MISSING",
        message: "The settlement farm context could not be resolved for accounting diagnostics.",
        readOnly: true,
      });
    }

    const settlementClientRecordId = settlementRow?.clientRecordId ?? lifecycleRow?.clientRequestId ?? null;
    const allocationRows = settlementRow ? await db.select({
      advanceRecordId: labourWageSettlementAdvanceAllocations.advanceRecordId,
      absorbedAmount: labourWageSettlementAdvanceAllocations.absorbedAmount,
    }).from(labourWageSettlementAdvanceAllocations).where(eq(labourWageSettlementAdvanceAllocations.settlementRecordId, settlementRow.id)) : [];
    const attendanceRows = settlementClientRecordId ? await db.select({
      id: operationalRecords.id,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.entityType, "attendance"),
      sql`${operationalRecords.payload}->>'linkedSettlementId' = ${settlementClientRecordId}`,
    )) : [];
    const labourEarningRows = settlementClientRecordId ? await db.select({
      id: operationalRecords.id,
      payload: operationalRecords.payload,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.entityType, "labourEarning"),
      sql`${operationalRecords.payload}->>'linkedSettlementId' = ${settlementClientRecordId}`,
    )) : [];
    const settlementAccountingEntries = settlementClientRecordId ? await db.select({
      referenceId: accountTransactions.referenceId,
      accountId: accountTransactions.accountId,
      source: accountTransactions.source,
      sourceType: accountTransactions.sourceType,
      type: accountTransactions.type,
    }).from(accountTransactions).where(and(
      eq(accountTransactions.farmId, resolvedFarmId),
      eq(accountTransactions.referenceId, settlementClientRecordId),
      eq(accountTransactions.source, "settlement"),
      eq(accountTransactions.sourceType, "labour_wage_settlement"),
    )) : [];

    return buildLabourWageSettlementDiagnostics({
      lookup: {
        workspaceId,
        settlementNumber,
        settlementId,
        clientRequestId,
        farmId: resolvedFarmId,
      },
      settlementRecord: settlementRow ? {
        id: settlementRow.id,
        clientRecordId: settlementRow.clientRecordId,
        farmId: settlementRow.farmId,
        seasonId: settlementRow.seasonId,
        createdAt: settlementRow.createdAt,
        updatedAt: settlementRow.updatedAt,
        clientUpdatedAt: settlementRow.clientUpdatedAt,
        payload: settlementRow.payload as Record<string, unknown>,
      } : null,
      lifecycleRecord: lifecycleRow ? {
        clientRequestId: lifecycleRow.clientRequestId,
        state: lifecycleRow.state,
        stage: lifecycleRow.stage,
        errorCode: lifecycleRow.errorCode,
        message: lifecycleRow.message,
        safeToRetry: lifecycleRow.safeToRetry,
        createdAt: lifecycleRow.createdAt,
        updatedAt: lifecycleRow.updatedAt,
        completedAt: lifecycleRow.completedAt,
      } : null,
      paymentAccounts: accountRows,
      operationalAccountRecords: operationalAccountRows
        .map((row) => ({
          id: row.id,
          clientRecordId: row.clientRecordId,
          farmId: row.farmId,
          payload: row.payload as Record<string, unknown>,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }))
        .filter((row) => !isDeletedOperationalPayload(row.payload)),
      accountTransactions: settlementAccountingEntries,
      allocations: allocationRows,
      attendanceLinks: attendanceRows,
      labourEarnings: labourEarningRows,
    });
  });
}
