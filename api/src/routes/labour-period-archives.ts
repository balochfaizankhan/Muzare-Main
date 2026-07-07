import type { FastifyInstance } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { db } from "../db/client.js";
import { auditLogs, labourPeriodArchiveBatches, operationalRecords, userSessions } from "../db/schema.js";
import { hasFarmAccess } from "../workspace-access.js";
import { hasModulePermission } from "../permissions.js";
import { validateTenantReferences } from "../tenant-ownership.js";
import { isDeletedOperationalPayload } from "../operational-record-state.js";

const paramsSchema = z.object({ workspaceId: z.string().uuid() });
const archiveTypeSchema = z.enum(["labour_period", "attendance", "advances_payments", "wage_settlement", "full_period"]);
const rangeSchema = z.object({ from: z.string().date().optional(), to: z.string().date().optional() });
const archiveRequestSchema = z.object({
  farmId: z.string().uuid(),
  seasonId: z.string().uuid(),
  archiveType: archiveTypeSchema,
  archiveReason: z.string().trim().min(3).max(500),
  attendanceFrom: z.string().date().optional(),
  attendanceTo: z.string().date().optional(),
  labourWorkFrom: z.string().date().optional(),
  labourWorkTo: z.string().date().optional(),
  advancesFrom: z.string().date().optional(),
  advancesTo: z.string().date().optional(),
  settlementFrom: z.string().date().optional(),
  settlementTo: z.string().date().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
const archiveIdParamsSchema = z.object({ workspaceId: z.string().uuid(), batchId: z.string().uuid() });
const restoreSchema = z.object({ confirmation: z.literal("RESTORE") });

type ArchiveRow = {
  id: string;
  clientRecordId: string;
  entityType: string;
  farmId: string | null;
  seasonId: string | null;
  payload: Record<string, unknown>;
  clientUpdatedAt: Date;
};
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function emptyPreview() {
  return {
    attendanceCount: 0,
    labourWorkCount: 0,
    advanceCount: 0,
    settlementCount: 0,
    voucherCount: 0,
    affectedLabourCount: 0,
    affectedAccounts: [] as string[],
    affectedPartners: [] as string[],
    ranges: {} as Record<string, { from: string | null; to: string | null }>,
  };
}

function normalizedString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function dateInRange(date: string | undefined, from?: string, to?: string) {
  if (!date) return false;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

function payloadDate(entityType: string, payload: Record<string, unknown>) {
  if (entityType === "attendance") return normalizedString(payload.date);
  if (entityType === "advance") return normalizedString(payload.advanceDate ?? payload.date);
  if (entityType === "labourPayment") return normalizedString(payload.date);
  if (entityType === "labourEarning") return normalizedString(payload.earningDate ?? payload.date);
  if (entityType === "productionEntry") return normalizedString(payload.date);
  if (entityType === "labourWageSettlement") return normalizedString(payload.settlementDate ?? payload.date);
  if (entityType === "voucher") return normalizedString(payload.voucherDate ?? payload.date);
  return normalizedString(payload.date);
}

function labourId(payload: Record<string, unknown>) {
  return normalizedString(payload.labourerId ?? payload.labourId);
}

function isArchivedPayload(payload: Record<string, unknown>) {
  return payload.isArchived === true || normalizedString(payload.archiveBatchId).length > 0;
}

function rangeLabel(from?: string, to?: string) {
  return { from: from ?? null, to: to ?? null };
}

async function validateContext(sessionId: string | undefined, workspaceId: string, farmId: string, seasonId: string) {
  const [session] = await db.select({
    activeFarmId: userSessions.activeFarmId,
    activeSeasonId: userSessions.activeSeasonId,
  }).from(userSessions).where(eq(userSessions.id, sessionId ?? "")).limit(1);
  return session?.activeFarmId === farmId && session.activeSeasonId === seasonId;
}

async function loadScopedArchiveRows(workspaceId: string, farmId: string, seasonId: string) {
  const rows = await db.select({
    id: operationalRecords.id,
    clientRecordId: operationalRecords.clientRecordId,
    entityType: operationalRecords.entityType,
    farmId: operationalRecords.farmId,
    seasonId: operationalRecords.seasonId,
    payload: operationalRecords.payload,
    clientUpdatedAt: operationalRecords.clientUpdatedAt,
  }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, workspaceId),
    eq(operationalRecords.farmId, farmId),
    eq(operationalRecords.seasonId, seasonId),
  )).orderBy(asc(operationalRecords.entityType), asc(operationalRecords.clientUpdatedAt));
  return rows as ArchiveRow[];
}

function buildPreview(rows: ArchiveRow[], input: z.infer<typeof archiveRequestSchema>) {
  const preview = emptyPreview();
  preview.ranges = {
    attendance: rangeLabel(input.attendanceFrom, input.attendanceTo),
    labourWork: rangeLabel(input.labourWorkFrom, input.labourWorkTo),
    advances: rangeLabel(input.advancesFrom, input.advancesTo),
    settlements: rangeLabel(input.settlementFrom, input.settlementTo),
  };

  const affectedLabour = new Set<string>();
  const affectedAccounts = new Set<string>();
  const affectedPartners = new Set<string>();
  const voucherIds = new Set<string>();

  for (const row of rows) {
    const payload = row.payload;
    if (isDeletedOperationalPayload(payload) || isArchivedPayload(payload)) continue;
    const recordDate = payloadDate(row.entityType, payload);
    const labourer = labourId(payload);
    if (labourer) affectedLabour.add(labourer);

    if (row.entityType === "attendance" && dateInRange(recordDate, input.attendanceFrom, input.attendanceTo)) {
      preview.attendanceCount += 1;
    } else if ((row.entityType === "labourEarning" || row.entityType === "productionEntry") && dateInRange(recordDate, input.labourWorkFrom, input.labourWorkTo)) {
      preview.labourWorkCount += 1;
    } else if ((row.entityType === "advance" || row.entityType === "labourPayment") && dateInRange(recordDate, input.advancesFrom, input.advancesTo)) {
      preview.advanceCount += 1;
      const accountId = normalizedString(payload.accountId ?? payload.sourceAccountId);
      if (accountId) affectedAccounts.add(accountId);
    } else if (row.entityType === "labourWageSettlement" && dateInRange(recordDate, input.settlementFrom, input.settlementTo)) {
      preview.settlementCount += 1;
      const accountId = normalizedString(payload.linkedAccountId ?? payload.accountId);
      if (accountId) affectedAccounts.add(accountId);
      const linkedVoucherId = normalizedString(payload.linkedVoucherId);
      if (linkedVoucherId) voucherIds.add(linkedVoucherId);
    }

    const voucherId = normalizedString(payload.linkedVoucherId ?? payload.voucherId);
    if (row.entityType === "voucher") {
      const linkedSettlementId = normalizedString(payload.settlementId);
      if (linkedSettlementId) voucherIds.add(row.clientRecordId);
    }
    if (row.entityType === "advance" || row.entityType === "labourPayment" || row.entityType === "labourWageSettlement") {
      const accountId = normalizedString(payload.accountId ?? payload.linkedAccountId ?? payload.sourceAccountId);
      if (accountId) affectedAccounts.add(accountId);
    }
    if (voucherId) voucherIds.add(voucherId);
    const partnerAccountId = normalizedString(payload.partnerAccountId ?? payload.fromAccountId ?? payload.toAccountId);
    if (partnerAccountId) affectedPartners.add(partnerAccountId);
  }

  preview.voucherCount = voucherIds.size;
  preview.affectedLabourCount = affectedLabour.size;
  preview.affectedAccounts = [...affectedAccounts].sort();
  preview.affectedPartners = [...affectedPartners].sort();
  return preview;
}

function buildValidation(rows: ArchiveRow[], input: z.infer<typeof archiveRequestSchema>) {
  const preview = buildPreview(rows, input);
  const issues: Array<{ code: string; message: string; count: number }> = [];
  let lockedCount = 0;
  let archivedCount = 0;
  let pendingLabourEarnings = 0;
  let missingVoucherLinks = 0;
  let accountingMissing = 0;

  for (const row of rows) {
    const payload = row.payload;
    if (isDeletedOperationalPayload(payload)) continue;
    const recordDate = payloadDate(row.entityType, payload);
    const archived = isArchivedPayload(payload);
    const locked = payload.isLocked === true;
    if (archived) archivedCount += 1;
    if (locked) lockedCount += 1;

    if (row.entityType === "labourEarning" && dateInRange(recordDate, input.labourWorkFrom, input.labourWorkTo) && payload.status === "pending_settlement") {
      pendingLabourEarnings += 1;
    }
    if (row.entityType === "labourWageSettlement" && dateInRange(recordDate, input.settlementFrom, input.settlementTo)) {
      if (payload.status === "deleted" || payload.status === "voided") {
        accountingMissing += 1;
      }
      if (!normalizedString(payload.linkedVoucherId)) missingVoucherLinks += 1;
    }
  }

  if (pendingLabourEarnings) issues.push({ code: "pending_labour_earnings", message: "Pending labour earnings must be settled before archiving.", count: pendingLabourEarnings });
  if (missingVoucherLinks) issues.push({ code: "missing_voucher_links", message: "Some wage settlements are missing linked vouchers.", count: missingVoucherLinks });
  if (accountingMissing) issues.push({ code: "accounting_mismatch", message: "Selected settlements contain accounting gaps.", count: accountingMissing });
  if (lockedCount) issues.push({ code: "locked_records", message: "Some selected records are already locked by another batch.", count: lockedCount });
  if (archivedCount) issues.push({ code: "already_archived", message: "Some selected records are already archived.", count: archivedCount });

  const blocking = issues.length > 0;
  return {
    preview,
    validationSummary: {
      blocking,
      issues,
      pendingSyncCount: 0,
      lockedCount,
      archivedCount,
      accountingMismatchCount: accountingMissing,
    },
  };
}

async function updateArchiveState(tx: DbTx, rows: ArchiveRow[], batchId: string, userId: string, archiveReason: string, archived: boolean) {
  const timestamp = new Date();
  const iso = timestamp.toISOString();
  for (const row of rows) {
    const payload = row.payload;
    if (isDeletedOperationalPayload(payload)) continue;
    const nextPayload = archived
      ? {
          ...payload,
          isArchived: true,
          archiveBatchId: batchId,
          archivedAt: iso,
          archivedBy: userId,
          archiveReason,
          isLocked: true,
          lockedAt: iso,
          lockedBy: userId,
          lockReason: archiveReason,
          updatedAt: iso,
        }
      : {
          ...payload,
          isArchived: false,
          archiveBatchId: null,
          archivedAt: null,
          archivedBy: null,
          archiveReason: null,
          isLocked: false,
          lockedAt: null,
          lockedBy: null,
          lockReason: null,
          updatedAt: iso,
        };
    await tx.update(operationalRecords).set({
      payload: nextPayload,
      clientUpdatedAt: timestamp,
      updatedAt: timestamp,
    }).where(eq(operationalRecords.id, row.id));
  }
}

export async function labourPeriodArchiveRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/workspace/:workspaceId/labour-period-archives", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser || !request.sessionId) return reply.code(401).send({ message: "A valid session is required." });
    const params = paramsSchema.safeParse(request.params);
    const query = z.object({ farmId: z.string().uuid(), seasonId: z.string().uuid() }).safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ message: "A valid archive batch request is required." });
    const { workspaceId } = params.data;
    const { farmId, seasonId } = query.data;
    if (request.appUser.workspaceId !== workspaceId) return reply.code(403).send({ message: "Select this workspace before loading archive batches." });
    if (!hasModulePermission(request.appUser, workspaceId, "reports", "view") && !hasModulePermission(request.appUser, workspaceId, "wages", "view")) {
      return reply.code(403).send({ message: "Workspace report or wage permission is required." });
    }
    if (!hasFarmAccess(request.appUser, workspaceId, farmId)) return reply.code(403).send({ message: "You do not have access to this farm." });
    if (!(await validateContext(request.sessionId, workspaceId, farmId, seasonId))) {
      return reply.code(403).send({ message: "Select this farm and season before viewing archive batches." });
    }
    const batches = await db.select().from(labourPeriodArchiveBatches).where(and(
      eq(labourPeriodArchiveBatches.workspaceId, workspaceId),
      eq(labourPeriodArchiveBatches.farmId, farmId),
      eq(labourPeriodArchiveBatches.seasonId, seasonId),
    )).orderBy(asc(labourPeriodArchiveBatches.createdAt));
    return {
      batches: batches.map((batch) => ({
        id: batch.id,
        workspaceId,
        farmId,
        seasonId,
        archiveType: batch.archiveType,
        archiveReason: batch.archiveReason,
        attendanceFrom: batch.attendanceFrom,
        attendanceTo: batch.attendanceTo,
        labourWorkFrom: batch.labourWorkFrom,
        labourWorkTo: batch.labourWorkTo,
        advancesFrom: batch.advancesFrom,
        advancesTo: batch.advancesTo,
        settlementFrom: batch.settlementFrom,
        settlementTo: batch.settlementTo,
        status: batch.status,
        metadata: batch.metadata,
        validationSummary: batch.validationSummary,
        createdAt: batch.createdAt.toISOString(),
        createdBy: batch.createdBy,
        validatedAt: batch.validatedAt?.toISOString() ?? null,
        validatedBy: batch.validatedBy,
        archivedAt: batch.archivedAt?.toISOString() ?? null,
        archivedBy: batch.archivedBy,
        restoredAt: batch.restoredAt?.toISOString() ?? null,
        restoredBy: batch.restoredBy,
        updatedAt: batch.updatedAt.toISOString(),
      })),
    };
  });

  app.post("/v1/workspace/:workspaceId/labour-period-archives/preview", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser || !request.sessionId) return reply.code(401).send({ message: "A valid session is required." });
    const params = paramsSchema.safeParse(request.params);
    const parsed = archiveRequestSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ message: "A valid archive preview request is required." });
    const { workspaceId } = params.data;
    const { farmId, seasonId } = parsed.data;
    if (request.appUser.workspaceId !== workspaceId) return reply.code(403).send({ message: "Select this workspace before previewing archive batches." });
    if (!hasModulePermission(request.appUser, workspaceId, "wages", "view") && !hasModulePermission(request.appUser, workspaceId, "reports", "view")) {
      return reply.code(403).send({ message: "Workspace report or wage permission is required." });
    }
    if (!hasFarmAccess(request.appUser, workspaceId, farmId)) return reply.code(403).send({ message: "You do not have access to this farm." });
    if (!(await validateContext(request.sessionId, workspaceId, farmId, seasonId))) {
      return reply.code(403).send({ message: "Select this farm and season before previewing archive batches." });
    }
    const ownershipError = await validateTenantReferences(workspaceId, { farmId, seasonId });
    if (ownershipError) return reply.code(403).send({ message: ownershipError });
    const rows = await loadScopedArchiveRows(workspaceId, farmId, seasonId);
    const { preview, validationSummary } = buildValidation(rows, parsed.data);
    return { preview, validationSummary, canArchive: validationSummary.blocking === false };
  });

  app.post("/v1/workspace/:workspaceId/labour-period-archives/validate", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser || !request.sessionId) return reply.code(401).send({ message: "A valid session is required." });
    const params = paramsSchema.safeParse(request.params);
    const parsed = archiveRequestSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ message: "A valid archive validation request is required." });
    const { workspaceId } = params.data;
    const { farmId, seasonId } = parsed.data;
    if (request.appUser.workspaceId !== workspaceId) return reply.code(403).send({ message: "Select this workspace before validating archive batches." });
    if (!hasModulePermission(request.appUser, workspaceId, "wages", "edit") && !hasModulePermission(request.appUser, workspaceId, "reports", "view")) {
      return reply.code(403).send({ message: "Workspace report or wage permission is required." });
    }
    if (!hasFarmAccess(request.appUser, workspaceId, farmId)) return reply.code(403).send({ message: "You do not have access to this farm." });
    if (!(await validateContext(request.sessionId, workspaceId, farmId, seasonId))) {
      return reply.code(403).send({ message: "Select this farm and season before validating archive batches." });
    }
    const ownershipError = await validateTenantReferences(workspaceId, { farmId, seasonId });
    if (ownershipError) return reply.code(403).send({ message: ownershipError });
    const rows = await loadScopedArchiveRows(workspaceId, farmId, seasonId);
    const { preview, validationSummary } = buildValidation(rows, parsed.data);
    const now = new Date();
    const insertedBatches = await db.insert(labourPeriodArchiveBatches).values({
      workspaceId,
      farmId,
      seasonId,
      archiveType: parsed.data.archiveType,
      archiveReason: parsed.data.archiveReason,
      attendanceFrom: parsed.data.attendanceFrom ?? null,
      attendanceTo: parsed.data.attendanceTo ?? null,
      labourWorkFrom: parsed.data.labourWorkFrom ?? null,
      labourWorkTo: parsed.data.labourWorkTo ?? null,
      advancesFrom: parsed.data.advancesFrom ?? null,
      advancesTo: parsed.data.advancesTo ?? null,
      settlementFrom: parsed.data.settlementFrom ?? null,
      settlementTo: parsed.data.settlementTo ?? null,
      status: "validated",
      metadata: parsed.data.metadata ?? null,
      validationSummary,
      createdBy: request.appUser.id,
      validatedAt: now,
      validatedBy: request.appUser.id,
    }).returning();
    const batch = insertedBatches[0];
    if (!batch) return reply.code(500).send({ message: "Archive batch validation failed." });
    await db.insert(auditLogs).values({
      workspaceId,
      farmId,
      userId: request.appUser.id,
      actorUserId: request.appUser.id,
      action: "labour_archive_validated",
      entityType: "labour_period_archive_batch",
      entityId: batch.id,
      details: { preview, validationSummary, archiveType: parsed.data.archiveType, archiveReason: parsed.data.archiveReason },
    });
    return {
      batch: {
        id: batch.id,
        workspaceId,
        farmId,
        seasonId,
        archiveType: batch.archiveType,
        archiveReason: batch.archiveReason,
        attendanceFrom: batch.attendanceFrom,
        attendanceTo: batch.attendanceTo,
        labourWorkFrom: batch.labourWorkFrom,
        labourWorkTo: batch.labourWorkTo,
        advancesFrom: batch.advancesFrom,
        advancesTo: batch.advancesTo,
        settlementFrom: batch.settlementFrom,
        settlementTo: batch.settlementTo,
        status: batch.status,
        metadata: batch.metadata,
        validationSummary: batch.validationSummary,
        createdAt: batch.createdAt.toISOString(),
        createdBy: batch.createdBy,
        validatedAt: batch.validatedAt?.toISOString() ?? null,
        validatedBy: batch.validatedBy,
        archivedAt: batch.archivedAt?.toISOString() ?? null,
        archivedBy: batch.archivedBy,
        restoredAt: batch.restoredAt?.toISOString() ?? null,
        restoredBy: batch.restoredBy,
        updatedAt: batch.updatedAt.toISOString(),
      },
      preview,
      validationSummary,
    };
  });

  app.post("/v1/workspace/:workspaceId/labour-period-archives/:batchId/archive", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser || !request.sessionId) return reply.code(401).send({ message: "A valid session is required." });
    const params = archiveIdParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: "A valid archive batch is required." });
    const { workspaceId, batchId } = params.data;
    if (request.appUser.workspaceId !== workspaceId) return reply.code(403).send({ message: "Select this workspace before archiving records." });
    if (!hasModulePermission(request.appUser, workspaceId, "wages", "edit") && !hasModulePermission(request.appUser, workspaceId, "reports", "view")) {
      return reply.code(403).send({ message: "Workspace report or wage permission is required." });
    }
    const selectedBatches = await db.select().from(labourPeriodArchiveBatches).where(and(
      eq(labourPeriodArchiveBatches.workspaceId, workspaceId),
      eq(labourPeriodArchiveBatches.id, batchId),
    )).limit(1);
    const batch = selectedBatches[0];
    if (!batch) return reply.code(404).send({ message: "Archive batch was not found." });
    if (!(await validateContext(request.sessionId, workspaceId, batch.farmId, batch.seasonId))) {
      return reply.code(403).send({ message: "Select this farm and season before archiving records." });
    }
    const rows = await loadScopedArchiveRows(workspaceId, batch.farmId, batch.seasonId);
    const { validationSummary } = buildValidation(rows, {
      farmId: batch.farmId,
      seasonId: batch.seasonId,
      archiveType: batch.archiveType,
      archiveReason: batch.archiveReason,
      attendanceFrom: batch.attendanceFrom ?? undefined,
      attendanceTo: batch.attendanceTo ?? undefined,
      labourWorkFrom: batch.labourWorkFrom ?? undefined,
      labourWorkTo: batch.labourWorkTo ?? undefined,
      advancesFrom: batch.advancesFrom ?? undefined,
      advancesTo: batch.advancesTo ?? undefined,
      settlementFrom: batch.settlementFrom ?? undefined,
      settlementTo: batch.settlementTo ?? undefined,
      metadata: batch.metadata ?? undefined,
    });
    if (validationSummary.blocking) {
      return reply.code(409).send({ message: "Archive is blocked until validation issues are resolved.", validationSummary });
    }
    const selection = rows.filter((row) => {
      const payload = row.payload;
      if (isDeletedOperationalPayload(payload) || isArchivedPayload(payload)) return false;
      const recordDate = payloadDate(row.entityType, payload);
      if (row.entityType === "attendance") return dateInRange(recordDate, batch.attendanceFrom ?? undefined, batch.attendanceTo ?? undefined);
      if (row.entityType === "labourEarning" || row.entityType === "productionEntry") return dateInRange(recordDate, batch.labourWorkFrom ?? undefined, batch.labourWorkTo ?? undefined);
      if (row.entityType === "advance" || row.entityType === "labourPayment") return dateInRange(recordDate, batch.advancesFrom ?? undefined, batch.advancesTo ?? undefined);
      if (row.entityType === "labourWageSettlement") return dateInRange(recordDate, batch.settlementFrom ?? undefined, batch.settlementTo ?? undefined);
      if (row.entityType === "voucher") return normalizedString(payload.settlementId).length > 0;
      return false;
    });
    await db.transaction(async (tx) => {
      await updateArchiveState(tx, selection, batch.id, request.appUser!.id, batch.archiveReason, true);
      await tx.update(labourPeriodArchiveBatches).set({
        status: "archived",
        archivedAt: new Date(),
        archivedBy: request.appUser!.id,
        validationSummary,
        updatedAt: new Date(),
      }).where(eq(labourPeriodArchiveBatches.id, batch.id));
      await tx.insert(auditLogs).values({
        workspaceId,
        farmId: batch.farmId,
        userId: request.appUser!.id,
        actorUserId: request.appUser!.id,
        action: "labour_archive_completed",
        entityType: "labour_period_archive_batch",
        entityId: batch.id,
        details: { recordCount: selection.length, validationSummary },
      });
    });
    return { batchId, archivedCount: selection.length, validationSummary };
  });

  app.post("/v1/workspace/:workspaceId/labour-period-archives/:batchId/restore", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser || !request.sessionId) return reply.code(401).send({ message: "A valid session is required." });
    const params = archiveIdParamsSchema.safeParse(request.params);
    const body = restoreSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: "A valid restore request is required." });
    const { workspaceId, batchId } = params.data;
    if (request.appUser.workspaceId !== workspaceId) return reply.code(403).send({ message: "Select this workspace before restoring archive batches." });
    if (!hasModulePermission(request.appUser, workspaceId, "wages", "edit") && !hasModulePermission(request.appUser, workspaceId, "reports", "view")) {
      return reply.code(403).send({ message: "Workspace report or wage permission is required." });
    }
    const restoreBatches = await db.select().from(labourPeriodArchiveBatches).where(and(
      eq(labourPeriodArchiveBatches.workspaceId, workspaceId),
      eq(labourPeriodArchiveBatches.id, batchId),
    )).limit(1);
    const batch = restoreBatches[0];
    if (!batch) return reply.code(404).send({ message: "Archive batch was not found." });
    const rows = await loadScopedArchiveRows(workspaceId, batch.farmId, batch.seasonId);
    const selection = rows.filter((row) => normalizedString(row.payload.archiveBatchId) === batch.id);
    await db.transaction(async (tx) => {
      await updateArchiveState(tx, selection, batch.id, request.appUser!.id, batch.archiveReason, false);
      await tx.update(labourPeriodArchiveBatches).set({
        status: "restored",
        restoredAt: new Date(),
        restoredBy: request.appUser!.id,
        updatedAt: new Date(),
      }).where(eq(labourPeriodArchiveBatches.id, batch.id));
      await tx.insert(auditLogs).values({
        workspaceId,
        farmId: batch.farmId,
        userId: request.appUser!.id,
        actorUserId: request.appUser!.id,
        action: "labour_archive_restored",
        entityType: "labour_period_archive_batch",
        entityId: batch.id,
        details: { recordCount: selection.length },
      });
    });
    return { batchId, restoredCount: selection.length };
  });
}
