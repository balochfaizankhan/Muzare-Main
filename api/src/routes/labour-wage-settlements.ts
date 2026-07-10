import type { FastifyInstance } from "fastify";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { db } from "../db/client.js";
import { accountTransactions, auditLogs, labourWageSettlementAdvanceAllocations, operationalRecords, userSessions } from "../db/schema.js";
import { listLabourEarnings, normalizeLabourEarningPayload } from "../lib/labour-earnings.js";
import { isDeletedOperationalPayload } from "../operational-record-state.js";
import { hasFarmAccess } from "../workspace-access.js";
import { hasModulePermission } from "../permissions.js";
import { validateTenantReferences } from "../tenant-ownership.js";
import {
  allocateSettlementNumber,
  calculateLabourWageSettlementTotals,
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
  foremanId: z.string().uuid().optional().nullable(),
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

async function validateContext(sessionId: string | undefined, workspaceId: string, farmId: string, seasonId: string) {
  const [session] = await db.select({
    activeFarmId: userSessions.activeFarmId,
    activeSeasonId: userSessions.activeSeasonId,
  }).from(userSessions).where(and(eq(userSessions.id, sessionId ?? ""), eq(userSessions.workspaceId, workspaceId))).limit(1);
  return session?.activeFarmId === farmId && session.activeSeasonId === seasonId;
}

async function loadSettlementRow(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], workspaceId: string, settlementId: string) {
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
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
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

async function isSettlementRequestProcessing(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
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

function logSettlementAccountValidation(request: { log: { info: (...args: unknown[]) => void } }, details: Record<string, unknown>) {
  if (process.env.NODE_ENV !== "production") {
    request.log.info({ ...details, context: "labour_settlement_payment_account_validation" }, "labour settlement payment account validation");
  }
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
        return {
          created: true,
          processing: false,
          notFound: false,
          failed: false,
          safeToRetry: false,
          settlement: {
            ...normalizeSettlementPayload(existingSettlement.payload as Record<string, unknown>),
            id: existingSettlement.clientRecordId,
            accountingStatus: "posted" as const,
            accountingMessage: null,
          },
        };
      }
      const processing = await isSettlementRequestProcessing(tx, workspaceId, farmId, clientRequestId);
      return {
        created: false,
        processing,
        notFound: !processing,
        failed: false,
        safeToRetry: !processing,
        settlement: null,
      };
    });

    request.log.info({
      workspaceId,
      farmId,
      seasonId,
      clientRequestId,
      created: status.created,
      processing: status.processing,
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
    if (request.appUser.workspaceId !== workspaceId) return reply.code(403).send({ message: "Select this workspace before previewing labour settlements." });
    if (!hasModulePermission(request.appUser, workspaceId, "wages", "view")) return reply.code(403).send({ message: "Workspace wage settlement view permission is required." });
    if (!hasFarmAccess(request.appUser, workspaceId, farmId)) return reply.code(403).send({ message: "You do not have access to this farm." });
    if (!(await validateContext(request.sessionId, workspaceId, farmId, seasonId))) {
      return reply.code(403).send({ message: "Select this farm and season before previewing labour settlements." });
    }
    const ownershipError = await validateTenantReferences(workspaceId, { farmId, seasonId });
    if (ownershipError) return reply.code(403).send({ message: ownershipError });
    const preview = await db.transaction((tx) => previewLabourWageSettlement(tx, workspaceId, farmId, seasonId, fromDate, toDate, settlementDate, undefined, {
      settlementMode,
      labourerId,
      foremanId,
      groupId,
      labourIds,
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
      clientRequestId: clientRequestId ?? null,
    }, "labour wage settlement create request received");

    const existingSettlement = clientRequestId
      ? await db.transaction((tx) => findSettlementByClientRequestId(tx, workspaceId, farmId, seasonId, clientRequestId))
      : null;
    if (existingSettlement) {
      request.log.info({
        workspaceId,
        farmId,
        seasonId,
        settlementId: existingSettlement.clientRecordId,
        clientRequestId,
      }, "labour wage settlement create request matched existing settlement");
      return settlementResponseFromRow({
        clientRecordId: existingSettlement.clientRecordId,
        payload: existingSettlement.payload as Record<string, unknown>,
      });
    }

    const previewStartedAt = Date.now();
    const preview = await db.transaction((tx) => previewLabourWageSettlement(tx, workspaceId, farmId, seasonId, fromDate, toDate, settlementDate, undefined, {
      settlementMode,
      labourerId,
      foremanId,
      groupId,
      labourIds,
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
    if (preview.unresolvedRows.length) {
      return reply.code(409).send({
        message: "Attendance wages cannot be settled until missing wage rates are fixed.",
        details: { code: "missing_wage_rates", unresolvedRows: preview.unresolvedRows },
      });
    }
    if (preview.overlappingSettlements.length) {
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
      request.log.info({
        workspaceId,
        farmId,
        seasonId,
        clientRequestId: clientRequestId ?? null,
      }, "labour wage settlement transaction started");
      const result = await db.transaction(async (tx) => {
        if (clientRequestId) {
          const requestScopeKey = `${workspaceId}:${farmId}:labour-wage-settlement:${clientRequestId}`;
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${requestScopeKey}), 1)`);
          const existingByRequest = await findSettlementByClientRequestId(tx, workspaceId, farmId, seasonId, clientRequestId);
          if (existingByRequest) {
            request.log.info({
              workspaceId,
              farmId,
              seasonId,
              settlementId: existingByRequest.clientRecordId,
              clientRequestId,
            }, "labour wage settlement duplicate request reused existing settlement inside transaction");
            return settlementResponseFromRow({
              clientRecordId: existingByRequest.clientRecordId,
              payload: existingByRequest.payload as Record<string, unknown>,
            });
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
        const settlementId = crypto.randomUUID();
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
        const advanceAbsorptionRows = preview.advanceReconciliation
          ?.filter((row) => row.includedInPreview && row.remainingAvailableAmount > 0 && row.advanceId)
          .reduce<Array<{ advanceRecordId: string; absorbedAmount: number }>>((rows, row) => {
            const remainingTarget = Math.max(0, settlementTotals.advanceAdjustedNow - rows.reduce((sum, item) => sum + item.absorbedAmount, 0));
            if (remainingTarget <= 0) return rows;
            const absorbedAmount = Math.min(remainingTarget, row.remainingAvailableAmount);
            if (absorbedAmount <= 0) return rows;
            rows.push({ advanceRecordId: row.advanceId, absorbedAmount });
            return rows;
          }, []) ?? [];
        const settlementPayload = {
          id: settlementId,
          clientRequestId: clientRequestId ?? null,
          settlementNumber,
          linkedVoucherId: "",
          linkedVoucherNumber: settlementNumber,
          linkedAccountId: paymentAccountIdValue ?? "",
          linkedAccountName: account?.name ?? resolvedAccount?.name ?? "",
          paymentAccountId: paymentAccountIdValue,
          settlementMode: settlementMode ?? "individual",
          foremanId: preview.foremanId ?? foremanId ?? null,
          groupId: preview.groupId ?? groupId ?? null,
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
            groupId: preview.groupId ?? groupId ?? null,
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
          settlementId,
          settlementNumber,
        }, "labour wage settlement record insert started");
        await tx.insert(operationalRecords).values([{
          workspaceId,
          farmId,
          seasonId,
          clientRecordId: settlementId,
          entityType: "labourWageSettlement",
          payload: settlementPayload,
          recordedBy: request.appUser!.id,
          clientUpdatedAt: createdAt,
          createdAt,
          updatedAt: createdAt,
        }]);
        if (advanceAbsorptionRows.length) {
          await tx.insert(labourWageSettlementAdvanceAllocations).values(advanceAbsorptionRows.map((row) => ({
            workspaceId,
            farmId,
            seasonId,
            settlementRecordId: settlementId,
            advanceRecordId: row.advanceRecordId,
            absorbedAmount: row.absorbedAmount.toFixed(2),
          })));
        }
        request.log.info({
          workspaceId,
          farmId,
          seasonId,
          settlementId,
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
          settlementId,
          includedEarningCount: earningsToSettle.length,
        }, "labour wage settlement labour earning update started");
        for (const earning of earningsToSettle) {
          const nextPayload = {
            ...normalizeLabourEarningPayload(earning.payload as Record<string, unknown>),
            status: "settled",
            linkedSettlementId: settlementId,
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
          settlementId,
          includedEarningCount: earningsToSettle.length,
        }, "labour wage settlement labour earning update completed");
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
          settlementId,
          includedAttendanceCount: attendanceRows.length,
        }, "labour wage settlement attendance update started");
        for (const attendance of attendanceRows) {
          const nextPayload = {
            ...(attendance.payload as Record<string, unknown>),
            linkedSettlementId: settlementId,
            settlementDate,
            updatedAt: createdAt.toISOString(),
          };
          await tx.update(operationalRecords).set({
            payload: nextPayload,
            clientUpdatedAt: createdAt,
            updatedAt: createdAt,
          }).where(eq(operationalRecords.id, attendance.id));
        }
        request.log.info({
          workspaceId,
          farmId,
          seasonId,
          settlementId,
          includedAttendanceCount: attendanceRows.length,
        }, "labour wage settlement attendance update completed");
        const settlementRecord = {
          id: settlementId,
          clientRecordId: settlementId,
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
          settlementId,
        }, "labour wage settlement accounting repair started");
        await repairPostedSettlementAccounting(tx, settlementRecord, request.appUser!.id);
        request.log.info({
          workspaceId,
          farmId,
          seasonId,
          settlementId,
        }, "labour wage settlement accounting repair completed");
        request.log.info({
          workspaceId,
          farmId,
          seasonId,
          settlementId,
          settlementNumber,
        }, "labour wage settlement transaction ready to commit");
        return {
          settlement: { ...settlementPayload, id: settlementId, accountingStatus: "posted" as const, accountingMessage: null },
        };
      });
      request.log.info({
        workspaceId,
        farmId,
        seasonId,
        settlementId: result.settlement.id,
        settlementNumber: result.settlement.settlementNumber,
        durationMs: Date.now() - transactionStartedAt,
      }, "labour wage settlement create request completed");
      return result;
    } catch (error) {
      request.log.error({
        workspaceId,
        farmId,
        seasonId,
        clientRequestId: clientRequestId ?? null,
        error,
      }, "labour wage settlement create request rolled back");
      if (error instanceof Error) {
        return reply.code(400).send({ message: error.message });
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
        const preview = await previewLabourWageSettlement(tx, workspaceId, settlement.farmId!, settlement.seasonId!, nextFromDate, nextToDate, nextSettlementDate, settlement.clientRecordId);
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
