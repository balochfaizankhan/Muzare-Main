import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { db } from "../db/client.js";
import {
  farmMapFeatures,
  farmMaps,
  farmProducts,
  farms,
  irrigationLines,
  operationDueRules,
  operationLogs,
  plots,
  seasons,
  valves,
  waterAssets,
} from "../db/schema.js";
import { hasPermission } from "../permissions.js";
import { hasFarmAccess } from "../workspace-access.js";

const paramsSchema = z.object({ workspaceId: z.string().uuid(), farmId: z.string().uuid() });
const idParamSchema = paramsSchema.extend({ id: z.string().uuid() });
const maybeUuid = z.string().uuid().optional().nullable().or(z.literal(""));
const nullableText = z.string().trim().max(2000).optional().nullable().or(z.literal(""));
const featureTypes = ["farm_boundary", "plot", "irrigation_line", "valve", "landmark", "other"] as const;
const activityTypes = ["irrigation", "fertilizer", "pesticide", "pruning", "thinning", "pollination", "harvesting", "maintenance", "other"] as const;
const productTypes = ["fertilizer", "pesticide", "other"] as const;
const waterAssetTypes = ["pump", "reservoir"] as const;

const mapInput = z.object({
  seasonId: maybeUuid,
  mapName: z.string().trim().min(1).max(160),
  centerLat: z.coerce.number().min(-90).max(90),
  centerLng: z.coerce.number().min(-180).max(180),
  defaultZoom: z.coerce.number().min(1).max(22),
  baseMapProvider: z.string().trim().max(80).optional().default("maplibre_satellite"),
  notes: nullableText,
});
const featureInput = z.object({
  seasonId: maybeUuid,
  featureType: z.enum(featureTypes),
  featureCode: z.string().trim().max(80).optional().nullable(),
  featureName: z.string().trim().min(1).max(160),
  geojson: z.record(z.string(), z.unknown()),
  linkedPlotId: maybeUuid,
  linkedIrrigationLineId: maybeUuid,
  linkedValveId: maybeUuid,
  styleJson: z.record(z.string(), z.unknown()).optional().nullable(),
  displayOrder: z.coerce.number().int().optional().default(0),
  active: z.boolean().optional().default(true),
});
const plotInput = z.object({
  seasonId: maybeUuid,
  plotCode: z.string().trim().min(1).max(80),
  plotName: z.string().trim().max(160).optional().nullable(),
  variety: z.string().trim().max(120).optional().nullable(),
  treeCount: z.coerce.number().int().nonnegative().optional().nullable(),
  area: z.coerce.number().nonnegative().optional().nullable(),
  notes: nullableText,
  geoFeatureId: maybeUuid,
  active: z.boolean().optional().default(true),
});
const lineInput = z.object({
  seasonId: maybeUuid,
  lineCode: z.string().trim().min(1).max(80),
  lineName: z.string().trim().max(160).optional().nullable(),
  description: nullableText,
  geoFeatureId: maybeUuid,
  active: z.boolean().optional().default(true),
});
const valveInput = z.object({
  seasonId: maybeUuid,
  valveCode: z.string().trim().min(1).max(80),
  valveName: z.string().trim().max(160).optional().nullable(),
  irrigationLineId: maybeUuid,
  plotId: maybeUuid,
  estimatedTreeCount: z.coerce.number().int().nonnegative().optional().nullable(),
  notes: nullableText,
  geoFeatureId: maybeUuid,
  active: z.boolean().optional().default(true),
});
const productInput = z.object({
  productType: z.enum(productTypes),
  category: z.string().trim().max(120).optional().nullable(),
  productName: z.string().trim().min(1).max(160),
  unit: z.string().trim().max(40).optional().nullable(),
  notes: nullableText,
  active: z.boolean().optional().default(true),
});
const waterAssetInput = z.object({
  seasonId: maybeUuid,
  assetType: z.enum(waterAssetTypes),
  assetCode: z.string().trim().min(1).max(80),
  assetName: z.string().trim().min(1).max(160),
  linkedFeatureId: maybeUuid,
  status: z.string().trim().max(80).optional().nullable(),
  notes: nullableText,
  active: z.boolean().optional().default(true),
});
const logInput = z.object({
  seasonId: z.string().uuid(),
  plotId: maybeUuid,
  irrigationLineId: maybeUuid,
  valveId: maybeUuid,
  activityType: z.enum(activityTypes),
  activityCategory: z.string().trim().max(120).optional().nullable(),
  productId: maybeUuid,
  productNameText: z.string().trim().max(160).optional().nullable(),
  operationDate: z.string().date(),
  startTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional().nullable().or(z.literal("")),
  endTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional().nullable().or(z.literal("")),
  durationMinutes: z.coerce.number().int().nonnegative().optional().nullable(),
  qtyPerTree: z.coerce.number().nonnegative().optional().nullable(),
  totalQty: z.coerce.number().nonnegative().optional().nullable(),
  unit: z.string().trim().max(40).optional().nullable(),
  treeCountCovered: z.coerce.number().int().nonnegative().optional().nullable(),
  performedBy: z.string().trim().max(160).optional().nullable(),
  labourTeamId: maybeUuid,
  remarks: nullableText,
});
const ruleInput = z.object({
  seasonId: maybeUuid,
  plotId: maybeUuid,
  activityType: z.enum(activityTypes),
  activityCategory: z.string().trim().max(120).optional().nullable(),
  productId: maybeUuid,
  intervalDays: z.coerce.number().int().positive(),
  dueSoonDays: z.coerce.number().int().nonnegative().optional().default(2),
  active: z.boolean().optional().default(true),
  notes: nullableText,
});
const dashboardQuery = z.object({ farmId: z.string().uuid(), seasonId: z.string().uuid().optional().nullable() });
const logsQuery = dashboardQuery.extend({
  plotId: z.string().uuid().optional(),
  valveId: z.string().uuid().optional(),
  irrigationLineId: z.string().uuid().optional(),
  activityType: z.enum(activityTypes).optional(),
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
});

