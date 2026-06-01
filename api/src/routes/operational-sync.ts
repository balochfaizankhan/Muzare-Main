import type { FastifyInstance } from "fastify";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { requireUser, type AuthenticatedUser } from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";
import { auditLogs, expenseVoucherSequences, operationalRecords, userSessions } from "../db/schema.js";
import { hasPermission } from "../permissions.js";
import { validateTenantReferences } from "../tenant-ownership.js";
import { resolveExpenseCategory } from "./expense-categories.js";

const entities = [
  "labourer",
  "labourGroup",
  "attendance",
  "account",
  "advance",
  "labourPayment",
  "productionEntry",
  "dispatch",
  "sale",
  "voucher",
  "partnerEntry",
  "inventoryEntry",
] as const;
const recordSchema = z.object({
  workspaceId: z.string().uuid(),
  farmId: z.string().uuid().nullable().optional(),
  seasonId: z.string().uuid().nullable().optional(),
  entity: z.enum(entities),
  record: z.object({
    id: z.string().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }).passthrough(),
});
const attendanceDeleteSchema = z.object({
  workspaceId: z.string().uuid(),
  farmId: z.string().uuid(),
  seasonId: z.string().uuid(),
  entity: z.literal("attendance"),
  recordId: z.string().min(1),
});
const partnerEntryDeleteSchema = z.object({
  workspaceId: z.string().uuid(),
  farmId: z.string().uuid(),
  seasonId: z.string().uuid(),
  entity: z.literal("partnerEntry"),
  recordId: z.string().min(1),
  reason: z.string().trim().max(500).optional(),
});
const deleteRecordSchema = z.discriminatedUnion("entity", [attendanceDeleteSchema, partnerEntryDeleteSchema]);
const partnerEntryBaseSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.coerce.number().positive(),
  notes: z.string().optional(),
});
const partnerEntryPayloadSchema = z.discriminatedUnion("type", [
  partnerEntryBaseSchema.extend({
    type: z.enum(["contribution", "withdrawal"]),
    partnerName: z.string().trim().min(1),
    accountId: z.string().min(1),
  }).passthrough(),
  partnerEntryBaseSchema.extend({
    type: z.literal("settlement"),
    fromPartner: z.string().trim().min(1),
    toPartner: z.string().trim().min(1),
  }).refine((record) => record.fromPartner.toLowerCase() !== record.toPartner.toLowerCase(), {
    message: "Settlement partners must be different.",
  }).passthrough(),
]);
const localRecords = new Map<string, z.infer<typeof recordSchema>>();

function requireWorkspaceWrite(user: AuthenticatedUser, workspaceId: string) {
  return hasPermission(user, "SUBMIT_RECORDS", workspaceId);
}

function requireEntityWrite(user: AuthenticatedUser, workspaceId: string, entity: typeof entities[number]) {
  return !["labourer", "account"].includes(entity) || hasPermission(user, "MANAGE_RECORDS", workspaceId);
}

const seasonRequiredEntities = new Set<typeof entities[number]>([
  "attendance",
  "advance",
  "labourPayment",
  "productionEntry",
  "dispatch",
  "sale",
  "voucher",
  "partnerEntry",
  "inventoryEntry",
]);

async function sessionContext(sessionId?: string) {
  if (!sessionId) return null;
  const [session] = await db.select({ activeFarmId: userSessions.activeFarmId, activeSeasonId: userSessions.activeSeasonId })
    .from(userSessions).where(eq(userSessions.id, sessionId)).limit(1);
  return session ?? null;
}

function voucherScopeKey(farmId: string, seasonId?: string | null) {
  return seasonId ? `season:${seasonId}` : `farm:${farmId}:general`;
}

async function allocateVoucherNumber(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  workspaceId: string,
  farmId: string,
  seasonId: string | null | undefined,
) {
  const [sequence] = await tx.insert(expenseVoucherSequences).values({
    workspaceId,
    scopeKey: voucherScopeKey(farmId, seasonId),
    lastNumber: 1,
  }).onConflictDoUpdate({
    target: [expenseVoucherSequences.workspaceId, expenseVoucherSequences.scopeKey],
    set: {
      lastNumber: sql`${expenseVoucherSequences.lastNumber} + 1`,
      updatedAt: new Date(),
    },
  }).returning({ lastNumber: expenseVoucherSequences.lastNumber });
  return `V-${String(sequence!.lastNumber).padStart(4, "0")}`;
}

