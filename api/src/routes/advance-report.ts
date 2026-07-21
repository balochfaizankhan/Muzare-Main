import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";
import { farms, operationalRecords, seasons, userSessions } from "../db/schema.js";
import { isDeletedOperationalPayload } from "../operational-record-state.js";
import { listAdvanceLedgerForReport } from "../lib/labour-advance-ledger.js";
import { loadLabourFinancialReadModel } from "../lib/labour-financial-read-model.js";
import { hasPermission } from "../permissions.js";
import { validateTenantReferences } from "../tenant-ownership.js";
import { hasFarmAccess } from "../workspace-access.js";

const paramsSchema = z.object({ workspaceId: z.string().uuid() });
const querySchema = z.object({
  farmId: z.string().uuid(),
  seasonId: z.string().uuid(),
  from: z.string().date(),
  to: z.string().date(),
  labourIds: z.string().optional(),
});

type LabourPayload = { name?: unknown };
type AccountPayload = { name?: unknown };
type AdvancePayload = { labourerId?: unknown; date?: unknown; amount?: unknown; notes?: unknown; accountId?: unknown; sourceAccountName?: unknown; deletedAt?: unknown };
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;

export async function advanceReportRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/workspace/:workspaceId/advance/report", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser || !request.sessionId) return reply.code(401).send({ message: "A database-backed session is required." });
    const params = paramsSchema.safeParse(request.params);
    const query = querySchema.safeParse(request.query);
    if (!params.success || !query.success || query.data.from > query.data.to) {
      return reply.code(400).send({ message: "A valid advance report date range is required." });
    }
    const { workspaceId } = params.data;
    const { farmId, seasonId, from, to, labourIds } = query.data;
    const selectedLabourIds = new Set((labourIds ?? "").split(",").map((item) => item.trim()).filter(Boolean));
    if (request.appUser.workspaceId !== workspaceId || !hasPermission(request.appUser, "VIEW_REPORTS", workspaceId)) {
      return reply.code(403).send({ message: "Workspace report permission is required." });
    }
    if (!hasFarmAccess(request.appUser, workspaceId, farmId)) {
      return reply.code(403).send({ message: "You do not have access to this farm." });
    }
    if (localDevelopmentMode) {
      return {
        records: [],
        summaries: [],
        metadata: null,
        grandTotal: 0,
      };
    }

    const [session] = await db.select({ activeFarmId: userSessions.activeFarmId, activeSeasonId: userSessions.activeSeasonId })
      .from(userSessions).where(eq(userSessions.id, request.sessionId)).limit(1);
    if (session?.activeFarmId !== farmId || session.activeSeasonId !== seasonId) {
      return reply.code(403).send({ message: "Select this farm and season before viewing its report." });
    }
    const ownershipError = await validateTenantReferences(workspaceId, { farmId, seasonId });
    if (ownershipError) return reply.code(403).send({ message: ownershipError });

    const [farm] = await db.select({ name: farms.name }).from(farms).where(and(eq(farms.id, farmId), eq(farms.workspaceId, workspaceId))).limit(1);
    const [season] = await db.select({ name: seasons.name }).from(seasons).where(and(eq(seasons.id, seasonId), eq(seasons.farmId, farmId), eq(seasons.workspaceId, workspaceId))).limit(1);

    const labourRecords = await db.select().from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.farmId, farmId),
      eq(operationalRecords.entityType, "labourer"),
    ));
    const labourById = new Map(labourRecords.map((record) => {
      const payload = record.payload as LabourPayload;
      return [record.clientRecordId, typeof payload.name === "string" ? payload.name : "Labourer"] as const;
    }));
    if ([...selectedLabourIds].some((id) => !labourById.has(id))) {
      return reply.code(403).send({ message: "One or more labour filters do not belong to the selected workspace farm." });
    }

    const accountRecords = await db.select().from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.farmId, farmId),
      eq(operationalRecords.seasonId, seasonId),
      eq(operationalRecords.entityType, "account"),
    ));
    const accountById = new Map(accountRecords.map((record) => {
      const payload = record.payload as AccountPayload;
      return [record.clientRecordId, typeof payload.name === "string" ? payload.name : "Account"] as const;
    }));
    const advanceRecords = await db.select().from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.entityType, "advance"),
    ));
    const advanceSourceById = new Map(advanceRecords.map((record) => [record.id, record]));
    const advanceSourceByClientId = new Map(advanceRecords.map((record) => [record.clientRecordId, record]));

    const reportLabourIds = selectedLabourIds.size ? [...selectedLabourIds] : [...labourById.keys()];
    const ledger = await db.transaction((tx) => listAdvanceLedgerForReport(tx, {
      workspaceId,
      farmId,
      seasonId,
      cutoffDate: to,
      settlementMode: "group",
      groupId: null,
      foremanId: null,
      labourerId: null,
      labourIds: reportLabourIds,
    }, reportLabourIds));
    const financials = await loadLabourFinancialReadModel({ workspaceId, farmId, seasonId });
    const financialByStableId = new Map<string, (typeof financials.advancePositions)[number]>();
    for (const row of financials.advancePositions) {
      for (const key of [row.legacySourceRecordId, row.sourceId, row.canonicalVoucherId, row.advancePositionId]) {
        if (key) financialByStableId.set(key, row);
      }
    }
    const records = ledger.rows.flatMap((row) => {
      if (!row.includedInPreview || !row.labourerId || !row.date) return [];
      if (row.date < from || row.date > to) return [];
      const labourName = row.labourerName ?? labourById.get(row.labourerId);
      if (!labourName) return [];
      const financial = financialByStableId.get(row.advanceId);
      return [{
        id: financial?.legacySourceRecordId ?? row.advanceId,
        labourerId: row.labourerId,
        labourName,
        date: financial?.advanceDate ?? row.date,
        amount: financial?.originalAmount ?? row.originalAmount,
        notes: financial?.description ?? "",
        accountId: financial?.fundingAccountId ?? row.accountId ?? "",
        accountName: financial?.fundingAccountName ?? row.accountName ?? accountById.get(row.accountId ?? "") ?? "",
        appliedAmount: financial?.appliedAmount ?? 0,
        recoveredAmount: financial?.recoveredAmount ?? 0,
        outstandingAmount: financial?.outstandingAmount ?? Math.max(row.originalAmount - (financial?.appliedAmount ?? 0) - (financial?.recoveredAmount ?? 0), 0),
        status: financial?.status ?? "POSTED",
        reviewRequired: financial?.needsReview ?? false,
        reviewReason: financial?.reviewReason ?? null,
        sourceClassification: financial?.sourceClassification ?? "LEGACY_OPERATIONAL",
        voucherNumber: financial?.voucherNumber ?? row.advanceId,
      }];
    });
    const coveredIds = new Set<string>();
    for (const row of records) {
      coveredIds.add(row.id);
      const financial = financialByStableId.get(row.id);
      if (financial) {
        for (const key of [financial.legacySourceRecordId, financial.sourceId, financial.canonicalVoucherId, financial.advancePositionId]) {
          if (key) coveredIds.add(key);
        }
      }
    }
    for (const row of financials.advancePositions) {
      const stableId = row.legacySourceRecordId ?? row.canonicalVoucherId ?? row.advancePositionId;
      if (coveredIds.has(stableId)) continue;
      if (row.advanceDate < from || row.advanceDate > to) continue;
      if (selectedLabourIds.size && (!row.labourerId || !selectedLabourIds.has(row.labourerId))) continue;
      records.push({
        id: stableId,
        labourerId: row.labourerId ?? row.labourGroupId ?? row.recipientName,
        labourName: row.labourerName ?? row.labourGroupName ?? row.recipientName,
        date: row.advanceDate,
        amount: row.originalAmount,
        notes: row.description,
        accountId: row.fundingAccountId ?? "",
        accountName: row.fundingAccountName ?? accountById.get(row.fundingAccountId ?? "") ?? "",
        appliedAmount: row.appliedAmount,
        recoveredAmount: row.recoveredAmount,
        outstandingAmount: row.outstandingAmount,
        status: row.status,
        reviewRequired: row.needsReview,
        reviewReason: row.reviewReason,
        sourceClassification: row.sourceClassification,
        voucherNumber: row.voucherNumber,
      });
    }
    records.sort((a, b) => a.labourName.localeCompare(b.labourName) || a.date.localeCompare(b.date));

    const grouped = new Map<string, { labourerId: string; labourName: string; total: number; count: number }>();
    for (const item of records) {
      const current = grouped.get(item.labourerId) ?? { labourerId: item.labourerId, labourName: item.labourName, total: 0, count: 0 };
      current.total += item.amount;
      current.count += 1;
      grouped.set(item.labourerId, current);
    }
    const summaries = [...grouped.values()].sort((a, b) => a.labourName.localeCompare(b.labourName));
    const grandTotal = summaries.reduce((sum, item) => sum + item.total, 0);
    const activeRows = records.filter((row) => row.status !== "VOIDED");
    const settledAdvances = activeRows.reduce((sum, row) => sum + row.appliedAmount, 0);
    const outstandingAdvances = activeRows.reduce((sum, row) => sum + row.outstandingAmount, 0);
    return {
      records,
      summaries,
      grandTotal,
      settledAdvances,
      outstandingAdvances,
      recoveredAdvances: activeRows.reduce((sum, row) => sum + row.recoveredAmount, 0),
      reviewRequiredCount: activeRows.filter((row) => row.reviewRequired).length,
      reconciliationTrace: records,
      filters: {
        dateRange: { from, to },
        labourIds: [...selectedLabourIds],
        labourGroup: "All Groups",
        labourer: selectedLabourIds.size ? [...selectedLabourIds].join(", ") : "All Labour",
        account: "All Accounts",
        recordedBy: "All Recorded By",
      },
      metadata: {
        farmName: farm?.name ?? "Farm",
        seasonName: season?.name ?? "Season",
        from,
        to,
        generatedAt: new Date().toISOString(),
        generatedBy: request.appUser.displayName || request.appUser.email,
      },
    };
  });
}