const blankToNull = (value: string | null | undefined) => value?.trim() || null;
const numberString = (value: number | null | undefined) => value === null || value === undefined ? null : String(value);

function isSelectedWorkspace(request: FastifyRequest, workspaceId: string) {
  return request.appUser?.workspaceId === workspaceId
    && request.appUser.memberships.some((membership) => membership.active && membership.workspaceId === workspaceId);
}

function canRead(request: FastifyRequest, workspaceId: string) {
  return Boolean(request.appUser && isSelectedWorkspace(request, workspaceId));
}

function canSubmit(request: FastifyRequest, workspaceId: string) {
  return Boolean(request.appUser && (hasPermission(request.appUser, "SUBMIT_RECORDS", workspaceId) || hasPermission(request.appUser, "MANAGE_RECORDS", workspaceId)));
}

function canManage(request: FastifyRequest, workspaceId: string) {
  return Boolean(request.appUser && hasPermission(request.appUser, "MANAGE_RECORDS", workspaceId));
}

async function farmExists(workspaceId: string, farmId: string) {
  const [farm] = await db.select({ id: farms.id }).from(farms).where(and(eq(farms.workspaceId, workspaceId), eq(farms.id, farmId), isNull(farms.deletedAt))).limit(1);
  return Boolean(farm);
}

async function seasonExists(workspaceId: string, farmId: string, seasonId?: string | null) {
  if (!seasonId) return true;
  const [season] = await db.select({ id: seasons.id }).from(seasons)
    .where(and(eq(seasons.workspaceId, workspaceId), eq(seasons.farmId, farmId), eq(seasons.id, seasonId))).limit(1);
  return Boolean(season);
}

