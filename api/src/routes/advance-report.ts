import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";
import { farms, operationalRecords, seasons, userSessions } from "../db/schema.js";
import { isDeletedOperationalPayload } from "../operational-record-state.js";
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
      eq(operationalRecords.farmId, farmId),
      eq(operationalRecords.seasonId, seasonId),
      eq(operationalRecords.entityType, "advance"),
    ));
    const records = advanceRecords.flatMap((record) => {
      const payload = record.payload as AdvancePayload;
      if (isDeletedOperationalPayload(payload)) return [];
      if (typeof payload.labourerId !== "string" || typeof payload.date !== "string") return [];
      if (payload.date < from || payload.date > to) return [];
      if (selectedLabourIds.size > 0 && !selectedLabourIds.has(payload.labourerId)) return [];
      const labourName = labourById.get(payload.labourerId);
      if (!labourName) return [];
      const accountId = typeof payload.accountId === "string" ? payload.accountId : "";
      return [{
        id: record.clientRecordId,
        labourerId: payload.labourerId,
        labourName,
        date: payload.date,
        amount: Number(payload.amount) || 0,
        notes: typeof payload.notes === "string" ? payload.notes : "",
        accountId,
        accountName: accountById.get(accountId) ?? (typeof payload.sourceAccountName === "string" ? payload.sourceAccountName : ""),
      }];
    }).sort((a, b) => a.labourName.localeCompare(b.labourName) || a.date.localeCompare(b.date));

    const grouped = new Map<string, { labourerId: string; labourName: string; total: number; count: number }>();
    for (const item of records) {
      const current = grouped.get(item.labourerId) ?? { labourerId: item.labourerId, labourName: item.labourName, total: 0, count: 0 };
      current.total += item.amount;
      current.count += 1;
      grouped.set(item.labourerId, current);
    }
    const summaries = [...grouped.values()].sort((a, b) => a.labourName.localeCompare(b.labourName));
    const grandTotal = summaries.reduce((sum, item) => sum + item.total, 0);
    return {
      records,
      summaries,
      grandTotal,
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

