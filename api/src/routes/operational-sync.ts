import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { requireUser, type AuthenticatedUser } from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";
import { auditLogs, expenseVoucherSequences, operationalRecords, userSessions } from "../db/schema.js";
import { activeOperationalPayloadSql, isDeletedOperationalPayload } from "../operational-record-state.js";
import {
  canonicalImportedVoucherNumber,
  hasExplicitVoucherNumberEdit,
  isImportedVoucherPayload,
  resolveVoucherPayloadForWrite,
  stripVoucherNumberControlFields,
  wasImportedVoucherNumberEdited,
} from "../lib/import-voucher-numbers.js";
import { findWageRateOverlaps, normalizeWageRatePayload } from "../lib/wage-rates.js";
import { hasModulePermission, hasPermission, type WorkspaceModule } from "../permissions.js";
import { validateTenantReferences, validateTenantReferencesDetailed } from "../tenant-ownership.js";
import { validateExpenseCategoryReference } from "./expense-categories.js";
import { asPayloadRecord, resolveWorkspaceContext } from "./workspace-context.js";
import { allowedFarmIdsForWorkspace, hasFarmAccess } from "../workspace-access.js";

const entities = [
  "labourer",
  "labourGroup",
  "attendance",
  "account",
  "advance",
  "wageRate",
  "labourPayment",
  "productionEntry",
  "vehicle",
  "dateType",
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
const financialDeleteSchema = z.object({
  workspaceId: z.string().uuid(),
  farmId: z.string().uuid(),
  seasonId: z.string().uuid().nullable(),
  entity: z.enum(["partnerEntry", "advance", "voucher"]),
  recordId: z.string().min(1),
  reason: z.string().trim().max(500).optional(),
});
const operationalDeleteSchema = z.object({
  workspaceId: z.string().uuid(),
  farmId: z.string().uuid(),
  seasonId: z.string().uuid(),
  entity: z.enum(["dispatch", "vehicle", "dateType"]),
  recordId: z.string().min(1),
  reason: z.string().trim().max(500).optional(),
});
const deleteRecordSchema = z.union([attendanceDeleteSchema, financialDeleteSchema, operationalDeleteSchema]);
const dateSchema = z.string().date();
const positiveAmountSchema = z.coerce.number().positive();
const partnerEntryBaseSchema = z.object({
  date: dateSchema,
  amount: positiveAmountSchema,
  notes: z.string().optional(),
});
const partnerEntryPayloadSchema = z.discriminatedUnion("type", [
  partnerEntryBaseSchema.extend({
    type: z.enum(["contribution", "withdrawal"]),
    partnerName: z.string().trim().min(1),
    accountId: z.string().min(1),
    partnerAccountId: z.string().min(1).optional(),
  }).passthrough(),
  partnerEntryBaseSchema.extend({
    type: z.literal("settlement"),
    fromAccountId: z.string().min(1),
    toAccountId: z.string().min(1),
    fromPartner: z.string().trim().min(1),
    toPartner: z.string().trim().min(1),
  }).refine((record) => record.fromAccountId !== record.toAccountId, {
    message: "Settlement accounts must be different.",
  }).passthrough(),
  partnerEntryBaseSchema.extend({
    type: z.literal("adjustment"),
    partnerName: z.string().trim().min(1),
    partnerAccountId: z.string().min(1).optional(),
    adjustmentDirection: z.enum(["increase", "decrease"]),
  }).passthrough(),
]);
const financialPayloadSchemas = {
  sale: z.object({
    saleType: z.enum(["dispatch_sale", "farm_direct_sale"]).optional(),
    date: dateSchema,
    buyerName: z.string().trim().optional(),
    invoiceNumber: z.string().trim().optional(),
    produceType: z.string().trim().min(1),
    quantity: positiveAmountSchema,
    unitPrice: z.coerce.number().nonnegative(),
    amount: positiveAmountSchema,
    accountId: z.string().min(1),
    dispatchId: z.string().min(1).optional(),
    dispatchItemId: z.string().min(1).optional(),
    dispatchDate: dateSchema.optional(),
    deliveryDate: dateSchema.optional(),
    paymentDate: dateSchema.optional(),
    paymentStatus: z.enum(["paid", "partial", "unpaid"]).optional(),
    paymentReceived: z.coerce.number().nonnegative().optional(),
    vehicleId: z.string().min(1).optional(),
    vehicleNumber: z.string().trim().optional(),
    dateTypeId: z.string().min(1).optional(),
    dateTypeName: z.string().trim().optional(),
    plotName: z.string().trim().optional(),
    remarks: z.string().trim().optional(),
    unit: z.string().trim().optional(),
  }).superRefine((record, context) => {
    if (Boolean(record.dispatchId) !== Boolean(record.dispatchItemId)) {
      context.addIssue({ code: "custom", message: "Dispatch sales must include both dispatchId and dispatchItemId.", path: ["dispatchId"] });
    }
    if (record.saleType === "dispatch_sale" && (!record.dispatchId || !record.dispatchItemId)) {
      context.addIssue({ code: "custom", message: "From-dispatch sales must include a dispatch item.", path: ["dispatchId"] });
    }
    if (record.saleType === "farm_direct_sale" && (record.dispatchId || record.dispatchItemId)) {
      context.addIssue({ code: "custom", message: "Direct farm sales cannot include a dispatch item.", path: ["dispatchId"] });
    }
    if (Math.abs(record.amount - (record.quantity * record.unitPrice)) > 0.01) {
      context.addIssue({ code: "custom", message: "Sale total must match quantity x unit price.", path: ["amount"] });
    }
  }).passthrough(),
  voucher: z.object({ date: dateSchema, amount: positiveAmountSchema, accountId: z.string().min(1) }).passthrough(),
  advance: z.object({
    date: dateSchema, amount: positiveAmountSchema, accountId: z.string().min(1),
    source: z.enum(["manual", "attendance_csv_import", "old_android_csv"]).optional(),
  }).passthrough(),
  wageRate: z.object({
    labourerId: z.string().min(1).optional(),
    labourId: z.string().min(1).optional(),
    rateType: z.enum(["daily", "half_day", "monthly", "custom"]).optional(),
    dailyRate: z.coerce.number().nonnegative(),
    halfDayRate: z.coerce.number().nonnegative().optional(),
    effectiveFrom: dateSchema,
    effectiveTo: dateSchema.optional().nullable(),
    notes: z.string().trim().optional(),
    active: z.boolean().optional(),
  }).refine((record) => Boolean(record.labourerId || record.labourId), {
    message: "A labour reference is required.",
    path: ["labourerId"],
  }).passthrough(),
  productionEntry: z.object({
    date: dateSchema, amount: positiveAmountSchema, units: positiveAmountSchema, unitRate: positiveAmountSchema,
  }).passthrough(),
} as const;
const masterPayloadSchemas = {
  vehicle: z.object({
    number: z.string().trim().min(1),
    driverName: z.string().optional(),
    driverPhone: z.string().optional(),
    notes: z.string().optional(),
    active: z.boolean(),
  }).passthrough(),
  dateType: z.object({
    name: z.string().trim().min(1),
    notes: z.string().optional(),
    active: z.boolean(),
  }).passthrough(),
} as const;
const dispatchPayloadSchema = z.object({
  date: dateSchema,
  vehicleId: z.string().min(1),
  serialNumber: z.string().trim().optional(),
  notes: z.string().trim().optional(),
  items: z.array(z.object({
    id: z.string().min(1),
    dateTypeId: z.string().min(1),
    cartons: z.coerce.number().int().positive(),
  })).min(1),
}).superRefine((record, context) => {
  if (new Set(record.items.map((item) => item.dateTypeId)).size !== record.items.length) {
    context.addIssue({ code: "custom", message: "A date type can only appear once in a dispatch.", path: ["items"] });
  }
}).passthrough();
const localRecords = new Map<string, z.infer<typeof recordSchema>>();

function forbiddenResponse(
  reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } },
  message: string,
  details: Record<string, unknown>,
) {
  return reply.code(403).send({ message, details });
}