async function countLinkedRecords(resource: string, workspaceId: string, farmId: string, id: string) {
  switch (resource) {
    case "plots": {
      const [logCount, valveCount, ruleCount, featureCount] = await Promise.all([
        db.select({ count: sql<number>`count(*)::int` }).from(operationLogs).where(and(eq(operationLogs.workspaceId, workspaceId), eq(operationLogs.farmId, farmId), eq(operationLogs.plotId, id))),
        db.select({ count: sql<number>`count(*)::int` }).from(valves).where(and(eq(valves.workspaceId, workspaceId), eq(valves.farmId, farmId), eq(valves.plotId, id), eq(valves.active, true))),
        db.select({ count: sql<number>`count(*)::int` }).from(operationDueRules).where(and(eq(operationDueRules.workspaceId, workspaceId), eq(operationDueRules.farmId, farmId), eq(operationDueRules.plotId, id), eq(operationDueRules.active, true))),
        db.select({ count: sql<number>`count(*)::int` }).from(farmMapFeatures).where(and(eq(farmMapFeatures.workspaceId, workspaceId), eq(farmMapFeatures.farmId, farmId), eq(farmMapFeatures.linkedPlotId, id), eq(farmMapFeatures.active, true))),
      ]);
      return (logCount[0]?.count ?? 0) + (valveCount[0]?.count ?? 0) + (ruleCount[0]?.count ?? 0) + (featureCount[0]?.count ?? 0);
    }
    case "irrigation-lines": {
      const [logCount, valveCount, featureCount] = await Promise.all([
        db.select({ count: sql<number>`count(*)::int` }).from(operationLogs).where(and(eq(operationLogs.workspaceId, workspaceId), eq(operationLogs.farmId, farmId), eq(operationLogs.irrigationLineId, id))),
        db.select({ count: sql<number>`count(*)::int` }).from(valves).where(and(eq(valves.workspaceId, workspaceId), eq(valves.farmId, farmId), eq(valves.irrigationLineId, id), eq(valves.active, true))),
        db.select({ count: sql<number>`count(*)::int` }).from(farmMapFeatures).where(and(eq(farmMapFeatures.workspaceId, workspaceId), eq(farmMapFeatures.farmId, farmId), eq(farmMapFeatures.linkedIrrigationLineId, id), eq(farmMapFeatures.active, true))),
      ]);
      return (logCount[0]?.count ?? 0) + (valveCount[0]?.count ?? 0) + (featureCount[0]?.count ?? 0);
    }
    case "valves": {
      const [logCount, featureCount] = await Promise.all([
        db.select({ count: sql<number>`count(*)::int` }).from(operationLogs).where(and(eq(operationLogs.workspaceId, workspaceId), eq(operationLogs.farmId, farmId), eq(operationLogs.valveId, id))),
        db.select({ count: sql<number>`count(*)::int` }).from(farmMapFeatures).where(and(eq(farmMapFeatures.workspaceId, workspaceId), eq(farmMapFeatures.farmId, farmId), eq(farmMapFeatures.linkedValveId, id), eq(farmMapFeatures.active, true))),
      ]);
      return (logCount[0]?.count ?? 0) + (featureCount[0]?.count ?? 0);
    }
    case "water-assets":
      return 0;
    case "features": {
      const [plotCount, lineCount, valveCount, assetCount] = await Promise.all([
        db.select({ count: sql<number>`count(*)::int` }).from(plots).where(and(eq(plots.workspaceId, workspaceId), eq(plots.farmId, farmId), eq(plots.geoFeatureId, id), eq(plots.active, true))),
        db.select({ count: sql<number>`count(*)::int` }).from(irrigationLines).where(and(eq(irrigationLines.workspaceId, workspaceId), eq(irrigationLines.farmId, farmId), eq(irrigationLines.geoFeatureId, id), eq(irrigationLines.active, true))),
        db.select({ count: sql<number>`count(*)::int` }).from(valves).where(and(eq(valves.workspaceId, workspaceId), eq(valves.farmId, farmId), eq(valves.geoFeatureId, id), eq(valves.active, true))),
        db.select({ count: sql<number>`count(*)::int` }).from(waterAssets).where(and(eq(waterAssets.workspaceId, workspaceId), eq(waterAssets.farmId, farmId), eq(waterAssets.linkedFeatureId, id), eq(waterAssets.active, true))),
      ]);
      return (plotCount[0]?.count ?? 0) + (lineCount[0]?.count ?? 0) + (valveCount[0]?.count ?? 0) + (assetCount[0]?.count ?? 0);
    }
    default:
      return 0;
  }
}

async function ensureScope(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, request: FastifyRequest, workspaceId: string, farmId: string, write: "read" | "submit" | "manage") {
  const allowed = write === "read" ? canRead(request, workspaceId) : write === "submit" ? canSubmit(request, workspaceId) : canManage(request, workspaceId);
  if (!allowed) {
    reply.code(403).send({ message: write === "read" ? "Select this workspace before viewing farm operations." : "You do not have permission to change farm operations records." });
    return false;
  }
  if (!hasFarmAccess(request.appUser, workspaceId, farmId)) {
    reply.code(403).send({ message: "You do not have access to this farm." });
    return false;
  }
  if (!(await farmExists(workspaceId, farmId))) {
    reply.code(404).send({ message: "Farm not found in this workspace." });
    return false;
  }
  return true;
}

function geometryType(input: Record<string, unknown>) {
  if (input.type === "Feature" && input.geometry && typeof input.geometry === "object") return (input.geometry as Record<string, unknown>).type;
  return input.type;
}

