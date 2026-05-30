import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";
import { operationalRecords, userSessions } from "../db/schema.js";
import { hasPermission } from "../permissions.js";
import { validateTenantReferences } from "../tenant-ownership.js";

const paramsSchema = z.object({ workspaceId: z.string().uuid() });
const querySchema = z.object({
  farmId: z.string().uuid(),
  seasonId: z.string().uuid(),
  from: z.string().date(),
  to: z.string().date(),
  labourId: z.string().min(1).optional(),
  status: z.enum(["present", "half_day", "absent"]).optional(),
});

type LabourPayload = { name?: unknown; dailyWage?: unknown };
type AttendancePayload = { labourerId?: unknown; date?: unknown; status?: unknown };

export async function attendanceReportRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/workspace/:workspaceId/attendance/report", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser || !request.sessionId) return reply.code(401).send({ message: "A database-backed session is required." });
    const params = paramsSchema.safeParse(request.params);
    const query = querySchema.safeParse(request.query);
    if (!params.success || !query.success || query.data.from > query.data.to) {
      return reply.code(400).send({ message: "A valid attendance report date range is required." });
    }
    const { workspaceId } = params.data;
    const { farmId, seasonId, from, to, labourId, status } = query.data;
    if (request.appUser.workspaceId !== workspaceId || !hasPermission(request.appUser, "VIEW_REPORTS", workspaceId)) {
      return reply.code(403).send({ message: "Workspace report permission is required." });
    }
    if (localDevelopmentMode) return { records: [], summaries: [] };

    const [session] = await db.select({ activeFarmId: userSessions.activeFarmId, activeSeasonId: userSessions.activeSeasonId })
      .from(userSessions).where(eq(userSessions.id, request.sessionId)).limit(1);
    if (session?.activeFarmId !== farmId || session.activeSeasonId !== seasonId) {
      return reply.code(403).send({ message: "Select this farm and season before viewing its report." });
    }
    const ownershipError = await validateTenantReferences(workspaceId, { farmId, seasonId });
    if (ownershipError) return reply.code(403).send({ message: ownershipError });

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
    if (labourId && !labourById.has(labourId)) {
      return reply.code(403).send({ message: "Labourer does not belong to the selected workspace farm." });
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
        || (labourId && payload.labourerId !== labourId)
        || (status && payload.status !== status)) return [];
      const labourer = labourById.get(payload.labourerId);
      if (!labourer) return [];
      return [{
        id: record.clientRecordId, labourerId: labourer.id, labourName: labourer.name,
        dailyWage: labourer.dailyWage, date: payload.date, status: payload.status as "present" | "half_day" | "absent",
      }];
    }).sort((a, b) => a.date.localeCompare(b.date) || a.labourName.localeCompare(b.labourName));

    const summaries = [...labourById.values()]
      .filter((labourer) => !labourId || labourer.id === labourId)
      .map((labourer) => {
        const labourAttendance = records.filter((record) => record.labourerId === labourer.id);
        const presentDays = labourAttendance.filter((record) => record.status === "present").length;
        const halfDays = labourAttendance.filter((record) => record.status === "half_day").length;
        const absentDays = labourAttendance.filter((record) => record.status === "absent").length;
        const payableDays = presentDays + halfDays * 0.5;
        return { ...labourer, presentDays, halfDays, absentDays, payableDays, totalWage: payableDays * labourer.dailyWage, records: labourAttendance };
      })
      .filter((summary) => summary.records.length > 0);
    return { records, summaries };
  });
}
