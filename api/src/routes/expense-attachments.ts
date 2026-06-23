import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { requirePermission } from "../auth.js";
import { db } from "../db/client.js";
import { expenseAttachments, operationalRecords } from "../db/schema.js";

const allowedTypes = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["application/pdf", "pdf"],
]);
const maxFileSize = 10 * 1024 * 1024;
const uploadRoot = path.resolve(process.cwd(), "uploads", "expense-receipts");

const paramsSchema = z.object({
  workspaceId: z.string().uuid(),
  expenseId: z.string().uuid(),
});
const attachmentParamsSchema = paramsSchema.extend({ attachmentId: z.string().uuid() });
const uploadSchema = z.object({
  farmId: z.string().uuid().nullable().optional(),
  seasonId: z.string().uuid().nullable().optional(),
  fileName: z.string().min(1).max(180),
  fileType: z.string().min(1),
  fileSize: z.number().int().positive().max(maxFileSize),
  contentBase64: z.string().min(1),
});

const sanitizeFileName = (value: string) => value.replace(/[^\w.\-() ]+/g, "_").slice(0, 180) || "receipt";
const contentBuffer = (base64: string) => Buffer.from(base64.replace(/^data:[^;]+;base64,/, ""), "base64");

async function findExpense(workspaceId: string, expenseId: string) {
  const [record] = await db.select({
    id: operationalRecords.id,
    farmId: operationalRecords.farmId,
    seasonId: operationalRecords.seasonId,
  }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, workspaceId),
    eq(operationalRecords.entityType, "voucher"),
    eq(operationalRecords.clientRecordId, expenseId),
  )).limit(1);
  return record;
}

export async function expenseAttachmentRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/workspace/:workspaceId/expenses/:expenseId/attachments", { preHandler: requirePermission("VIEW_REPORTS", (request) => (request.params as { workspaceId?: string }).workspaceId) }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: "Valid workspace and expense IDs are required." });
    const expense = await findExpense(params.data.workspaceId, params.data.expenseId);
    if (!expense) return reply.code(404).send({ message: "Expense voucher not found." });
    const records = await db.select().from(expenseAttachments).where(and(
      eq(expenseAttachments.workspaceId, params.data.workspaceId),
      eq(expenseAttachments.expenseId, params.data.expenseId),
      isNull(expenseAttachments.deletedAt),
    ));
    return { attachments: records };
  });

  app.post("/v1/workspace/:workspaceId/expenses/:expenseId/attachments", { preHandler: requirePermission("SUBMIT_RECORDS", (request) => (request.params as { workspaceId?: string }).workspaceId), bodyLimit: maxFileSize + 1024 * 1024 }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = uploadSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: "A valid receipt file is required." });
    const extension = allowedTypes.get(body.data.fileType);
    if (!extension) return reply.code(400).send({ message: "Only JPG, PNG, WEBP, and PDF receipts are allowed." });
    const expense = await findExpense(params.data.workspaceId, params.data.expenseId);
    if (!expense) return reply.code(404).send({ message: "Expense voucher not found." });
    const buffer = contentBuffer(body.data.contentBase64);
    if (!buffer.length || buffer.length > maxFileSize || buffer.length !== body.data.fileSize) {
      return reply.code(400).send({ message: "Receipt file size is invalid." });
    }
    const id = randomUUID();
    const safeName = sanitizeFileName(body.data.fileName);
    const storageKey = path.join(params.data.workspaceId, params.data.expenseId, `${id}.${extension}`).replaceAll("\\", "/");
    const fullPath = path.join(uploadRoot, storageKey);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, buffer);
    const [attachment] = await db.insert(expenseAttachments).values({
      id,
      workspaceId: params.data.workspaceId,
      farmId: body.data.farmId ?? expense.farmId,
      seasonId: body.data.seasonId ?? expense.seasonId,
      expenseId: params.data.expenseId,
      fileName: safeName,
      fileType: body.data.fileType,
      fileSize: buffer.length,
      storageKey,
      uploadedBy: request.appUser!.id,
    }).returning();
    return { attachment };
  });

  app.get("/v1/workspace/:workspaceId/expenses/:expenseId/attachments/:attachmentId/download", { preHandler: requirePermission("VIEW_REPORTS", (request) => (request.params as { workspaceId?: string }).workspaceId) }, async (request, reply) => {
    const params = attachmentParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: "Valid attachment details are required." });
    const [attachment] = await db.select().from(expenseAttachments).where(and(
      eq(expenseAttachments.id, params.data.attachmentId),
      eq(expenseAttachments.workspaceId, params.data.workspaceId),
      eq(expenseAttachments.expenseId, params.data.expenseId),
      isNull(expenseAttachments.deletedAt),
    )).limit(1);
    if (!attachment) return reply.code(404).send({ message: "Receipt attachment not found." });
    const buffer = await readFile(path.join(uploadRoot, attachment.storageKey));
    return reply.header("Content-Type", attachment.fileType)
      .header("Content-Disposition", `inline; filename="${attachment.fileName.replaceAll("\"", "")}"`)
      .send(buffer);
  });

  app.delete("/v1/workspace/:workspaceId/expenses/:expenseId/attachments/:attachmentId", { preHandler: requirePermission("MANAGE_RECORDS", (request) => (request.params as { workspaceId?: string }).workspaceId) }, async (request, reply) => {
    const params = attachmentParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: "Valid attachment details are required." });
    const [attachment] = await db.update(expenseAttachments).set({ deletedAt: new Date() }).where(and(
      eq(expenseAttachments.id, params.data.attachmentId),
      eq(expenseAttachments.workspaceId, params.data.workspaceId),
      eq(expenseAttachments.expenseId, params.data.expenseId),
      isNull(expenseAttachments.deletedAt),
    )).returning();
    if (!attachment) return reply.code(404).send({ message: "Receipt attachment not found." });
    await unlink(path.join(uploadRoot, attachment.storageKey)).catch(() => undefined);
    return reply.code(204).send();
  });

  app.post("/v1/workspace/:workspaceId/expenses/:expenseId/attachments/:attachmentId/ocr", { preHandler: requirePermission("SUBMIT_RECORDS", (request) => (request.params as { workspaceId?: string }).workspaceId) }, async (request, reply) => {
    const params = attachmentParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: "Valid attachment details are required." });
    const [attachment] = await db.select({ id: expenseAttachments.id }).from(expenseAttachments).where(and(
      eq(expenseAttachments.id, params.data.attachmentId),
      eq(expenseAttachments.workspaceId, params.data.workspaceId),
      eq(expenseAttachments.expenseId, params.data.expenseId),
      isNull(expenseAttachments.deletedAt),
    )).limit(1);
    if (!attachment) return reply.code(404).send({ message: "Receipt attachment not found." });
    return {
      confidence: "low",
      message: "Could not extract receipt clearly. Please enter expense manually.",
      suggested: null,
      lineItems: [],
    };
  });
}