function validGeoJsonForFeature(featureType: string, geojson: Record<string, unknown>) {
  const type = geometryType(geojson);
  if (featureType === "farm_boundary" || featureType === "plot") return type === "Polygon" || type === "MultiPolygon";
  if (featureType === "irrigation_line") return type === "LineString" || type === "MultiLineString";
  if (featureType === "valve") return type === "Point";
  return Boolean(type);
}

function statusFrom(lastDate: string | null, intervalDays: number, dueSoonDays: number, today: string) {
  if (!lastDate) return "none";
  if (lastDate === today) return "completed_today";
  const elapsed = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${lastDate}T00:00:00Z`)) / 86_400_000);
  if (elapsed > intervalDays) return "overdue";
  if (elapsed >= intervalDays - dueSoonDays) return "due_soon";
  return "ok";
}

async function readDashboard(workspaceId: string, farmId: string, seasonId?: string | null) {
  const seasonFilter = seasonId ? eq(plots.seasonId, seasonId) : sql`true`;
  const featureSeasonFilter = seasonId ? eq(farmMapFeatures.seasonId, seasonId) : sql`true`;
  const logSeasonFilter = seasonId ? eq(operationLogs.seasonId, seasonId) : sql`true`;
  const [map] = await db.select().from(farmMaps).where(and(eq(farmMaps.workspaceId, workspaceId), eq(farmMaps.farmId, farmId), seasonId ? eq(farmMaps.seasonId, seasonId) : sql`true`)).orderBy(desc(farmMaps.updatedAt)).limit(1);
  const [features, plotRows, lineRows, valveRows, waterAssetRows, rules, recentOperations] = await Promise.all([
    db.select().from(farmMapFeatures).where(and(eq(farmMapFeatures.workspaceId, workspaceId), eq(farmMapFeatures.farmId, farmId), featureSeasonFilter, eq(farmMapFeatures.active, true))).orderBy(farmMapFeatures.displayOrder, farmMapFeatures.featureName),
    db.select().from(plots).where(and(eq(plots.workspaceId, workspaceId), eq(plots.farmId, farmId), seasonFilter, eq(plots.active, true))).orderBy(plots.plotCode),
    db.select().from(irrigationLines).where(and(eq(irrigationLines.workspaceId, workspaceId), eq(irrigationLines.farmId, farmId), seasonId ? eq(irrigationLines.seasonId, seasonId) : sql`true`, eq(irrigationLines.active, true))).orderBy(irrigationLines.lineCode),
    db.select().from(valves).where(and(eq(valves.workspaceId, workspaceId), eq(valves.farmId, farmId), seasonId ? eq(valves.seasonId, seasonId) : sql`true`, eq(valves.active, true))).orderBy(valves.valveCode),
    db.select().from(waterAssets).where(and(eq(waterAssets.workspaceId, workspaceId), eq(waterAssets.farmId, farmId), seasonId ? eq(waterAssets.seasonId, seasonId) : sql`true`, eq(waterAssets.active, true))).orderBy(waterAssets.assetType, waterAssets.assetCode),
    db.select().from(operationDueRules).where(and(eq(operationDueRules.workspaceId, workspaceId), eq(operationDueRules.farmId, farmId), seasonId ? eq(operationDueRules.seasonId, seasonId) : sql`true`, eq(operationDueRules.active, true))),
    db.select().from(operationLogs).where(and(eq(operationLogs.workspaceId, workspaceId), eq(operationLogs.farmId, farmId), logSeasonFilter)).orderBy(desc(operationLogs.operationDate), desc(operationLogs.createdAt)).limit(25),
  ]);
  const lastRows = await db
    .select({ plotId: operationLogs.plotId, valveId: operationLogs.valveId, activityType: operationLogs.activityType, lastDate: sql<string>`max(${operationLogs.operationDate})` })
    .from(operationLogs)
    .where(and(eq(operationLogs.workspaceId, workspaceId), eq(operationLogs.farmId, farmId), logSeasonFilter))
    .groupBy(operationLogs.plotId, operationLogs.valveId, operationLogs.activityType);
  const today = new Date().toISOString().slice(0, 10);
  const defaults: Record<string, { intervalDays: number; dueSoonDays: number }> = {
    irrigation: { intervalDays: 5, dueSoonDays: 1 },
    fertilizer: { intervalDays: 30, dueSoonDays: 5 },
    pesticide: { intervalDays: 14, dueSoonDays: 3 },
  };
  const ruleFor = (plotId: string | null, activityType: string) => {
    const rule = rules.find((item) => item.activityType === activityType && (item.plotId === plotId || !item.plotId));
    return rule ? { intervalDays: rule.intervalDays, dueSoonDays: rule.dueSoonDays } : defaults[activityType];
  };
  const lastFor = (scope: "plotId" | "valveId", id: string, activityType: string) => lastRows.find((row) => row[scope] === id && row.activityType === activityType)?.lastDate ?? null;
  const plotStatusSummary = plotRows.map((plot) => {
    const statuses = Object.fromEntries(["irrigation", "fertilizer", "pesticide"].map((activityType) => {
      const rule = ruleFor(plot.id, activityType) ?? { intervalDays: 30, dueSoonDays: 3 };
      return [activityType, statusFrom(lastFor("plotId", plot.id, activityType), rule.intervalDays, rule.dueSoonDays, today)];
    }));
    return { plotId: plot.id, statuses };
  });
  const valveStatusSummary = valveRows.map((valve) => {
    const statuses = Object.fromEntries(["irrigation", "fertilizer", "pesticide"].map((activityType) => {
      const rule = ruleFor(valve.plotId ?? null, activityType) ?? { intervalDays: 30, dueSoonDays: 3 };
      return [activityType, statusFrom(lastFor("valveId", valve.id, activityType), rule.intervalDays, rule.dueSoonDays, today)];
    }));
    return { valveId: valve.id, statuses };
  });
  const dueWorkList = plotStatusSummary.flatMap((item) => Object.entries(item.statuses)
    .filter(([, status]) => status === "overdue" || status === "due_soon")
    .map(([activityType, status]) => ({ plotId: item.plotId, activityType, status })));
  const completedTodayCount = recentOperations.filter((item) => item.operationDate === today).length;
  return {
    farmMap: map ?? null,
    features,
    plots: plotRows,
    irrigationLines: lineRows,
    valves: valveRows,
    waterAssets: waterAssetRows,
    plotStatusSummary,
    valveStatusSummary,
    overdueCounts: {
      plots: plotStatusSummary.filter((item) => Object.values(item.statuses).includes("overdue")).length,
      valves: valveStatusSummary.filter((item) => Object.values(item.statuses).includes("overdue")).length,
    },
    dueSoonCounts: {
      plots: plotStatusSummary.filter((item) => Object.values(item.statuses).includes("due_soon")).length,
      valves: valveStatusSummary.filter((item) => Object.values(item.statuses).includes("due_soon")).length,
    },
    completedTodayCount,
    recentOperations,
    dueWorkList,
  };
}

export async function farmOperationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/workspace/:workspaceId/farms/:farmId/farm-operations/dashboard", { preHandler: requireUser }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const query = z.object({ seasonId: z.string().uuid().optional() }).safeParse(request.query);
    if (!request.appUser || !params.success || !query.success) return reply.code(400).send({ message: "Valid farm context is required." });
    if (!(await ensureScope(reply, request, params.data.workspaceId, params.data.farmId, "read"))) return reply;
    return readDashboard(params.data.workspaceId, params.data.farmId, query.data.seasonId);
  });

  app.get("/v1/workspace/:workspaceId/farm-operations/dashboard", { preHandler: requireUser }, async (request, reply) => {
    const params = z.object({ workspaceId: z.string().uuid() }).safeParse(request.params);
    const query = dashboardQuery.safeParse(request.query);
    if (!request.appUser || !params.success || !query.success) return reply.code(400).send({ message: "Valid farm context is required." });
    if (!(await ensureScope(reply, request, params.data.workspaceId, query.data.farmId, "read"))) return reply;
    return readDashboard(params.data.workspaceId, query.data.farmId, query.data.seasonId);
  });

  app.get("/v1/workspace/:workspaceId/farm-operations/logs", { preHandler: requireUser }, async (request, reply) => {
    const params = z.object({ workspaceId: z.string().uuid() }).safeParse(request.params);
    const query = logsQuery.safeParse(request.query);
    if (!request.appUser || !params.success || !query.success) return reply.code(400).send({ message: "Valid log filters are required." });
    if (!(await ensureScope(reply, request, params.data.workspaceId, query.data.farmId, "read"))) return reply;
    const filters = [
      eq(operationLogs.workspaceId, params.data.workspaceId),
      eq(operationLogs.farmId, query.data.farmId),
      query.data.seasonId ? eq(operationLogs.seasonId, query.data.seasonId) : undefined,
      query.data.plotId ? eq(operationLogs.plotId, query.data.plotId) : undefined,
      query.data.valveId ? eq(operationLogs.valveId, query.data.valveId) : undefined,
      query.data.irrigationLineId ? eq(operationLogs.irrigationLineId, query.data.irrigationLineId) : undefined,
      query.data.activityType ? eq(operationLogs.activityType, query.data.activityType) : undefined,
      query.data.dateFrom ? gte(operationLogs.operationDate, query.data.dateFrom) : undefined,
      query.data.dateTo ? lte(operationLogs.operationDate, query.data.dateTo) : undefined,
    ].filter(Boolean);
    const records = await db.select().from(operationLogs).where(and(...filters)).orderBy(desc(operationLogs.operationDate), desc(operationLogs.createdAt)).limit(500);
    return { records };
  });

  app.get("/v1/workspace/:workspaceId/farms/:farmId/farm-operations/products", { preHandler: requireUser }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!request.appUser || !params.success) return reply.code(400).send({ message: "Valid farm context is required." });
    if (!(await ensureScope(reply, request, params.data.workspaceId, params.data.farmId, "read"))) return reply;
    return { records: await db.select().from(farmProducts).where(eq(farmProducts.workspaceId, params.data.workspaceId)).orderBy(farmProducts.productType, farmProducts.productName) };
  });

  const crud = [
    { name: "maps", table: farmMaps, schema: mapInput, write: "manage" as const, values: (data: z.infer<typeof mapInput>, p: z.infer<typeof paramsSchema>, u: string) => ({ workspaceId: p.workspaceId, farmId: p.farmId, seasonId: blankToNull(data.seasonId), mapName: data.mapName, centerLat: String(data.centerLat), centerLng: String(data.centerLng), defaultZoom: String(data.defaultZoom), baseMapProvider: data.baseMapProvider, notes: blankToNull(data.notes), createdBy: u }) },
    { name: "features", table: farmMapFeatures, schema: featureInput, write: "manage" as const, values: (data: z.infer<typeof featureInput>, p: z.infer<typeof paramsSchema>, u: string) => ({ workspaceId: p.workspaceId, farmId: p.farmId, seasonId: blankToNull(data.seasonId), featureType: data.featureType, featureCode: blankToNull(data.featureCode), featureName: data.featureName, geojson: data.geojson, linkedPlotId: blankToNull(data.linkedPlotId), linkedIrrigationLineId: blankToNull(data.linkedIrrigationLineId), linkedValveId: blankToNull(data.linkedValveId), styleJson: data.styleJson ?? null, displayOrder: data.displayOrder, active: data.active, createdBy: u }) },
    { name: "plots", table: plots, schema: plotInput, write: "manage" as const, values: (data: z.infer<typeof plotInput>, p: z.infer<typeof paramsSchema>) => ({ workspaceId: p.workspaceId, farmId: p.farmId, seasonId: blankToNull(data.seasonId), plotCode: data.plotCode, plotName: blankToNull(data.plotName), variety: blankToNull(data.variety), treeCount: data.treeCount ?? null, area: numberString(data.area), notes: blankToNull(data.notes), geoFeatureId: blankToNull(data.geoFeatureId), active: data.active }) },
    { name: "irrigation-lines", table: irrigationLines, schema: lineInput, write: "manage" as const, values: (data: z.infer<typeof lineInput>, p: z.infer<typeof paramsSchema>) => ({ workspaceId: p.workspaceId, farmId: p.farmId, seasonId: blankToNull(data.seasonId), lineCode: data.lineCode, lineName: blankToNull(data.lineName), description: blankToNull(data.description), geoFeatureId: blankToNull(data.geoFeatureId), active: data.active }) },
    { name: "valves", table: valves, schema: valveInput, write: "manage" as const, values: (data: z.infer<typeof valveInput>, p: z.infer<typeof paramsSchema>) => ({ workspaceId: p.workspaceId, farmId: p.farmId, seasonId: blankToNull(data.seasonId), valveCode: data.valveCode, valveName: blankToNull(data.valveName), irrigationLineId: blankToNull(data.irrigationLineId), plotId: blankToNull(data.plotId), estimatedTreeCount: data.estimatedTreeCount ?? null, notes: blankToNull(data.notes), geoFeatureId: blankToNull(data.geoFeatureId), active: data.active }) },
    { name: "water-assets", table: waterAssets, schema: waterAssetInput, write: "manage" as const, values: (data: z.infer<typeof waterAssetInput>, p: z.infer<typeof paramsSchema>, u: string) => ({ workspaceId: p.workspaceId, farmId: p.farmId, seasonId: blankToNull(data.seasonId), assetType: data.assetType, assetCode: data.assetCode, assetName: data.assetName, linkedFeatureId: blankToNull(data.linkedFeatureId), status: blankToNull(data.status), notes: blankToNull(data.notes), active: data.active, createdBy: u }) },
    { name: "operation-logs", table: operationLogs, schema: logInput, write: "submit" as const, values: (data: z.infer<typeof logInput>, p: z.infer<typeof paramsSchema>, u: string) => ({ workspaceId: p.workspaceId, farmId: p.farmId, seasonId: data.seasonId, plotId: blankToNull(data.plotId), irrigationLineId: blankToNull(data.irrigationLineId), valveId: blankToNull(data.valveId), activityType: data.activityType, activityCategory: blankToNull(data.activityCategory), productId: blankToNull(data.productId), productNameText: blankToNull(data.productNameText), operationDate: data.operationDate, startTime: blankToNull(data.startTime), endTime: blankToNull(data.endTime), durationMinutes: data.durationMinutes ?? null, qtyPerTree: numberString(data.qtyPerTree), totalQty: numberString(data.totalQty), unit: blankToNull(data.unit), treeCountCovered: data.treeCountCovered ?? null, performedBy: blankToNull(data.performedBy), labourTeamId: blankToNull(data.labourTeamId), remarks: blankToNull(data.remarks), createdBy: u }) },
    { name: "operation-due-rules", table: operationDueRules, schema: ruleInput, write: "manage" as const, values: (data: z.infer<typeof ruleInput>, p: z.infer<typeof paramsSchema>) => ({ workspaceId: p.workspaceId, farmId: p.farmId, seasonId: blankToNull(data.seasonId), plotId: blankToNull(data.plotId), activityType: data.activityType, activityCategory: blankToNull(data.activityCategory), productId: blankToNull(data.productId), intervalDays: data.intervalDays, dueSoonDays: data.dueSoonDays, active: data.active, notes: blankToNull(data.notes) }) },
  ];

  for (const resource of crud) {
    app.get(`/v1/workspace/:workspaceId/farms/:farmId/farm-operations/${resource.name}`, { preHandler: requireUser }, async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!request.appUser || !params.success) return reply.code(400).send({ message: "Valid farm context is required." });
      if (!(await ensureScope(reply, request, params.data.workspaceId, params.data.farmId, "read"))) return reply;
      const records = await db.select().from(resource.table).where(and(eq(resource.table.workspaceId, params.data.workspaceId), eq(resource.table.farmId, params.data.farmId))).orderBy(desc(resource.table.updatedAt));
      return { records };
    });

    app.post(`/v1/workspace/:workspaceId/farms/:farmId/farm-operations/${resource.name}`, { preHandler: requireUser }, async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      const input = resource.schema.safeParse(request.body);
      if (!request.appUser || !params.success || !input.success) return reply.code(400).send({ message: "Valid farm operation details are required.", fields: input.success ? [] : Object.keys(input.error.flatten().fieldErrors) });
      if (!(await ensureScope(reply, request, params.data.workspaceId, params.data.farmId, resource.write))) return reply;
      const seasonId = "seasonId" in input.data ? blankToNull(input.data.seasonId as string | null | undefined) : null;
      if (!(await seasonExists(params.data.workspaceId, params.data.farmId, seasonId))) return reply.code(400).send({ message: "Season must belong to the selected farm and workspace." });
      if (resource.name === "features") {
        const feature = input.data as z.infer<typeof featureInput>;
        if (!validGeoJsonForFeature(feature.featureType, feature.geojson)) return reply.code(400).send({ message: "GeoJSON geometry does not match this feature type." });
      }
      const [record] = await db.insert(resource.table).values(resource.values(input.data as never, params.data, request.appUser.id) as never).returning();
      return reply.code(201).send({ record });
    });

    app.patch(`/v1/workspace/:workspaceId/farms/:farmId/farm-operations/${resource.name}/:id`, { preHandler: requireUser }, async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      const input = resource.schema.safeParse(request.body);
      if (!request.appUser || !params.success || !input.success) return reply.code(400).send({ message: "Valid farm operation details are required.", fields: input.success ? [] : Object.keys(input.error.flatten().fieldErrors) });
      if (!(await ensureScope(reply, request, params.data.workspaceId, params.data.farmId, resource.write))) return reply;
      const seasonId = "seasonId" in input.data ? blankToNull(input.data.seasonId as string | null | undefined) : null;
      if (!(await seasonExists(params.data.workspaceId, params.data.farmId, seasonId))) return reply.code(400).send({ message: "Season must belong to the selected farm and workspace." });
      if (resource.name === "features") {
        const feature = input.data as z.infer<typeof featureInput>;
        if (!validGeoJsonForFeature(feature.featureType, feature.geojson)) return reply.code(400).send({ message: "GeoJSON geometry does not match this feature type." });
      }
      const [record] = await db.update(resource.table).set({ ...resource.values(input.data as never, params.data, request.appUser.id), updatedAt: new Date() } as never)
        .where(and(eq(resource.table.id, params.data.id), eq(resource.table.workspaceId, params.data.workspaceId), eq(resource.table.farmId, params.data.farmId))).returning();
      if (!record) return reply.code(404).send({ message: "Record not found." });
      return { record };
    });

    app.delete(`/v1/workspace/:workspaceId/farms/:farmId/farm-operations/${resource.name}/:id`, { preHandler: requireUser }, async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      if (!request.appUser || !params.success) return reply.code(400).send({ message: "Valid record id is required." });
      if (!(await ensureScope(reply, request, params.data.workspaceId, params.data.farmId, "manage"))) return reply;
      const linkedCount = await countLinkedRecords(resource.name, params.data.workspaceId, params.data.farmId, params.data.id);
      if (linkedCount > 0 && ["plots", "irrigation-lines", "valves", "features", "water-assets"].includes(resource.name)) {
        return reply.code(409).send({ message: "This record has linked map or history records. Deactivate it instead of deleting.", linkedCount });
      }
      const [record] = await db.delete(resource.table)
        .where(and(eq(resource.table.id, params.data.id), eq(resource.table.workspaceId, params.data.workspaceId), eq(resource.table.farmId, params.data.farmId)))
        .returning({ id: resource.table.id });
      if (!record) return reply.code(404).send({ message: "Record not found." });
      return reply.code(204).send();
    });
  }

  app.post("/v1/workspace/:workspaceId/farms/:farmId/farm-operations/products", { preHandler: requireUser }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const input = productInput.safeParse(request.body);
    if (!request.appUser || !params.success || !input.success) return reply.code(400).send({ message: "Valid product details are required." });
    if (!(await ensureScope(reply, request, params.data.workspaceId, params.data.farmId, "manage"))) return reply;
    const [record] = await db.insert(farmProducts).values({ workspaceId: params.data.workspaceId, productType: input.data.productType, category: blankToNull(input.data.category), productName: input.data.productName, unit: blankToNull(input.data.unit), notes: blankToNull(input.data.notes), active: input.data.active }).returning();
    return reply.code(201).send({ record });
  });

  app.patch("/v1/workspace/:workspaceId/farms/:farmId/farm-operations/products/:id", { preHandler: requireUser }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    const input = productInput.safeParse(request.body);
    if (!request.appUser || !params.success || !input.success) return reply.code(400).send({ message: "Valid product details are required." });
    if (!(await ensureScope(reply, request, params.data.workspaceId, params.data.farmId, "manage"))) return reply;
    const [record] = await db.update(farmProducts).set({
      productType: input.data.productType,
      category: blankToNull(input.data.category),
      productName: input.data.productName,
      unit: blankToNull(input.data.unit),
      notes: blankToNull(input.data.notes),
      active: input.data.active,
      updatedAt: new Date(),
    }).where(and(eq(farmProducts.id, params.data.id), eq(farmProducts.workspaceId, params.data.workspaceId))).returning();
    if (!record) return reply.code(404).send({ message: "Product not found." });
    return { record };
  });

  app.delete("/v1/workspace/:workspaceId/farms/:farmId/farm-operations/products/:id", { preHandler: requireUser }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!request.appUser || !params.success) return reply.code(400).send({ message: "Valid product id is required." });
    if (!(await ensureScope(reply, request, params.data.workspaceId, params.data.farmId, "manage"))) return reply;
    const [record] = await db.delete(farmProducts).where(and(eq(farmProducts.id, params.data.id), eq(farmProducts.workspaceId, params.data.workspaceId))).returning({ id: farmProducts.id });
    if (!record) return reply.code(404).send({ message: "Product not found." });
    return reply.code(204).send();
  });
}
