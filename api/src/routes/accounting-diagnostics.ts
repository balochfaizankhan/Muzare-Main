import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireAdmin } from "../auth.js";
import { db } from "../db/client.js";
import { operationalRecords } from "../db/schema.js";
import { isDeletedOperationalPayload } from "../operational-record-state.js";

const querySchema = z.object({
  workspaceId: z.string().uuid(),
  farmId: z.string().uuid().optional(),
  seasonId: z.string().uuid().optional(),
});

export async function accountingDiagnosticsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/admin/accounting-diagnostics", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ message: "workspaceId is required." });
    const { workspaceId, farmId, seasonId } = parsed.data;

    const vouchers = await db.select({
      id: operationalRecords.clientRecordId,
      farmId: operationalRecords.farmId,
      seasonId: operationalRecords.seasonId,
      sourceType: operationalRecords.sourceType,
      payload: operationalRecords.payload,
      createdAt: operationalRecords.createdAt,
      updatedAt: operationalRecords.updatedAt,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.entityType, "voucher"),
    ));

    const normalized = vouchers.map((record) => {
      const payload = record.payload as Record<string, unknown>;
      const deleted = isDeletedOperationalPayload(payload);
      const imported = record.sourceType === "expense" || typeof payload.oldExpenseId === "string";
      const voucherNumber = typeof payload.voucherNumber === "string" ? payload.voucherNumber : "";
      const visibleInSelectedScope = farmId
        ? record.farmId === farmId && (
          !seasonId
          || record.seasonId === seasonId
          || record.seasonId === null
          || imported
        )
        : true;
      return {
        id: record.id,
        farmId: record.farmId,
        seasonId: record.seasonId,
        sourceType: record.sourceType,
        imported,
        deleted,
        visibleInSelectedScope,
        voucherNumber,
        date: typeof payload.date === "string" ? payload.date : "",
        amount: typeof payload.amount === "number" ? payload.amount : Number(payload.amount ?? 0),
        description: typeof payload.description === "string" ? payload.description : "",
        deletedAt: typeof payload.deletedAt === "string" ? payload.deletedAt : null,
        originalVoucherNumber: typeof payload.originalVoucherNumber === "string" ? payload.originalVoucherNumber : null,
        legacyVoucherNumber: typeof payload.legacyVoucherNumber === "string" ? payload.legacyVoucherNumber : null,
        oldExpenseId: typeof payload.oldExpenseId === "string" ? payload.oldExpenseId : null,
        createdAt: record.createdAt.toISOString(),
        updatedAt: record.updatedAt.toISOString(),
      };
    });

    const active = normalized.filter((record) => !record.deleted);
    const importedActive = active.filter((record) => record.imported);
    const deleted = normalized.filter((record) => record.deleted);
    const visibleInSelectedScope = active.filter((record) => record.visibleInSelectedScope);
    const hiddenFromSelectedScope = active.filter((record) => !record.visibleInSelectedScope);
    const hiddenImportedFromSelectedScope = hiddenFromSelectedScope.filter((record) => record.imported);

    const duplicateGroups = [...active.reduce((map, record) => {
      if (!record.voucherNumber) return map;
      const current = map.get(record.voucherNumber) ?? [];
      current.push(record);
      map.set(record.voucherNumber, current);
      return map;
    }, new Map<string, typeof active>())]
      .filter(([, rows]) => rows.length > 1)
      .map(([voucherNumber, rows]) => ({
        voucherNumber,
        count: rows.length,
        recordIds: rows.map((row) => row.id),
        farms: [...new Set(rows.map((row) => row.farmId ?? ""))].filter(Boolean),
        seasons: [...new Set(rows.map((row) => row.seasonId ?? ""))].filter(Boolean),
        sources: [...new Set(rows.map((row) => row.imported ? "imported" : "pwa"))],
      }))
      .sort((left, right) => left.voucherNumber.localeCompare(right.voucherNumber));

    return {
      workspaceId,
      scope: { farmId: farmId ?? null, seasonId: seasonId ?? null },
      voucherStats: {
        active: active.length,
        importedActive: importedActive.length,
        deleted: deleted.length,
        visibleInSelectedScope: visibleInSelectedScope.length,
        hiddenFromSelectedScope: hiddenFromSelectedScope.length,
        hiddenImportedFromSelectedScope: hiddenImportedFromSelectedScope.length,
      },
      duplicateVoucherGroups: duplicateGroups,
      hiddenActiveVouchers: hiddenFromSelectedScope.slice(0, 100),
      hiddenImportedVouchers: hiddenImportedFromSelectedScope.slice(0, 100),
      deletedVouchers: deleted.slice(0, 100),
    };
  });
}