function voucherValidationError(
  reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } },
  message: string,
  details: Record<string, unknown>,
) {
  return forbiddenResponse(reply, message, {
    code: "voucher_reference_validation_failed",
    ...details,
  });
}

function cleanText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function requireWorkspaceWrite(user: AuthenticatedUser, workspaceId: string) {
  return hasPermission(user, "SUBMIT_RECORDS", workspaceId);
}

function requireEntityWrite(user: AuthenticatedUser, workspaceId: string, entity: typeof entities[number]) {
  return !["labourer", "account", "vehicle", "dateType"].includes(entity) || hasPermission(user, "MANAGE_RECORDS", workspaceId);
}

function entityModule(entity: typeof entities[number]): WorkspaceModule {
  if (["labourer", "labourGroup", "labourPayment", "productionEntry"].includes(entity)) return "workforce";
  if (entity === "attendance") return "attendance";
  if (entity === "advance") return "advances";
  if (entity === "wageRate") return "wages";
  if (entity === "voucher") return "expenses";
  if (entity === "sale") return "sales";
  if (["dispatch", "vehicle", "dateType"].includes(entity)) return "dispatch";
  if (entity === "inventoryEntry") return "inventory";
  return "accounts";
}

const seasonRequiredEntities = new Set<typeof entities[number]>([
  "attendance",
  "advance",
  "wageRate",
  "labourPayment",
  "productionEntry",
  "vehicle",
  "dateType",
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

function parseVoucherSequenceNumber(value: string) {
  const match = /^V-(\d+)$/i.exec(value.trim());
  return match ? Number(match[1]) : null;
}

function normalizeVoucherNumber(value: string) {
  const parsed = parseVoucherSequenceNumber(value);
  return parsed ? `V-${String(parsed).padStart(4, "0")}` : null;
}

function duplicateVoucherNumberDetails(workspaceId: string, voucherNumber: string, existingRecordId?: string | null) {
  return {
    code: "duplicate_voucher_number",
    entity: "voucher",
    entityId: existingRecordId ?? null,
    entityName: voucherNumber,
    workspaceId,
    expectedWorkspace: workspaceId,
    actualWorkspace: workspaceId,
  };
}

async function findExistingVoucherByNumber(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  workspaceId: string,
  farmId: string,
  voucherNumber: string,
  excludeClientRecordId?: string,
) {
  const filters = [
    eq(operationalRecords.workspaceId, workspaceId),
    eq(operationalRecords.farmId, farmId),
    eq(operationalRecords.entityType, "voucher"),
    activeOperationalPayloadSql(operationalRecords.payload),
    sql`coalesce(${operationalRecords.payload}->>'voucherNumber', '') = ${voucherNumber}`,
  ];
  if (excludeClientRecordId) filters.push(sql`${operationalRecords.clientRecordId} <> ${excludeClientRecordId}`);
  const [existingVoucher] = await tx.select({
    id: operationalRecords.id,
    clientRecordId: operationalRecords.clientRecordId,
    workspaceId: operationalRecords.workspaceId,
    farmId: operationalRecords.farmId,
    seasonId: operationalRecords.seasonId,
    sourceType: operationalRecords.sourceType,
    payload: operationalRecords.payload,
  }).from(operationalRecords).where(and(...filters)).limit(1);
  return existingVoucher ?? null;
}

async function bumpVoucherSequence(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  workspaceId: string,
  farmId: string,
  seasonId: string | null | undefined,
  voucherNumber: string,
) {
  const parsedNumber = parseVoucherSequenceNumber(voucherNumber);
  if (!parsedNumber) throw new Error("Voucher numbers must use the format V-0001.");
  const scopeKey = voucherScopeKey(farmId, seasonId);
  const [current] = await tx.select({
    lastNumber: expenseVoucherSequences.lastNumber,
  }).from(expenseVoucherSequences).where(and(
    eq(expenseVoucherSequences.workspaceId, workspaceId),
    eq(expenseVoucherSequences.scopeKey, scopeKey),
  )).limit(1);
  const nextSequenceNumber = Math.max(current?.lastNumber ?? 0, parsedNumber);
  const now = new Date();
  if (current) {
    await tx.update(expenseVoucherSequences).set({
      lastNumber: nextSequenceNumber,
      updatedAt: now,
    }).where(and(
      eq(expenseVoucherSequences.workspaceId, workspaceId),
      eq(expenseVoucherSequences.scopeKey, scopeKey),
    ));
  } else {
    await tx.insert(expenseVoucherSequences).values({
      workspaceId,
      scopeKey,
      lastNumber: nextSequenceNumber,
      updatedAt: now,
    });
  }
}

async function reserveVoucherNumber(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  workspaceId: string,
  farmId: string,
  voucherNumber: string,
  excludeClientRecordId?: string,
) {
  const scopeKey = `${workspaceId}:${farmId}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${scopeKey}), hashtext(${voucherNumber}))`);
  const existingVoucher = await findExistingVoucherByNumber(tx, workspaceId, farmId, voucherNumber, excludeClientRecordId);
  if (existingVoucher) {
    throw new Error(`Voucher number ${voucherNumber} already exists.`);
  }
}

async function allocateVoucherNumber(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  workspaceId: string,
  farmId: string,
  seasonId: string | null | undefined,
  requestedVoucherNumber?: string,
) {
  const normalizedRequestedVoucherNumber = requestedVoucherNumber ? normalizeVoucherNumber(requestedVoucherNumber) : null;
  const parsedRequestedNumber = normalizedRequestedVoucherNumber ? parseVoucherSequenceNumber(normalizedRequestedVoucherNumber) : null;
  if (requestedVoucherNumber && !normalizedRequestedVoucherNumber) {
    throw new Error("Voucher numbers must use the format V-0001.");
  }
  const scopeKey = voucherScopeKey(farmId, seasonId);
  const [current] = await tx.select({
    lastNumber: expenseVoucherSequences.lastNumber,
  }).from(expenseVoucherSequences).where(and(
    eq(expenseVoucherSequences.workspaceId, workspaceId),
    eq(expenseVoucherSequences.scopeKey, scopeKey),
  )).limit(1);
  const nextSuggested = (current?.lastNumber ?? 0) + 1;
  const finalNumber = parsedRequestedNumber ?? nextSuggested;
  const voucherNumber = normalizedRequestedVoucherNumber ?? `V-${String(finalNumber).padStart(4, "0")}`;
  await reserveVoucherNumber(tx, workspaceId, farmId, voucherNumber);
  await bumpVoucherSequence(tx, workspaceId, farmId, seasonId, voucherNumber);
  return voucherNumber;
}

async function inactiveDispatchReference(
  workspaceId: string,
  farmId: string,
  seasonId: string,
  entityType: "vehicle" | "dateType",
  ids: string[],
) {
  if (!ids.length) return false;
  const records = await db.select({ clientRecordId: operationalRecords.clientRecordId, payload: operationalRecords.payload })
    .from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.farmId, farmId),
      eq(operationalRecords.seasonId, seasonId),
      eq(operationalRecords.entityType, entityType),
      inArray(operationalRecords.clientRecordId, ids),
    ));
  return records.length !== ids.length || records.some((record) => record.payload.active === false || isDeletedOperationalPayload(record.payload));
}

