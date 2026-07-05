import type { FastifyInstance } from "fastify";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { db } from "../db/client.js";
import { expenseCategories, expenseSubcategories, operationalRecords, userSessions } from "../db/schema.js";
import { listLabourEarnings, normalizeLabourEarningPayload } from "../lib/labour-earnings.js";
import { isDeletedOperationalPayload } from "../operational-record-state.js";
import { hasFarmAccess } from "../workspace-access.js";
import { hasModulePermission } from "../permissions.js";
import { validateTenantReferences, validateTenantReferencesDetailed } from "../tenant-ownership.js";
import {
  allocateSettlementNumber,
  listLabourWageSettlements,
  previewLabourWageSettlement,
  settlementRangesOverlap,
} from "../lib/labour-wage-settlements.js";
import { resolveExpenseCategory } from "./expense-categories.js";

const paramsSchema = z.object({ workspaceId: z.string().uuid() });
const baseSchema = z.object({
  farmId: z.string().uuid(),
  seasonId: z.string().uuid(),
  fromDate: z.string().date(),
  toDate: z.string().date(),
  settlementDate: z.string().date(),
});
const previewSchema = baseSchema;
const createSchema = baseSchema.extend({
  accountId: z.string().min(1),
  notes: z.string().trim().max(500).optional(),
});

async function validateContext(sessionId: string | undefined, workspaceId: string, farmId: string, seasonId: string) {
  const [session] = await db.select({
    activeFarmId: userSessions.activeFarmId,
    activeSeasonId: userSessions.activeSeasonId,
  }).from(userSessions).where(and(eq(userSessions.id, sessionId ?? ""), eq(userSessions.workspaceId, workspaceId))).limit(1);
  return session?.activeFarmId === farmId && session.activeSeasonId === seasonId;
}

async function resolveSettlementCategory(workspaceId: string) {
  const [wages] = await db.select({
    categoryId: expenseCategories.id,
    category: expenseCategories.name,
    subcategoryId: expenseSubcategories.id,
    subcategory: expenseSubcategories.name,
  }).from(expenseSubcategories)
    .innerJoin(expenseCategories, eq(expenseCategories.id, expenseSubcategories.categoryId))
    .where(and(
      isNull(expenseCategories.workspaceId),
      eq(expenseCategories.active, true),
      eq(expenseCategories.name, "Labour Related"),
      isNull(expenseSubcategories.workspaceId),
      eq(expenseSubcategories.active, true),
      eq(expenseSubcategories.name, "Wages"),
    ))
    .orderBy(asc(expenseSubcategories.sortOrder))
    .limit(1);
  return wages ?? await resolveExpenseCategory(workspaceId);
}

