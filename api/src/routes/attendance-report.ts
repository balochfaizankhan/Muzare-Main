import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";
import { farms, operationalRecords, seasons, userSessions } from "../db/schema.js";
import { hasPermission } from "../permissions.js";
import { validateTenantReferences } from "../tenant-ownership.js";

const paramsSchema = z.object({ workspaceId: z.string().uuid() });
const querySchema = z.object({
  farmId: z.string().uuid(),
  seasonId: z.string().uuid(),
  from: z.string().date(),
  to: z.string().date(),
  labourId: z.string().min(1).optional(),
  labourIds: z.string().optional(),
  status: z.enum(["present", "half_day", "absent"]).optional(),
});

type LabourPayload = { name?: unknown; dailyWage?: unknown };
type AttendancePayload = { labourerId?: unknown; date?: unknown; status?: unknown };
type AdvancePayload = { labourerId?: unknown; date?: unknown; amount?: unknown };

function reportDates(from: string, to: string) {
  const dates: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export async function attendanceReportRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/workspace/:workspaceId/attendance/report", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser || !request.sessionId) return reply.code(401).send({ message: "A database-backed session is required." });
    const params = paramsSchema.safeParse(request.params);
    const query = querySchema.safeParse(request.query);
    if (!params.success || !query.success || query.data.from > query.data.to) {
      return reply.code(400).send({ message: "A valid attendance report date range is required." });
    }
    const { workspaceId } = params.data;
    const { farmId, seasonId, from, to, labourId, labourIds, status } = query.data;
    const selectedLabourIds = new Set((labourIds ?? "").split(",").map((item) => item.trim()).filter(Boolean));
    if (labourId) selectedLabourIds.add(labourId);
    if (request.appUser.workspaceId !== workspaceId || !hasPermission(request.appUser, "VIEW_REPORTS", workspaceId)) {
      return reply.code(403).send({ message: "Workspace report permission is required." });
    }
    if (localDevelopmentMode) return { records: [], summaries: [], advances: [], dates: reportDates(from, to), metadata: null };

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
      return [record.clientRecordId, {
        id: record.clientRecordId,
        name: typeof payload.name === "string" ? payload.name : "Labourer",
        dailyWage: typeof payload.dailyWage === "number" ? payload.dailyWage : Number(payload.dailyWage) || 0,
      }] as const;
    }));
    if ([...selectedLabourIds].some((id) => !labourById.has(id))) {
      return reply.code(403).send({ message: "One or more labour filters do not belong to the selected workspace farm." });
    }

    const attendanceRecords = await db.select().from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.farmId, farmId),
      eq(operationalRecords.seasonId, seasonId),
      eq(operationalRecords.entityType, "attendance"),
    ));
    const records = attendanceRecords.flatMap((record) => {
      const payload = record.payload as AttendancePayload;
      if (typeof payload.labourerId !== "string" || typeof payload.date !== "string"
        || !["present", "half_day", "absent"].includes(String(payload.status))
        || payload.date < from || payload.date > to
        || (selectedLabourIds.size > 0 && !selectedLabourIds.has(payload.labourerId))
        || (status && payload.status !== status)) return [];
      const labourer = labourById.get(payload.labourerId);
      if (!labourer) return [];
      return [{
        id: record.clientRecordId, labourerId: labourer.id, labourName: labourer.name,
        dailyWage: labourer.dailyWage, date: payload.date, status: payload.status as "present" | "half_day" | "absent",
      }];
    }).sort((a, b) => a.date.localeCompare(b.date) || a.labourName.localeCompare(b.labourName));
    const advanceRecords = await db.select().from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.farmId, farmId),
      eq(operationalRecords.seasonId, seasonId),
      eq(operationalRecords.entityType, "advance"),
    ));
    const advances = advanceRecords.flatMap((record) => {
      const payload = record.payload as AdvancePayload;
      if (typeof payload.labourerId !== "string" || typeof payload.date !== "string"
        || payload.date < from || payload.date > to || (selectedLabourIds.size > 0 && !selectedLabourIds.has(payload.labourerId))) return [];
      const labourer = labourById.get(payload.labourerId);
      if (!labourer) return [];
      return [{ id: record.clientRecordId, labourerId: labourer.id, date: payload.date, amount: Number(payload.amount) || 0 }];
    });

    const summaries = [...labourById.values()]
      .filter((labourer) => selectedLabourIds.size === 0 || selectedLabourIds.has(labourer.id))
      .map((labourer) => {
        const labourAttendance = records.filter((record) => record.labourerId === labourer.id);
        const presentDays = labourAttendance.filter((record) => record.status === "present").length;
        const halfDays = labourAttendance.filter((record) => record.status === "half_day").length;
        const absentDays = labourAttendance.filter((record) => record.status === "absent").length;
        const payableDays = presentDays + halfDays * 0.5;
        return { ...labourer, presentDays, halfDays, absentDays, payableDays, totalWage: payableDays * labourer.dailyWage, records: labourAttendance };
      })
      .filter((summary) => summary.records.length > 0);
    return {
      records, summaries, advances, dates: reportDates(from, to),
      metadata: {
        farmName: farm?.name ?? "Farm", seasonName: season?.name ?? "Season", from, to,
        generatedAt: new Date().toISOString(), generatedBy: request.appUser.displayName || request.appUser.email,
      },
    };
  });
}