async function dispatchMasterIsUsed(
  workspaceId: string,
  farmId: string,
  seasonId: string,
  entity: "vehicle" | "dateType",
  recordId: string,
) {
  const dispatches = await db.select({ payload: operationalRecords.payload }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, workspaceId),
    eq(operationalRecords.farmId, farmId),
    eq(operationalRecords.seasonId, seasonId),
    eq(operationalRecords.entityType, "dispatch"),
  ));
  return dispatches.some(({ payload }) => !isDeletedOperationalPayload(payload) && (entity === "vehicle"
    ? payload.vehicleId === recordId
    : Array.isArray(payload.items) && payload.items.some((item: { dateTypeId?: unknown }) => item.dateTypeId === recordId)));
}

async function validateLinkedDispatchSale({
  workspaceId,
  farmId,
  seasonId,
  record,
  existingRecordId,
}: {
  workspaceId: string;
  farmId: string;
  seasonId: string;
  record: Record<string, unknown>;
  existingRecordId?: string;
}) {
  const dispatchId = typeof record.dispatchId === "string" ? record.dispatchId : "";
  const dispatchItemId = typeof record.dispatchItemId === "string" ? record.dispatchItemId : "";
  const saleDate = typeof record.date === "string" ? record.date : "";
  const quantity = Number(record.quantity ?? 0);
  if (!dispatchId && !dispatchItemId) return null;
  if (!dispatchId || !dispatchItemId) return "Sales must be linked to a dispatch record.";

  const [dispatch] = await db.select({ clientRecordId: operationalRecords.clientRecordId, payload: operationalRecords.payload })
    .from(operationalRecords)
    .where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.farmId, farmId),
      eq(operationalRecords.seasonId, seasonId),
      eq(operationalRecords.entityType, "dispatch"),
      eq(operationalRecords.clientRecordId, dispatchId),
    ))
    .limit(1);
  if (!dispatch || isDeletedOperationalPayload(dispatch.payload)) return "Select an active dispatch record before recording a sale.";
  if (typeof dispatch.payload.date === "string" && saleDate < dispatch.payload.date) {
    return "Sale date cannot be earlier than the dispatch date.";
  }

  const dispatchItem = Array.isArray(dispatch.payload.items)
    ? dispatch.payload.items.find((item: { id?: unknown }) => item.id === dispatchItemId)
    : null;
  if (!dispatchItem || typeof dispatchItem.cartons !== "number") {
    return "Selected dispatch item could not be found.";
  }

  const existingSales = await db.select({ clientRecordId: operationalRecords.clientRecordId, payload: operationalRecords.payload })
    .from(operationalRecords)
    .where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.farmId, farmId),
      eq(operationalRecords.seasonId, seasonId),
      eq(operationalRecords.entityType, "sale"),
    ));
  const alreadySold = existingSales.reduce((sum, sale) => {
    if (sale.clientRecordId === existingRecordId || isDeletedOperationalPayload(sale.payload)) return sum;
    return sale.payload.dispatchId === dispatchId && sale.payload.dispatchItemId === dispatchItemId
      ? sum + Number(sale.payload.quantity ?? 0)
      : sum;
  }, 0);
  if (alreadySold + quantity > dispatchItem.cartons) {
    return "Sale quantity cannot exceed the remaining cartons on the selected dispatch.";
  }
  return null;
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
      records: [...localRecords.values()].filter((item) => item.workspaceId === parsed.data.workspaceId
        && hasModulePermission(request.appUser!, parsed.data.workspaceId, entityModule(item.entity), "view")),
      snapshotConfirmed: true,
      farmId: null,
      seasonId: null,
    };
    const selected = await resolveWorkspaceContext(parsed.data.workspaceId, request.sessionId, {
      allowedFarmIds: allowedFarmIdsForWorkspace(request.appUser, parsed.data.workspaceId),
    });
    if (!selected.activeFarmId) {
      return {
        records: [],
        snapshotConfirmed: true,
        farmId: null,
        seasonId: null,
        needsRepair: selected.needsRepair,
        contextWarning: selected.contextWarning,
        malformedRecordsSkipped: 0,
      };
    }
    const records = await db.select().from(operationalRecords)
      .where(and(
        eq(operationalRecords.workspaceId, parsed.data.workspaceId),
        eq(operationalRecords.farmId, selected.activeFarmId),
        selected.activeSeasonId
          ? or(
            eq(operationalRecords.seasonId, selected.activeSeasonId),
            isNull(operationalRecords.seasonId),
            and(eq(operationalRecords.entityType, "voucher"), eq(operationalRecords.sourceType, "expense")),
            and(eq(operationalRecords.entityType, "account"), eq(operationalRecords.sourceType, "account")),
          )
          : isNull(operationalRecords.seasonId),
      ))
      .orderBy(desc(operationalRecords.updatedAt));
    let malformedRecordsSkipped = 0;
    const visibleRecords = records
      .filter((item) => hasModulePermission(request.appUser!, parsed.data.workspaceId, entityModule(item.entityType as typeof entities[number]), "view"))
      .flatMap((item) => {
        const payload = asPayloadRecord(item.payload);
        if (!payload) {
          malformedRecordsSkipped += 1;
          return [];
        }
        return [{
          workspaceId: item.workspaceId,
          farmId: item.farmId,
          seasonId: item.seasonId,
          entity: item.entityType,
          record: { ...payload, id: item.clientRecordId, updatedAt: item.clientUpdatedAt.toISOString() },
        }];
      });
    return {
      snapshotConfirmed: true,
      farmId: selected.activeFarmId,
      seasonId: selected.activeSeasonId,
      needsRepair: selected.needsRepair,
      contextWarning: malformedRecordsSkipped
        ? `Skipped ${malformedRecordsSkipped} malformed imported records while loading operational data.`
        : selected.contextWarning,
      malformedRecordsSkipped,
      records: visibleRecords,
    };
  });

  app.get("/v1/workspace/:workspaceId/voucher-number-availability", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const parsed = z.object({
      workspaceId: z.string().uuid(),
      voucherNumber: z.string().trim().min(1),
      recordId: z.string().optional(),
      farmId: z.string().uuid().optional(),
    }).safeParse({
      ...(request.params as Record<string, unknown>),
      ...(request.query as Record<string, unknown>),
    });
    if (!parsed.success) return reply.code(400).send({ message: "Voucher number is required." });
    if (request.appUser.workspaceId !== parsed.data.workspaceId) {
      return forbiddenResponse(reply, "Select this workspace before validating voucher numbers.", {
        code: "stale_workspace_context",
        requestWorkspaceId: parsed.data.workspaceId,
        activeWorkspaceId: request.appUser.workspaceId,
      });
    }
    if (!request.appUser.memberships.some((item) => item.active && item.workspaceId === parsed.data.workspaceId)) {
      return reply.code(403).send({ message: "Workspace membership is required." });
    }
    if (!hasModulePermission(request.appUser, parsed.data.workspaceId, "expenses", "create")
      && !hasModulePermission(request.appUser, parsed.data.workspaceId, "expenses", "edit")) {
      return forbiddenResponse(reply, "Module create permission is required.", {
        code: "missing_module_permission",
        permissionKey: "expenses.create",
        entityType: "voucher",
        requestWorkspaceId: parsed.data.workspaceId,
      });
    }
    if (!request.sessionId) {
      return forbiddenResponse(reply, "Session context is required before validating voucher numbers.", {
        code: "missing_session_context",
        requestWorkspaceId: parsed.data.workspaceId,
      });
    }
    const [session] = await db.select({ activeFarmId: userSessions.activeFarmId })
      .from(userSessions).where(eq(userSessions.id, request.sessionId)).limit(1);
    const validationFarmId = parsed.data.farmId ?? session?.activeFarmId ?? null;
    if (!validationFarmId) {
      return forbiddenResponse(reply, "Select an active farm before validating voucher numbers.", {
        code: "stale_farm_context",
        requestWorkspaceId: parsed.data.workspaceId,
      });
    }
    if (!hasFarmAccess(request.appUser, parsed.data.workspaceId, validationFarmId)) {
      return forbiddenResponse(reply, "You do not have access to this farm.", {
        code: "farm_access_denied",
        requestWorkspaceId: parsed.data.workspaceId,
        farmId: validationFarmId,
      });
    }
    const normalized = normalizeVoucherNumber(parsed.data.voucherNumber);
    if (!normalized) {
      return reply.code(400).send({
        message: "Voucher numbers must use the format V-0001.",
        details: { code: "invalid_voucher_number", voucherNumber: parsed.data.voucherNumber },
      });
    }
    const existingVoucher = await db.transaction(async (tx) => findExistingVoucherByNumber(
      tx,
      parsed.data.workspaceId,
      validationFarmId,
      normalized,
      parsed.data.recordId,
    ));
    const records = await db.select({
      payload: operationalRecords.payload,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, parsed.data.workspaceId),
      eq(operationalRecords.farmId, validationFarmId),
      eq(operationalRecords.entityType, "voucher"),
      activeOperationalPayloadSql(operationalRecords.payload),
    ));
    const highest = records.reduce((max, record) => {
      const value = typeof record.payload.voucherNumber === "string" ? record.payload.voucherNumber : "";
      const parsedNumber = parseVoucherSequenceNumber(value);
      return parsedNumber ? Math.max(max, parsedNumber) : max;
    }, 0);
    return {
      voucherNumber: normalized,
      available: !existingVoucher,
      existingRecordId: existingVoucher?.clientRecordId ?? null,
      blockingVoucher: existingVoucher ? {
        id: existingVoucher.clientRecordId,
        workspaceId: existingVoucher.workspaceId,
        farmId: existingVoucher.farmId,
        seasonId: existingVoucher.seasonId,
        voucherNumber: typeof existingVoucher.payload.voucherNumber === "string" ? existingVoucher.payload.voucherNumber : normalized,
        date: typeof existingVoucher.payload.date === "string" ? existingVoucher.payload.date : "",
        amount: typeof existingVoucher.payload.amount === "number" ? existingVoucher.payload.amount : Number(existingVoucher.payload.amount ?? 0),
        description: typeof existingVoucher.payload.description === "string" ? existingVoucher.payload.description : "",
        deletedAt: typeof existingVoucher.payload.deletedAt === "string" ? existingVoucher.payload.deletedAt : null,
        source: existingVoucher.sourceType === "expense" || typeof existingVoucher.payload.oldExpenseId === "string" ? "imported" : "pwa",
        oldExpenseId: typeof existingVoucher.payload.oldExpenseId === "string" ? existingVoucher.payload.oldExpenseId : null,
      } : null,
      suggestedNextVoucherNumber: `V-${String(highest + 1).padStart(4, "0")}`,
    };
  });

  app.post("/v1/workspace/operational-records", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const parsed = recordSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "A valid operational record is required." });
    if (localDevelopmentMode && parsed.data.entity === "voucher") {
      console.log("VOUCHER_SYNC_AUDIT", {
        userId: request.appUser.id,
        sessionWorkspaceId: request.appUser.workspaceId,
        requestWorkspaceId: parsed.data.workspaceId,
        requestFarmId: parsed.data.farmId ?? null,
        requestSeasonId: parsed.data.seasonId ?? null,
        entityType: parsed.data.entity,
        operation: "upsert",
      });
    }
    const membership = request.appUser.memberships.find((item) => item.workspaceId === parsed.data.workspaceId) ?? null;
    const permissionDebug = {
      selectedRole: membership?.role ?? request.appUser.role,
      membershipPermissions: membership?.permissions ?? null,
      farmAccessMode: membership?.farmAccessMode ?? null,
      effectivePermissions: {
        submitRecords: hasPermission(request.appUser, "SUBMIT_RECORDS", parsed.data.workspaceId),
        manageRecords: hasPermission(request.appUser, "MANAGE_RECORDS", parsed.data.workspaceId),
        expensesCreate: hasModulePermission(request.appUser, parsed.data.workspaceId, "expenses", "create"),
        expensesEdit: hasModulePermission(request.appUser, parsed.data.workspaceId, "expenses", "edit"),
      },
    };
    if (!requireWorkspaceWrite(request.appUser, parsed.data.workspaceId)) {
      return forbiddenResponse(reply, "Workspace record submission permission is required.", {
        code: "missing_workspace_permission",
        permissionKey: "SUBMIT_RECORDS",
        requestWorkspaceId: parsed.data.workspaceId,
        ...permissionDebug,
      });
    }
    if (!requireEntityWrite(request.appUser, parsed.data.workspaceId, parsed.data.entity)) {
      return forbiddenResponse(reply, "Workspace record management permission is required.", {
        code: "missing_workspace_permission",
        permissionKey: "MANAGE_RECORDS",
        requestWorkspaceId: parsed.data.workspaceId,
        entityType: parsed.data.entity,
        ...permissionDebug,
      });
    }
    if (request.appUser.workspaceId !== parsed.data.workspaceId) {
      return forbiddenResponse(reply, "Select this workspace before submitting records.", {
        code: "stale_workspace_context",
        requestWorkspaceId: parsed.data.workspaceId,
        activeWorkspaceId: request.appUser.workspaceId,
        entityType: parsed.data.entity,
        ...permissionDebug,
      });
    }
    const financialPayloadSchema = financialPayloadSchemas[parsed.data.entity as keyof typeof financialPayloadSchemas];
    const financialPayload = financialPayloadSchema?.safeParse(parsed.data.record);
    if (financialPayload && !financialPayload.success) {
      return reply.code(400).send({
        message: `Invalid ${parsed.data.entity} financial record.`,
        fields: financialPayload.error.issues.map((issue) => `record.${issue.path.join(".")}`),
      });
    }
    const masterPayloadSchema = masterPayloadSchemas[parsed.data.entity as keyof typeof masterPayloadSchemas];
    const masterPayload = masterPayloadSchema?.safeParse(parsed.data.record);
    if (masterPayload && !masterPayload.success) {
      return reply.code(400).send({
        message: `Invalid ${parsed.data.entity} master record.`,
        fields: masterPayload.error.issues.map((issue) => `record.${issue.path.join(".")}`),
      });
    }
    const dispatchPayload = parsed.data.entity === "dispatch" ? dispatchPayloadSchema.safeParse(parsed.data.record) : null;
    if (dispatchPayload && !dispatchPayload.success) {
      return reply.code(400).send({
        message: "Dispatch details are invalid.",
        fields: dispatchPayload.error.issues.map((issue) => `record.${issue.path.join(".")}`),
      });
    }
    const partnerEntry = parsed.data.entity === "partnerEntry" ? partnerEntryPayloadSchema.safeParse(parsed.data.record) : null;
    if (partnerEntry && !partnerEntry.success) {
      return reply.code(400).send({
        message: "Partner ledger details are invalid. Settlements require different payer and receiver accounts.",
        fields: partnerEntry.error.issues.map((issue) => `record.${issue.path.join(".")}`),
      });
    }
    if (localDevelopmentMode) {
      const key = `${parsed.data.workspaceId}:${parsed.data.entity}:${parsed.data.record.id}`;
      const action = localRecords.has(key) ? "edit" : "create";
      if (!hasModulePermission(request.appUser, parsed.data.workspaceId, entityModule(parsed.data.entity), action)) {
        return reply.code(403).send({ message: `Module ${action} permission is required.` });
      }
      localRecords.set(key, parsed.data);
      return { record: parsed.data.record, conflict: false };
    }
    const selected = await sessionContext(request.sessionId);
    const generalFarmExpense = parsed.data.entity === "voucher" && parsed.data.record.generalFarmExpense === true;
    const requiresSeason = seasonRequiredEntities.has(parsed.data.entity) && !generalFarmExpense;
    if (localDevelopmentMode && parsed.data.entity === "voucher") {
      console.log("VOUCHER_SYNC_PERMISSION_DECISION", {
        userId: request.appUser.id,
        workspaceId: parsed.data.workspaceId,
        membershipId: membership?.membershipId ?? null,
        role: membership?.role ?? request.appUser.role,
        permissions: membership?.permissions ?? null,
        farmAccessMode: membership?.farmAccessMode ?? null,
        effectivePermissions: {
          submitRecords: hasPermission(request.appUser, "SUBMIT_RECORDS", parsed.data.workspaceId),
          manageRecords: hasPermission(request.appUser, "MANAGE_RECORDS", parsed.data.workspaceId),
          expensesCreate: hasModulePermission(request.appUser, parsed.data.workspaceId, "expenses", "create"),
          expensesEdit: hasModulePermission(request.appUser, parsed.data.workspaceId, "expenses", "edit"),
        },
        activeWorkspaceId: request.appUser.workspaceId,
        activeFarmId: selected?.activeFarmId ?? null,
        activeSeasonId: selected?.activeSeasonId ?? null,
      });
    }
    if (!hasFarmAccess(request.appUser, parsed.data.workspaceId, parsed.data.farmId ?? null)) {
      return forbiddenResponse(reply, "You do not have access to this farm.", {
        code: "farm_access_denied",
        requestWorkspaceId: parsed.data.workspaceId,
        requestFarmId: parsed.data.farmId ?? null,
        farmAccessResult: false,
        ...permissionDebug,
      });
    }
    if (!selected?.activeFarmId || parsed.data.farmId !== selected.activeFarmId) {
      return forbiddenResponse(reply, "Select the active farm before submitting records.", {
        code: "stale_farm_context",
        requestWorkspaceId: parsed.data.workspaceId,
        requestFarmId: parsed.data.farmId ?? null,
        activeFarmId: selected?.activeFarmId ?? null,
        farmAccessResult: true,
        ...permissionDebug,
      });
    }
    if (requiresSeason && (!selected.activeSeasonId || parsed.data.seasonId !== selected.activeSeasonId)) {
      return forbiddenResponse(reply, "Select an active season before submitting operational records.", {
        code: "stale_season_context",
        requestWorkspaceId: parsed.data.workspaceId,
        requestSeasonId: parsed.data.seasonId ?? null,
        activeSeasonId: selected?.activeSeasonId ?? null,
        farmAccessResult: true,
        ...permissionDebug,
      });
    }
    if (generalFarmExpense && parsed.data.seasonId) {
      return reply.code(400).send({ message: "General farm expenses must not specify a season." });
    }
    const ownershipError = await validateTenantReferencesDetailed(parsed.data.workspaceId, {
      farmId: parsed.data.farmId,
      seasonId: parsed.data.seasonId,
      accountId: parsed.data.record.accountId,
      partnerAccountId: parsed.data.record.partnerAccountId,
      fromAccountId: parsed.data.record.fromAccountId,
      toAccountId: parsed.data.record.toAccountId,
      ledgerId: parsed.data.record.ledgerId,
      labourerId: parsed.data.record.labourerId ?? parsed.data.record.labourId,
      groupId: parsed.data.record.groupId,
      vehicleId: parsed.data.record.vehicleId,
      dateTypeIds: dispatchPayload?.success
        ? dispatchPayload.data.items.map((item) => item.dateTypeId)
        : undefined,
    });
    if (ownershipError) {
      if (localDevelopmentMode && parsed.data.entity === "voucher") {
        console.log("VOUCHER_VALIDATION_CHAIN", {
          stage: "tenant_references",
          failed: ownershipError,
        });
      }
      return forbiddenResponse(reply, ownershipError.message, ownershipError);
    }
    if (dispatchPayload?.success) {
      const dateTypeIds = dispatchPayload.data.items.map((item) => item.dateTypeId);
      if (await inactiveDispatchReference(parsed.data.workspaceId, parsed.data.farmId!, parsed.data.seasonId!, "vehicle", [dispatchPayload.data.vehicleId])) {
        return reply.code(403).send({ message: "Select an active vehicle from this workspace farm and season." });
      }
      if (await inactiveDispatchReference(parsed.data.workspaceId, parsed.data.farmId!, parsed.data.seasonId!, "dateType", dateTypeIds)) {
        return reply.code(403).send({ message: "Select active date types from this workspace farm and season." });
      }
    }
    let expenseCategory: Awaited<ReturnType<typeof validateExpenseCategoryReference>>["category"] = null;
    if (parsed.data.entity === "voucher") {
      const voucherItems = Array.isArray(parsed.data.record.items) ? parsed.data.record.items as Array<Record<string, unknown>> : [];
      if (localDevelopmentMode) {
        console.log("VOUCHER_VALIDATION_CHAIN", {
          stage: "start",
          workspaceId: parsed.data.workspaceId,
          farmId: parsed.data.farmId ?? null,
          seasonId: parsed.data.seasonId ?? null,
          voucherId: parsed.data.record.id,
          accountId: parsed.data.record.accountId ?? null,
          categoryId: parsed.data.record.categoryId ?? null,
          subcategoryId: parsed.data.record.subcategoryId ?? null,
          itemCount: voucherItems.length,
        });
      }
      const accountValidation = await validateTenantReferencesDetailed(parsed.data.workspaceId, {
        farmId: parsed.data.farmId,
        seasonId: parsed.data.seasonId,
        accountId: parsed.data.record.accountId,
      });
      if (accountValidation) {
        if (localDevelopmentMode) console.log("VOUCHER_VALIDATION_CHAIN", { stage: "payment_account", failed: accountValidation });
        return voucherValidationError(reply, accountValidation.message, accountValidation);
      }
      const categoryValidation = await validateExpenseCategoryReference(
        parsed.data.workspaceId,
        parsed.data.record.categoryId,
        parsed.data.record.subcategoryId,
      );
      if (categoryValidation.error) {
        if (localDevelopmentMode) console.log("VOUCHER_VALIDATION_CHAIN", { stage: "voucher_header_category", failed: categoryValidation.error });
        return voucherValidationError(reply, categoryValidation.error.message, categoryValidation.error);
      }
      expenseCategory = categoryValidation.category;
      for (const [index, item] of voucherItems.entries()) {
        const itemCategory = await validateExpenseCategoryReference(
          parsed.data.workspaceId,
          item.categoryId,
          item.subcategoryId,
        );
        if (itemCategory.error) {
          const itemError = {
            ...itemCategory.error,
            code: itemCategory.error.code,
            itemIndex: index,
            itemId: typeof item.id === "string" ? item.id : null,
            itemDescription: typeof item.description === "string" ? item.description : null,
          };
          if (localDevelopmentMode) console.log("VOUCHER_VALIDATION_CHAIN", { stage: "voucher_item_category", failed: itemError });
          return voucherValidationError(reply, itemCategory.error.message, itemError);
        }
      }
      if (localDevelopmentMode) {
        console.log("VOUCHER_VALIDATION_CHAIN", {
          stage: "completed",
          voucherId: parsed.data.record.id,
          validatedItems: voucherItems.length,
        });
      }
    }
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
    if (!existing && !hasModulePermission(request.appUser, parsed.data.workspaceId, entityModule(parsed.data.entity), "create")) {
      return forbiddenResponse(reply, "Module create permission is required.", {
        code: "missing_module_permission",
        permissionKey: `${entityModule(parsed.data.entity)}.create`,
        entityType: parsed.data.entity,
        requestWorkspaceId: parsed.data.workspaceId,
        farmAccessResult: true,
        ...permissionDebug,
      });
    }
    if (existing && !hasModulePermission(request.appUser, parsed.data.workspaceId, entityModule(parsed.data.entity), "edit")) {
      return forbiddenResponse(reply, "Module edit permission is required.", {
        code: "missing_module_permission",
        permissionKey: `${entityModule(parsed.data.entity)}.edit`,
        entityType: parsed.data.entity,
        requestWorkspaceId: parsed.data.workspaceId,
        farmAccessResult: true,
        ...permissionDebug,
      });
    }
    if (existing && parsed.data.entity === "voucher" && !hasPermission(request.appUser, "MANAGE_RECORDS", parsed.data.workspaceId)) {
      return forbiddenResponse(reply, "Workspace record management permission is required to update expense vouchers.", {
        code: "missing_workspace_permission",
        permissionKey: "MANAGE_RECORDS",
        entityType: parsed.data.entity,
        requestWorkspaceId: parsed.data.workspaceId,
        farmAccessResult: true,
        ...permissionDebug,
      });
    }
    if (existing && parsed.data.entity === "partnerEntry" && !hasPermission(request.appUser, "MANAGE_RECORDS", parsed.data.workspaceId)) {
      return reply.code(403).send({ message: "Workspace record management permission is required to update partner ledger entries." });
    }
    if (existing && ["partnerEntry", "advance", "voucher"].includes(parsed.data.entity) && isDeletedOperationalPayload(existing.payload)) {
      return reply.code(409).send({ message: "Deleted financial records cannot be edited." });
    }
    if (parsed.data.entity === "sale") {
      const saleLinkError = await validateLinkedDispatchSale({
        workspaceId: parsed.data.workspaceId,
        farmId: parsed.data.farmId!,
        seasonId: parsed.data.seasonId!,
        record: parsed.data.record,
        existingRecordId: existing?.clientRecordId,
      });
      if (saleLinkError) return reply.code(409).send({ message: saleLinkError });
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
    const payloadRecord = expenseCategory ? { ...parsed.data.record, ...expenseCategory } : parsed.data.record;
    const wageRatePayload = parsed.data.entity === "wageRate"
      ? normalizeWageRatePayload(parsed.data.record as Record<string, unknown>)
      : null;
    const payload = wageRatePayload ?? payloadRecord;
    const normalizedRequestedVoucherNumber = parsed.data.entity === "voucher" && typeof payloadRecord.voucherNumber === "string"
      ? normalizeVoucherNumber(payloadRecord.voucherNumber)
      : null;
    if (parsed.data.entity === "voucher" && typeof payloadRecord.voucherNumber === "string" && !normalizedRequestedVoucherNumber) {
      return reply.code(400).send({
        message: "Voucher numbers must use the format V-0001.",
        details: { code: "invalid_voucher_number", voucherNumber: payloadRecord.voucherNumber },
      });
    }
    if (wageRatePayload) {
      const overlaps = await db.transaction((tx) => findWageRateOverlaps(tx, {
        workspaceId: parsed.data.workspaceId,
        farmId: parsed.data.farmId!,
        seasonId: parsed.data.seasonId!,
        labourerId: wageRatePayload.labourerId,
        effectiveFrom: wageRatePayload.effectiveFrom,
        effectiveTo: wageRatePayload.effectiveTo,
        excludeClientRecordId: existing?.clientRecordId ?? null,
      }));
      if (overlaps.length) {
        return reply.code(409).send({
          message: "Wage rate overlaps an existing active rate for this labourer.",
          details: {
            code: "wage_rate_overlap",
            labourerId: wageRatePayload.labourerId,
            overlaps: overlaps.map((item) => ({
              id: item.clientRecordId,
              effectiveFrom: item.payload.effectiveFrom,
              effectiveTo: item.payload.effectiveTo,
              dailyRate: item.payload.dailyRate,
              halfDayRate: item.payload.halfDayRate,
            })),
          },
        });
      }
    }
    const values = {
      workspaceId: parsed.data.workspaceId, farmId: parsed.data.farmId, seasonId: parsed.data.seasonId,
      clientRecordId: existing?.clientRecordId ?? parsed.data.record.id, entityType: parsed.data.entity, payload,
      recordedBy: request.appUser.id, clientUpdatedAt, updatedAt: new Date(),
    };
    const updatedPayload = existing && parsed.data.entity === "partnerEntry"
        ? { ...payload, createdBy: existing.payload.createdBy, updatedBy: request.appUser.id, deletedAt: null, deletedBy: null, deletionReason: null }
        : payload;
    let saved;
    try {
      [saved] = existing
        ? parsed.data.entity === "voucher"
          ? await db.transaction(async (tx) => {
              const normalizedVoucher = resolveVoucherPayloadForWrite({
                incomingPayload: payload,
                existingPayload: existing.payload,
                sourceType: existing.sourceType,
                requestedVoucherNumber: normalizedRequestedVoucherNumber,
              });
              const voucherNumber = normalizedVoucher.resolvedVoucherNumber;
              if (!voucherNumber) throw new Error("Voucher number is required.");
              await reserveVoucherNumber(tx, parsed.data.workspaceId, parsed.data.farmId!, voucherNumber, existing.clientRecordId);
              await bumpVoucherSequence(tx, parsed.data.workspaceId, parsed.data.farmId!, parsed.data.seasonId, voucherNumber);
              if (localDevelopmentMode && normalizedVoucher.importedVoucher && !normalizedVoucher.explicitVoucherNumberEdit && normalizedRequestedVoucherNumber && normalizedVoucher.canonicalNumber && normalizedRequestedVoucherNumber !== normalizedVoucher.canonicalNumber) {
                console.warn("IMPORTED_VOUCHER_NUMBER_WRITE_BLOCKED", {
                  voucherId: existing.clientRecordId,
                  requestedVoucherNumber: normalizedRequestedVoucherNumber,
                  canonicalVoucherNumber: normalizedVoucher.canonicalNumber,
                  sourceType: existing.sourceType,
                });
              }
              const nextPayload = {
                ...normalizedVoucher.nextPayload,
                createdBy: existing.payload.createdBy ?? request.appUser!.id,
                updatedBy: request.appUser!.id,
              };
              return tx.update(operationalRecords).set({ ...values, payload: nextPayload })
                .where(eq(operationalRecords.id, existing.id)).returning();
            })
          : parsed.data.entity === "partnerEntry"
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
            let createdPayload: Record<string, unknown>;
            if (parsed.data.entity === "voucher") {
                  const normalizedVoucher = resolveVoucherPayloadForWrite({
                    incomingPayload: payloadRecord,
                    existingPayload: null,
                    sourceType: cleanText(payloadRecord.sourceType) || cleanText(payloadRecord.source_type) || null,
                    requestedVoucherNumber: normalizedRequestedVoucherNumber,
                  });
              createdPayload = {
                ...normalizedVoucher.nextPayload,
                voucherNumber: await allocateVoucherNumber(
                  tx,
                  parsed.data.workspaceId,
                  parsed.data.farmId!,
                  parsed.data.seasonId,
                  normalizedVoucher.resolvedVoucherNumber || undefined,
                ),
                createdBy: request.appUser!.id,
                updatedBy: request.appUser!.id,
              };
            } else if (parsed.data.entity === "partnerEntry") {
              createdPayload = { ...payload, createdBy: request.appUser!.id, updatedBy: request.appUser!.id };
            } else {
              createdPayload = payload;
            }
            return tx.insert(operationalRecords).values({ ...values, payload: createdPayload }).returning();
          });
    } catch (error) {
      if (error instanceof Error && parsed.data.entity === "voucher") {
        const duplicateMatch = /^Voucher number (V-\d+) already exists\.$/i.exec(error.message);
        if (duplicateMatch) {
          const duplicateVoucherNumber = duplicateMatch[1] ?? "V-0000";
          return reply.code(409).send({
            code: "duplicate_voucher_number",
            message: `Voucher number ${duplicateVoucherNumber} already exists.`,
            details: duplicateVoucherNumberDetails(parsed.data.workspaceId, duplicateVoucherNumber),
          });
        }
        return reply.code(400).send({ message: error.message });
      }
      throw error;
    }
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
    if (!hasModulePermission(request.appUser, parsed.data.workspaceId, entityModule(parsed.data.entity), "delete")) {
      return reply.code(403).send({ message: "Module delete permission is required." });
    }
    if (localDevelopmentMode) {
      const key = `${parsed.data.workspaceId}:${parsed.data.entity}:${parsed.data.recordId}`;
      const existing = localRecords.get(key);
      const softDelete = ["partnerEntry", "advance", "voucher"].includes(parsed.data.entity);
      if (softDelete && existing) {
        localRecords.set(key, { ...existing, record: { ...existing.record, deletedAt: new Date().toISOString(), deletionReason: "reason" in parsed.data ? parsed.data.reason : undefined } });
      } else {
        localRecords.delete(key);
      }
      return reply.code(204).send();
    }
    const selected = await sessionContext(request.sessionId);
    if (!hasFarmAccess(request.appUser, parsed.data.workspaceId, parsed.data.farmId)) {
      return reply.code(403).send({ message: "You do not have access to this farm." });
    }
    if (!selected?.activeFarmId || parsed.data.farmId !== selected.activeFarmId) {
      return reply.code(403).send({ message: "Select the active farm before deleting records." });
    }
    const generalFarmExpenseDelete = parsed.data.entity === "voucher" && parsed.data.seasonId === null;
    if (!generalFarmExpenseDelete && (!selected.activeSeasonId || parsed.data.seasonId !== selected.activeSeasonId)) {
      return reply.code(403).send({ message: "Select an active season before deleting records." });
    }
    const ownershipError = await validateTenantReferences(parsed.data.workspaceId, {
      farmId: parsed.data.farmId,
      seasonId: parsed.data.seasonId,
    });
    if (ownershipError) return reply.code(403).send({ message: ownershipError });
    if (parsed.data.entity !== "attendance") {
      if (!hasPermission(request.appUser, "MANAGE_RECORDS", parsed.data.workspaceId)) {
        return reply.code(403).send({ message: "Workspace record management permission is required to delete financial records." });
      }
      const [entry] = await db.select().from(operationalRecords).where(and(
        eq(operationalRecords.workspaceId, parsed.data.workspaceId),
        eq(operationalRecords.farmId, parsed.data.farmId),
        parsed.data.seasonId ? eq(operationalRecords.seasonId, parsed.data.seasonId) : isNull(operationalRecords.seasonId),
        eq(operationalRecords.entityType, parsed.data.entity),
        eq(operationalRecords.clientRecordId, parsed.data.recordId),
      )).limit(1);
      if (!entry) return reply.code(204).send();
      if ((parsed.data.entity === "vehicle" || parsed.data.entity === "dateType")
        && await dispatchMasterIsUsed(parsed.data.workspaceId, parsed.data.farmId, parsed.data.seasonId, parsed.data.entity, parsed.data.recordId)) {
        return reply.code(409).send({ message: `${parsed.data.entity === "vehicle" ? "Vehicle" : "Date type"} cannot be deleted because it is used by a dispatch.` });
      }
      if (parsed.data.entity === "dispatch" || parsed.data.entity === "vehicle" || parsed.data.entity === "dateType") {
        const [deleted] = await db.delete(operationalRecords).where(eq(operationalRecords.id, entry.id)).returning({ id: operationalRecords.id });
        if (deleted) {
          await db.insert(auditLogs).values({
            workspaceId: parsed.data.workspaceId, userId: request.appUser.id, farmId: parsed.data.farmId,
            action: `${parsed.data.entity}_deleted`, entityType: parsed.data.entity, entityId: deleted.id,
            details: { clientRecordId: parsed.data.recordId },
          });
        }
        return reply.code(204).send();
      }
      if (isDeletedOperationalPayload(entry.payload)) return reply.code(204).send();
      const deletedAt = new Date();
      const deletionReason = parsed.data.reason ?? "";
      const payload = { ...entry.payload, deletedAt: deletedAt.toISOString(), deletedBy: request.appUser.id, deletionReason };
      await db.transaction(async (tx) => {
        await tx.update(operationalRecords).set({ payload, clientUpdatedAt: deletedAt, updatedAt: deletedAt }).where(eq(operationalRecords.id, entry.id));
        await tx.insert(auditLogs).values({
          workspaceId: parsed.data.workspaceId, userId: request.appUser!.id, farmId: parsed.data.farmId,
          action: parsed.data.entity === "partnerEntry" ? "partner_ledger_deleted" : parsed.data.entity === "voucher" ? "expense_voucher_deleted" : "labour_advance_deleted",
          entityType: parsed.data.entity, entityId: entry.id,
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