export async function labourWageSettlementRoutes(app: FastifyInstance): Promise<void> {
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
      const rows = settlements.map((row) => ({
        id: row.clientRecordId,
        ...row.payload,
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
        settlementsWithoutLinkedVoucher: rows.filter((row) => !row.linkedVoucherId).length,
        linkedVoucherReferenceMismatches: rows.filter((row) => {
          const linked = voucherById.get(row.linkedVoucherId);
          return row.linkedVoucherId && (!linked || linked.settlementId !== row.id);
        }).length,
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

  app.post("/v1/workspace/:workspaceId/labour-wage-settlements/preview", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser || !request.sessionId) return reply.code(401).send({ message: "A valid session is required." });
    const params = paramsSchema.safeParse(request.params);
    const parsed = previewSchema.safeParse(request.body);
    if (!params.success || !parsed.success || parsed.data.fromDate > parsed.data.toDate) {
      return reply.code(400).send({ message: "A valid labour settlement preview request is required." });
    }
    const { workspaceId } = params.data;
    const { farmId, seasonId, fromDate, toDate, settlementDate } = parsed.data;
    if (request.appUser.workspaceId !== workspaceId) return reply.code(403).send({ message: "Select this workspace before previewing labour settlements." });
    if (!hasModulePermission(request.appUser, workspaceId, "wages", "view")) return reply.code(403).send({ message: "Workspace wage settlement view permission is required." });
    if (!hasFarmAccess(request.appUser, workspaceId, farmId)) return reply.code(403).send({ message: "You do not have access to this farm." });
    if (!(await validateContext(request.sessionId, workspaceId, farmId, seasonId))) {
      return reply.code(403).send({ message: "Select this farm and season before previewing labour settlements." });
    }
    const ownershipError = await validateTenantReferences(workspaceId, { farmId, seasonId });
    if (ownershipError) return reply.code(403).send({ message: ownershipError });
    const preview = await db.transaction((tx) => previewLabourWageSettlement(tx, workspaceId, farmId, seasonId, fromDate, toDate, settlementDate));
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
    const { farmId, seasonId, fromDate, toDate, settlementDate, accountId, notes } = parsed.data;
    if (request.appUser.workspaceId !== workspaceId) return reply.code(403).send({ message: "Select this workspace before creating labour settlements." });
    if (!hasModulePermission(request.appUser, workspaceId, "wages", "create")) return reply.code(403).send({ message: "Workspace wage settlement create permission is required." });
    if (!hasFarmAccess(request.appUser, workspaceId, farmId)) return reply.code(403).send({ message: "You do not have access to this farm." });
    if (!(await validateContext(request.sessionId, workspaceId, farmId, seasonId))) {
      return reply.code(403).send({ message: "Select this farm and season before creating labour settlements." });
    }
    const ownershipError = await validateTenantReferences(workspaceId, { farmId, seasonId });
    if (ownershipError) return reply.code(403).send({ message: ownershipError });
    const accountError = await validateTenantReferencesDetailed(workspaceId, { farmId, seasonId, accountId });
    if (accountError) return reply.code(403).send({ message: accountError.message, details: accountError });

    const category = await resolveSettlementCategory(workspaceId);
    if (!category) return reply.code(400).send({ message: "A default expense category for labour wage settlements could not be resolved." });

    const preview = await db.transaction((tx) => previewLabourWageSettlement(tx, workspaceId, farmId, seasonId, fromDate, toDate, settlementDate));
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
        const createdAt = new Date();
        const settlementId = crypto.randomUUID();
        const settlementNumber = await allocateSettlementNumber(tx, workspaceId, farmId);
        const voucherId = crypto.randomUUID();
        const description = `Labour wage settlement: ${fromDate} to ${toDate} (attendance wages + labour work)`;
        const voucherPayload = {
          id: voucherId,
          date: settlementDate,
          voucherNumber: settlementNumber,
          categoryId: category.categoryId,
          category: category.category,
          subcategoryId: category.subcategoryId,
          subcategory: category.subcategory,
          description,
          amount: preview.expenseAmount,
          accountId,
          notes: notes?.trim() || "",
          attendanceWages: preview.attendanceWages,
          labourWork: preview.pendingLabourEarnings,
          totalLabourCost: preview.totalEarned,
          advancesAvailableUpToSettlementDate: preview.advancesPaid,
          appliedAdvances: preview.settledAdvanceAmount,
          cashPaid: preview.payableBalance,
          createdBy: request.appUser!.id,
          updatedBy: request.appUser!.id,
          settlementId,
          settlementNumber,
          voucherPurpose: "labour_wage_settlement",
          nonCashSettlement: true,
          items: [{
            id: crypto.randomUUID(),
            categoryId: category.categoryId,
            category: category.category,
            subcategoryId: category.subcategoryId,
            subcategory: category.subcategory,
            amount: preview.expenseAmount,
            description,
          }],
          createdAt: createdAt.toISOString(),
          updatedAt: createdAt.toISOString(),
        };
        const settlementPayload = {
          id: settlementId,
          settlementNumber,
          linkedVoucherId: voucherId,
          linkedVoucherNumber: settlementNumber,
          linkedAccountId: accountId,
          fromDate,
          toDate,
          settlementDate,
          attendanceWages: preview.attendanceWages,
          pendingLabourEarnings: preview.pendingLabourEarnings,
          labourWork: preview.pendingLabourEarnings,
          totalEarned: preview.totalEarned,
          totalLabourCost: preview.totalEarned,
          advancesPaid: preview.advancesPaid,
          advancesAvailableUpToSettlementDate: preview.advancesPaid,
          settledAdvanceAmount: preview.settledAdvanceAmount,
          appliedAdvances: preview.settledAdvanceAmount,
          expenseAmount: preview.expenseAmount,
          carryForwardAdvance: preview.carryForwardAdvance,
          payableBalance: preview.payableBalance,
          cashPayable: preview.payableBalance,
          notes: notes?.trim() || "",
          status: "posted",
          createdBy: request.appUser!.id,
          createdAt: createdAt.toISOString(),
          updatedAt: createdAt.toISOString(),
        };
        const earningsToSettle = await listLabourEarnings(tx, workspaceId, farmId, seasonId);
        await tx.insert(operationalRecords).values([
          {
            workspaceId,
            farmId,
            seasonId,
            clientRecordId: voucherId,
            entityType: "voucher",
            payload: voucherPayload,
            recordedBy: request.appUser!.id,
            clientUpdatedAt: createdAt,
            createdAt,
            updatedAt: createdAt,
          },
          {
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
          },
        ]);
        const includedEarningIds = new Set(preview.includedEarnings.map((item) => item.id));
        for (const earning of earningsToSettle) {
          if (!includedEarningIds.has(earning.clientRecordId)) continue;
          const nextPayload = {
            ...normalizeLabourEarningPayload(earning.payload as Record<string, unknown>),
            status: "settled",
            linkedSettlementId: settlementId,
            linkedVoucherId: voucherId,
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
        return {
          settlement: { ...settlementPayload, id: settlementId },
          voucher: { ...voucherPayload, id: voucherId },
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
}
