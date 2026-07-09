import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { db } from "../db/client.js";
import { accountTransactions, auditLogs, operationalRecords, userSessions } from "../db/schema.js";
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
const createSchema = baseSchema.extend({
  ...settlementSelectionSchema.shape,
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

function logSettlementAccountValidation(request: { log: { info: (...args: unknown[]) => void } }, details: Record<string, unknown>) {
  if (process.env.NODE_ENV !== "production") {
    request.log.info({ ...details, context: "labour_settlement_payment_account_validation" }, "labour settlement payment account validation");
  }
}

export async function labourWageSettlementRoutes(app: FastifyInstance): Promise<void> {
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
      return reply.code(400).send({ message: "A valid labour settlement preview request is required." });
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
    const updated = calculateLabourWageSettlementTotals(
      preview.attendanceWages,
      preview.labourWorkWages ?? preview.pendingLabourEarnings,
      preview.availableAdvanceBalanceBeforeSettlement ?? preview.advancesAvailableUpToSettlementDate ?? 0,
      Number(paidAmount ?? 0),
      Number(manualAdjustment ?? 0),
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
      return reply.code(400).send({ message: "A valid labour settlement payload is required." });
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

    const preview = await db.transaction((tx) => previewLabourWageSettlement(tx, workspaceId, farmId, seasonId, fromDate, toDate, settlementDate, undefined, {
      settlementMode,
      labourerId,
      foremanId,
      groupId,
      labourIds,
    }));
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
      const result = await db.transaction(async (tx) => {
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
        const settlementTotals = calculateLabourWageSettlementTotals(
          preview.attendanceWages,
          preview.labourWorkWages ?? preview.pendingLabourEarnings,
          preview.availableAdvanceBalanceBeforeSettlement ?? preview.advancesAvailableUpToSettlementDate ?? 0,
          effectivePaidAmount,
          Number(manualAdjustment ?? 0),
        );
        const description = `Labour wage settlement: ${fromDate} to ${toDate} (attendance wages + labour work)`;
        const paymentAccountIdValue = effectivePaidAmount > 0 ? account?.id ?? resolvedAccount?.id ?? paymentAccountInput : null;
        const settlementPayload = {
          id: settlementId,
          settlementNumber,
          linkedVoucherId: "",
          linkedVoucherNumber: settlementNumber,
          linkedAccountId: paymentAccountIdValue ?? "",
          linkedAccountName: account?.name ?? resolvedAccount?.name ?? "",
          paymentAccountId: paymentAccountIdValue,
          settlementMode: settlementMode ?? "individual",
          foremanId: foremanId ?? null,
          groupId: groupId ?? null,
          includedLabourIds: preview.includedLabourIds ?? [],
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
          advanceAdjustedNow: preview.advanceAdjustedNow,
          settledAdvanceAmount: preview.advanceAdjustedNow,
          appliedAdvances: preview.advanceAdjustedNow,
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
          advanceAdjustmentAllocations: preview.advanceAdjustmentAllocations ?? [],
        };
        const earningsToSettle = await listLabourEarnings(tx, workspaceId, farmId, seasonId);
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
        const includedEarningIds = new Set(preview.includedEarnings.map((item) => item.id));
        for (const earning of earningsToSettle) {
          if (!includedEarningIds.has(earning.clientRecordId)) continue;
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
        const attendanceRows = await tx.select({
          id: operationalRecords.id,
          clientRecordId: operationalRecords.clientRecordId,
          payload: operationalRecords.payload,
        }).from(operationalRecords).where(and(
          eq(operationalRecords.workspaceId, workspaceId),
          eq(operationalRecords.farmId, farmId),
          eq(operationalRecords.seasonId, seasonId),
          eq(operationalRecords.entityType, "attendance"),
        ));
        const includedAttendanceIds = new Set(preview.sourceAttendanceIds ?? []);
        for (const attendance of attendanceRows) {
          if (!includedAttendanceIds.has(attendance.clientRecordId)) continue;
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
        const settlementRecord = {
          id: settlementId,
          clientRecordId: settlementId,
          workspaceId,
          farmId,
          seasonId,
          clientUpdatedAt: createdAt,
          payload: settlementPayload,
        };
        await repairPostedSettlementAccounting(tx, settlementRecord, request.appUser!.id);
        return {
          settlement: { ...settlementPayload, id: settlementId, accountingStatus: "posted" as const, accountingMessage: null },
        };
      });
      return result;
    } catch (error) {
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