export async function operationalSyncRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/workspace/:workspaceId/operational-records", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const parsed = z.object({ workspaceId: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success || request.appUser.workspaceId !== parsed.data.workspaceId
      || !request.appUser.memberships.some((item) => item.active && item.workspaceId === parsed.data.workspaceId)) {
      return reply.code(403).send({ message: "Workspace membership is required." });
    }
    if (localDevelopmentMode) return {
      records: [...localRecords.values()].filter((item) => item.workspaceId === parsed.data.workspaceId),
      snapshotConfirmed: true,
      farmId: null,
      seasonId: null,
    };
    const selected = await sessionContext(request.sessionId);
    if (!selected?.activeFarmId) return { records: [], snapshotConfirmed: true, farmId: null, seasonId: null };
    const records = await db.select().from(operationalRecords)
      .where(and(
        eq(operationalRecords.workspaceId, parsed.data.workspaceId),
        eq(operationalRecords.farmId, selected.activeFarmId),
        selected.activeSeasonId
          ? or(eq(operationalRecords.seasonId, selected.activeSeasonId), isNull(operationalRecords.seasonId))
          : isNull(operationalRecords.seasonId),
      ))
      .orderBy(desc(operationalRecords.updatedAt));
    return {
      snapshotConfirmed: true,
      farmId: selected.activeFarmId,
      seasonId: selected.activeSeasonId,
      records: records.map((item) => ({
        workspaceId: item.workspaceId, farmId: item.farmId, seasonId: item.seasonId, entity: item.entityType,
        record: { ...item.payload, id: item.clientRecordId, updatedAt: item.clientUpdatedAt.toISOString() },
      })),
    };
  });

  app.post("/v1/workspace/operational-records", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const parsed = recordSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "A valid operational record is required." });
    if (!requireWorkspaceWrite(request.appUser, parsed.data.workspaceId)) {
      return reply.code(403).send({ message: "Workspace record submission permission is required." });
    }
    if (!requireEntityWrite(request.appUser, parsed.data.workspaceId, parsed.data.entity)) {
      return reply.code(403).send({ message: "Workspace record management permission is required." });
    }
    if (request.appUser.workspaceId !== parsed.data.workspaceId) {
      return reply.code(403).send({ message: "Select this workspace before submitting records." });
    }
    if (parsed.data.entity === "partnerEntry" && !partnerEntryPayloadSchema.safeParse(parsed.data.record).success) {
      return reply.code(400).send({ message: "Partner ledger details are invalid. Settlements require different payer and receiver partners." });
    }
    if (localDevelopmentMode) {
      localRecords.set(`${parsed.data.workspaceId}:${parsed.data.entity}:${parsed.data.record.id}`, parsed.data);
      return { record: parsed.data.record, conflict: false };
    }
    const selected = await sessionContext(request.sessionId);
    const generalFarmExpense = parsed.data.entity === "voucher" && parsed.data.record.generalFarmExpense === true;
    const requiresSeason = seasonRequiredEntities.has(parsed.data.entity) && !generalFarmExpense;
    if (!selected?.activeFarmId || parsed.data.farmId !== selected.activeFarmId) {
      return reply.code(403).send({ message: "Select the active farm before submitting records." });
    }
    if (requiresSeason && (!selected.activeSeasonId || parsed.data.seasonId !== selected.activeSeasonId)) {
      return reply.code(403).send({ message: "Select an active season before submitting operational records." });
    }
    if (generalFarmExpense && parsed.data.seasonId) {
      return reply.code(400).send({ message: "General farm expenses must not specify a season." });
    }
    const ownershipError = await validateTenantReferences(parsed.data.workspaceId, {
      farmId: parsed.data.farmId,
      seasonId: parsed.data.seasonId,
      accountId: parsed.data.record.accountId,
      ledgerId: parsed.data.record.ledgerId,
      labourerId: parsed.data.record.labourerId,
      groupId: parsed.data.record.groupId,
    });
    if (ownershipError) return reply.code(403).send({ message: ownershipError });
    const expenseCategory = parsed.data.entity === "voucher"
      ? await resolveExpenseCategory(parsed.data.workspaceId, parsed.data.record.categoryId, parsed.data.record.subcategoryId)
      : null;
    if (parsed.data.entity === "voucher" && !expenseCategory) return reply.code(403).send({ message: "Expense category does not belong to the selected workspace." });
    let [existing] = await db.select().from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, parsed.data.workspaceId),
      eq(operationalRecords.entityType, parsed.data.entity),
      eq(operationalRecords.clientRecordId, parsed.data.record.id),
    )).limit(1);
    if (!existing && parsed.data.entity === "attendance"
      && typeof parsed.data.record.labourerId === "string" && typeof parsed.data.record.date === "string") {
      [existing] = await db.select().from(operationalRecords).where(and(
        eq(operationalRecords.workspaceId, parsed.data.workspaceId),
        eq(operationalRecords.farmId, parsed.data.farmId!),
        eq(operationalRecords.seasonId, parsed.data.seasonId!),
        eq(operationalRecords.entityType, "attendance"),
        sql`${operationalRecords.payload}->>'labourerId' = ${parsed.data.record.labourerId}`,
        sql`${operationalRecords.payload}->>'date' = ${parsed.data.record.date}`,
      )).limit(1);
    }
    if (existing && (existing.farmId !== (parsed.data.farmId ?? null) || existing.seasonId !== (parsed.data.seasonId ?? null))) {
      return reply.code(403).send({ message: "Operational record does not belong to the selected farm and season." });
    }
    if (existing && parsed.data.entity === "voucher" && !hasPermission(request.appUser, "MANAGE_RECORDS", parsed.data.workspaceId)) {
      return reply.code(403).send({ message: "Workspace record management permission is required to update expense vouchers." });
    }
    if (existing && parsed.data.entity === "partnerEntry" && !hasPermission(request.appUser, "MANAGE_RECORDS", parsed.data.workspaceId)) {
      return reply.code(403).send({ message: "Workspace record management permission is required to update partner ledger entries." });
    }
    if (existing && parsed.data.entity === "partnerEntry" && existing.payload.deletedAt) {
      return reply.code(409).send({ message: "Deleted partner ledger entries cannot be edited." });
    }
    const clientUpdatedAt = new Date(parsed.data.record.updatedAt);
    if (existing && existing.clientUpdatedAt > clientUpdatedAt) {
      await db.insert(auditLogs).values({
        workspaceId: parsed.data.workspaceId, userId: request.appUser.id, farmId: parsed.data.farmId,
        action: "sync_conflict_database_won", entityType: parsed.data.entity, entityId: existing.id,
        details: { clientRecordId: parsed.data.record.id, localUpdatedAt: parsed.data.record.updatedAt, databaseUpdatedAt: existing.clientUpdatedAt.toISOString() },
      });
      return { record: { ...existing.payload, id: existing.clientRecordId, updatedAt: existing.clientUpdatedAt.toISOString() }, conflict: true };
    }
    if (existing && existing.clientUpdatedAt.getTime() !== clientUpdatedAt.getTime()) {
      await db.insert(auditLogs).values({
        workspaceId: parsed.data.workspaceId, userId: request.appUser.id, farmId: parsed.data.farmId,
        action: "sync_conflict_newest_client_won", entityType: parsed.data.entity, entityId: existing.id,
        details: { clientRecordId: parsed.data.record.id, clientUpdatedAt: parsed.data.record.updatedAt, databaseUpdatedAt: existing.clientUpdatedAt.toISOString() },
      });
    }
    const payload = expenseCategory ? { ...parsed.data.record, ...expenseCategory } : parsed.data.record;
    const values = {
      workspaceId: parsed.data.workspaceId, farmId: parsed.data.farmId, seasonId: parsed.data.seasonId,
      clientRecordId: existing?.clientRecordId ?? parsed.data.record.id, entityType: parsed.data.entity, payload,
      recordedBy: request.appUser.id, clientUpdatedAt, updatedAt: new Date(),
    };
    const updatedPayload = existing && parsed.data.entity === "voucher"
      ? { ...payload, voucherNumber: existing.payload.voucherNumber, createdBy: existing.payload.createdBy, updatedBy: request.appUser.id }
      : existing && parsed.data.entity === "partnerEntry"
        ? { ...payload, createdBy: existing.payload.createdBy, updatedBy: request.appUser.id, deletedAt: null, deletedBy: null, deletionReason: null }
        : payload;
    const [saved] = existing
      ? parsed.data.entity === "partnerEntry"
        ? await db.transaction(async (tx) => {
            const updated = await tx.update(operationalRecords).set({ ...values, payload: updatedPayload })
              .where(eq(operationalRecords.id, existing.id)).returning();
            await tx.insert(auditLogs).values({
              workspaceId: parsed.data.workspaceId, userId: request.appUser!.id, farmId: parsed.data.farmId,
              action: "partner_ledger_updated", entityType: parsed.data.entity, entityId: existing.id,
              details: { clientRecordId: parsed.data.record.id, before: existing.payload, after: updated[0]!.payload },
            });
            return updated;
          })
        : await db.update(operationalRecords).set({ ...values, payload: updatedPayload })
          .where(eq(operationalRecords.id, existing.id)).returning()
      : await db.transaction(async (tx) => {
          const createdPayload = parsed.data.entity === "voucher"
            ? {
                ...payload,
                voucherNumber: await allocateVoucherNumber(tx, parsed.data.workspaceId, parsed.data.farmId!, parsed.data.seasonId),
                createdBy: request.appUser!.id,
                updatedBy: request.appUser!.id,
              }
            : parsed.data.entity === "partnerEntry"
              ? { ...payload, createdBy: request.appUser!.id, updatedBy: request.appUser!.id }
            : payload;
          return tx.insert(operationalRecords).values({ ...values, payload: createdPayload }).returning();
        });
    if (existing && parsed.data.entity === "voucher") {
      await db.insert(auditLogs).values({
        workspaceId: parsed.data.workspaceId, userId: request.appUser.id, farmId: parsed.data.farmId,
        action: "expense_voucher_updated", entityType: parsed.data.entity, entityId: existing.id,
        details: { clientRecordId: parsed.data.record.id, before: existing.payload, after: saved!.payload },
      });
    }
    return { record: { ...saved!.payload, id: saved!.clientRecordId, updatedAt: saved!.clientUpdatedAt.toISOString() }, conflict: false };
  });

  app.delete("/v1/workspace/operational-records", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const parsed = deleteRecordSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "A valid operational record deletion request is required." });
    if (!requireWorkspaceWrite(request.appUser, parsed.data.workspaceId)) {
      return reply.code(403).send({ message: "Workspace record submission permission is required." });
    }
    if (request.appUser.workspaceId !== parsed.data.workspaceId) {
      return reply.code(403).send({ message: "Select this workspace before deleting records." });
    }
    if (localDevelopmentMode) {
      const key = `${parsed.data.workspaceId}:${parsed.data.entity}:${parsed.data.recordId}`;
      const existing = localRecords.get(key);
      if (parsed.data.entity === "partnerEntry" && existing) {
        localRecords.set(key, { ...existing, record: { ...existing.record, deletedAt: new Date().toISOString(), deletionReason: parsed.data.reason } });
      } else {
        localRecords.delete(key);
      }
      return reply.code(204).send();
    }
    const selected = await sessionContext(request.sessionId);
    if (!selected?.activeFarmId || parsed.data.farmId !== selected.activeFarmId) {
      return reply.code(403).send({ message: "Select the active farm before deleting records." });
    }
    if (!selected.activeSeasonId || parsed.data.seasonId !== selected.activeSeasonId) {
      return reply.code(403).send({ message: "Select an active season before deleting records." });
    }
    const ownershipError = await validateTenantReferences(parsed.data.workspaceId, {
      farmId: parsed.data.farmId,
      seasonId: parsed.data.seasonId,
    });
    if (ownershipError) return reply.code(403).send({ message: ownershipError });
    if (parsed.data.entity === "partnerEntry") {
      if (!hasPermission(request.appUser, "MANAGE_RECORDS", parsed.data.workspaceId)) {
        return reply.code(403).send({ message: "Workspace record management permission is required to delete partner ledger entries." });
      }
      const [entry] = await db.select().from(operationalRecords).where(and(
        eq(operationalRecords.workspaceId, parsed.data.workspaceId),
        eq(operationalRecords.farmId, parsed.data.farmId),
        eq(operationalRecords.seasonId, parsed.data.seasonId),
        eq(operationalRecords.entityType, parsed.data.entity),
        eq(operationalRecords.clientRecordId, parsed.data.recordId),
      )).limit(1);
      if (!entry) return reply.code(204).send();
      if (entry.payload.deletedAt) return reply.code(204).send();
      const deletedAt = new Date();
      const deletionReason = parsed.data.reason ?? "";
      const payload = { ...entry.payload, deletedAt: deletedAt.toISOString(), deletedBy: request.appUser.id, deletionReason };
      await db.transaction(async (tx) => {
        await tx.update(operationalRecords).set({ payload, clientUpdatedAt: deletedAt, updatedAt: deletedAt }).where(eq(operationalRecords.id, entry.id));
        await tx.insert(auditLogs).values({
          workspaceId: parsed.data.workspaceId, userId: request.appUser!.id, farmId: parsed.data.farmId,
          action: "partner_ledger_deleted", entityType: parsed.data.entity, entityId: entry.id,
          details: { clientRecordId: parsed.data.recordId, before: entry.payload, after: payload, reason: deletionReason },
        });
      });
      return reply.code(204).send();
    }
    const [deleted] = await db.delete(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, parsed.data.workspaceId),
      eq(operationalRecords.farmId, parsed.data.farmId),
      eq(operationalRecords.seasonId, parsed.data.seasonId),
      eq(operationalRecords.entityType, parsed.data.entity),
      eq(operationalRecords.clientRecordId, parsed.data.recordId),
    )).returning({ id: operationalRecords.id });
    if (deleted) {
      await db.insert(auditLogs).values({
        workspaceId: parsed.data.workspaceId, userId: request.appUser.id, farmId: parsed.data.farmId,
        action: "attendance_unmarked", entityType: parsed.data.entity, entityId: deleted.id,
        details: { clientRecordId: parsed.data.recordId },
      });
    }
    return reply.code(204).send();
  });
}
