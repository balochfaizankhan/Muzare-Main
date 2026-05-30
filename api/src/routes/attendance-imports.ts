import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireUser, type AuthenticatedUser } from "../auth.js";
import { db } from "../db/client.js";
import { attendanceImportSessions, auditLogs, operationalRecords } from "../db/schema.js";
import { hasPermission } from "../permissions.js";
import { validateTenantReferences } from "../tenant-ownership.js";

const paramsSchema = z.object({ workspaceId: z.string().uuid() });
const previewSchema = z.object({
  farmId: z.string().uuid(),
  seasonId: z.string().uuid(),
  originalFilename: z.string().trim().min(1).max(255),
  csvText: z.string().min(1).max(5_000_000),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});
const mappingSchema = z.object({
  rowIndex: z.number().int().nonnegative(),
  action: z.enum(["match", "create", "skip"]),
  labourerId: z.string().min(1).optional(),
  dailyWage: z.number().nonnegative().optional(),
  group: z.string().trim().max(100).optional(),
}).superRefine((mapping, context) => {
  if (mapping.action === "match" && !mapping.labourerId) {
    context.addIssue({ code: "custom", path: ["labourerId"], message: "A labourer is required for match decisions." });
  }
});
const duplicateModeSchema = z.enum(["missing_only", "skip_existing", "update_existing", "import_missing_only"])
  .transform((mode) => mode === "import_missing_only" ? "missing_only" as const : mode);
const confirmationSchema = z.object({
  warningsAccepted: z.boolean().default(false),
  duplicateHandlingMode: duplicateModeSchema.default("missing_only"),
  labourMappings: z.array(mappingSchema).default([]),
});
const confirmSchema = z.union([
  z.object({
    importSessionId: z.string().uuid(),
    farmId: z.string().uuid(),
    seasonId: z.string().uuid(),
    confirmation: confirmationSchema,
  }).transform((input) => ({
    sessionId: input.importSessionId, farmId: input.farmId, seasonId: input.seasonId,
    warningsConfirmed: input.confirmation.warningsAccepted,
    duplicateMode: input.confirmation.duplicateHandlingMode,
    mappings: input.confirmation.labourMappings,
  })),
  z.object({
    sessionId: z.string().uuid(),
    farmId: z.string().uuid().optional(),
    seasonId: z.string().uuid().optional(),
    duplicateMode: duplicateModeSchema.default("missing_only"),
    warningsConfirmed: z.boolean().default(false),
    mappings: z.array(mappingSchema).default([]),
  }),
]);

type ImportStatus = "present" | "half_day" | "absent";
type DateCell = { column: string; date: string; status: ImportStatus | null; advanceAmount: number | null; raw: string };
type ImportRow = {
  rowIndex: number; labourName: string; cells: DateCell[]; matchedLabourerId: string | null; suggestedLabourerId: string | null;
  csvPresent: number | null; csvHalf: number | null; csvAbsent: number | null; csvAdvance: number | null;
  calculatedPresent: number; calculatedHalf: number; calculatedAbsent: number; calculatedAdvance: number;
};
type ImportPayload = { rows: ImportRow[]; dateColumns: Array<{ column: string; date: string }>; errors: string[]; warnings: string[] };
type Labour = { id: string; name: string; dailyWage: number };

const normalized = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
const stableId = (...values: Array<string | number>) => createHash("sha256").update(values.join("|")).digest("hex");
const batchSize = 500;
const chunks = <T>(values: T[]) => Array.from({ length: Math.ceil(values.length / batchSize) }, (_, index) => values.slice(index * batchSize, (index + 1) * batchSize));
const numeric = (value: string | undefined) => {
  if (!value?.trim()) return null;
  const parsed = Number(value.replaceAll(",", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
};

function parseCsv(csv: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index]!;
    const next = csv[index + 1];
    if (char === "\"" && quoted && next === "\"") {
      cell += "\""; index += 1;
    } else if (char === "\"") quoted = !quoted;
    else if (char === "," && !quoted) {
      row.push(cell); cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell); cell = "";
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
    } else cell += char;
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function parseDateColumn(value: string, from?: string, to?: string) {
  const label = value.trim();
  let year: number; let month: number; let day: number;
  let match = label.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) [, year, month, day] = match.map(Number) as [number, number, number, number];
  else {
    match = label.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{4}))?$/);
    if (!match) return null;
    day = Number(match[1]); month = Number(match[2]);
    const inferredYear = from?.slice(0, 4) ?? to?.slice(0, 4);
    if (!match[3] && !inferredYear) return null;
    year = Number(match[3] ?? inferredYear);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function parseDateCell(value: string): { status: ImportStatus | null; advanceAmount: number | null; error?: string } {
  const raw = value.trim();
  if (!raw || /^n\/a$/i.test(raw)) return { status: null, advanceAmount: null };
  const parenthesizedAdvance = raw.match(/\(\s*adv\s*:\s*(?:sar\s*)?([\d,]+(?:\.\d+)?)\s*(?:sar)?\s*\)/i);
  const valueWithoutParenthesizedAdvance = parenthesizedAdvance ? raw.replace(parenthesizedAdvance[0], "").trim() : raw;
  const statusMatch = valueWithoutParenthesizedAdvance.match(/^(present|absent|half\s*day|half|1\/2|½|p|h|a|-)/i);
  const token = statusMatch?.[1]?.toLowerCase().replace(/\s+/g, " ") ?? "";
  const status = token === "p" || token === "present" ? "present"
    : token === "h" || token === "half" || token === "half day" || token === "1/2" || token === "½" ? "half_day"
      : token === "a" || token === "absent" ? "absent" : null;
  if (parenthesizedAdvance) return { status, advanceAmount: Number(parenthesizedAdvance[1]!.replaceAll(",", "")) };
  const remainder = statusMatch ? valueWithoutParenthesizedAdvance.slice(statusMatch[0].length).replace(/^\s*\/\s*/, "").trim() : valueWithoutParenthesizedAdvance;
  if (!remainder || remainder === "-") return { status, advanceAmount: null };
  const amountText = remainder.replace(/\bSAR\b/gi, "").replaceAll(",", "").trim();
  const advanceAmount = Number(amountText);
  if (!Number.isFinite(advanceAmount) || advanceAmount < 0) return { status, advanceAmount: null, error: `Invalid daily value "${raw}".` };
  return { status, advanceAmount };
}

function levenshtein(left: string, right: string) {
  const previous = [...Array(right.length + 1).keys()];
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(current[column - 1]! + 1, previous[column]! + 1, previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1));
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length]!;
}

function labourPayload(record: typeof operationalRecords.$inferSelect): Labour {
  const payload = record.payload;
  return { id: record.clientRecordId, name: String(payload.name ?? "Labourer"), dailyWage: Number(payload.dailyWage) || 0 };
}

async function selectedLabourers(workspaceId: string, farmId: string) {
  return (await db.select().from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, workspaceId), eq(operationalRecords.farmId, farmId), eq(operationalRecords.entityType, "labourer"),
  ))).map(labourPayload);
}

function buildPreview(csvText: string, labourers: Labour[], from?: string, to?: string): ImportPayload {
  const csv = parseCsv(csvText);
  const errors: string[] = [];
  const warnings: string[] = [];
  const headerRowIndex = csv.slice(0, 20).findIndex((row) => row.some((header) => normalized(header) === "labour name"));
  const headers = headerRowIndex >= 0 ? csv[headerRowIndex]!.map((header) => header.trim()) : [];
  if (headerRowIndex < 0) errors.push("Attendance register header was not found in the first 20 rows.");
  const labourIndex = headers.findIndex((header) => normalized(header) === "labour name" || normalized(header) === "labour");
  if (labourIndex < 0) errors.push("Labour Name column was not found.");
  const summary = {
    present: headers.findIndex((header) => ["p", "p total"].includes(normalized(header))),
    half: headers.findIndex((header) => ["1/2", "½", "1/2 total", "½ total", "half day total"].includes(normalized(header))),
    absent: headers.findIndex((header) => ["a", "a total"].includes(normalized(header))),
    advance: headers.findIndex((header) => ["adv (sar)", "advance total"].includes(normalized(header))),
  };
  const rowNumberIndex = headers.findIndex((header) => normalized(header) === "#");
  const ignored = new Set([rowNumberIndex, labourIndex, ...Object.values(summary)]);
  const dateColumns = headers.flatMap((column, index) => {
    if (ignored.has(index)) return [];
    const date = parseDateColumn(column, from, to);
    if (!date) {
      if (/^\d{1,4}[/-]\d{1,2}/.test(column)) errors.push(`Date column "${column}" could not be parsed.`);
      return [];
    }
    return [{ column, index, date }];
  });
  if (!dateColumns.length) errors.push("No attendance date columns were detected.");
  const rows = csv.slice(headerRowIndex + 1).flatMap((values, rowIndex): ImportRow[] => {
    const labourName = values[labourIndex]?.trim() ?? "";
    if (!labourName) {
      warnings.push(`Row ${rowIndex + 2} has no labour name and will be skipped.`);
      return [];
    }
    const cellErrors: string[] = [];
    const cells = dateColumns.map(({ column, index, date }) => {
      const raw = values[index] ?? "";
      const parsed = parseDateCell(raw);
      if (parsed.error) cellErrors.push(`Row ${rowIndex + 2}, ${column}: ${parsed.error}`);
      return { column, date, status: parsed.status, advanceAmount: parsed.advanceAmount, raw };
    });
    errors.push(...cellErrors);
    const name = normalized(labourName);
    const matched = labourers.find((labourer) => normalized(labourer.name) === name) ?? null;
    const suggested = !matched ? labourers
      .map((labourer) => ({ labourer, distance: levenshtein(name, normalized(labourer.name)) }))
      .sort((left, right) => left.distance - right.distance)
      .find((item) => item.distance <= Math.max(2, Math.floor(name.length * 0.25)))?.labourer ?? null : null;
    const result: ImportRow = {
      rowIndex, labourName, cells, matchedLabourerId: matched?.id ?? null, suggestedLabourerId: suggested?.id ?? null,
      csvPresent: numeric(values[summary.present]), csvHalf: numeric(values[summary.half]), csvAbsent: numeric(values[summary.absent]), csvAdvance: numeric(values[summary.advance]),
      calculatedPresent: cells.filter((cell) => cell.status === "present").length,
      calculatedHalf: cells.filter((cell) => cell.status === "half_day").length,
      calculatedAbsent: cells.filter((cell) => cell.status === "absent").length,
      calculatedAdvance: cells.reduce((total, cell) => total + (cell.advanceAmount ?? 0), 0),
    };
    if (result.csvPresent !== null && result.csvPresent !== result.calculatedPresent) warnings.push(`${labourName}: P Total does not match daily cells.`);
    if (result.csvHalf !== null && result.csvHalf !== result.calculatedHalf) warnings.push(`${labourName}: 1/2 Total does not match daily cells.`);
    if (result.csvAbsent !== null && result.csvAbsent !== result.calculatedAbsent) warnings.push(`${labourName}: A Total does not match daily cells.`);
    if (result.csvAdvance !== null && result.csvAdvance !== result.calculatedAdvance) warnings.push(`${labourName}: Advance Total does not match daily cells.`);
    return [result];
  });
  return { rows, dateColumns: dateColumns.map(({ column, date }) => ({ column, date })), errors, warnings };
}

function previewSummary(payload: ImportPayload, duplicateRecords: number) {
  return {
    labourRows: payload.rows.length, dateColumns: payload.dateColumns.length,
    attendanceRecords: payload.rows.flatMap((row) => row.cells).filter((cell) => cell.status).length,
    dailyAdvances: payload.rows.flatMap((row) => row.cells).filter((cell) => cell.advanceAmount !== null).length,
    advanceTotal: payload.rows.reduce((total, row) => total + row.calculatedAdvance, 0),
    duplicateRecords,
    unknownLabourRows: payload.rows.filter((row) => !row.matchedLabourerId).length,
    errors: payload.errors, warnings: payload.warnings,
  };
}

async function assertImportAccess(workspaceId: string, farmId: string, seasonId: string, user: AuthenticatedUser) {
  if (user.workspaceId !== workspaceId || !hasPermission(user, "IMPORT_ATTENDANCE", workspaceId)) return "Workspace owner access is required.";
  return validateTenantReferences(workspaceId, { farmId, seasonId });
}

export async function attendanceImportRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/workspaces/:workspaceId/attendance-imports/preview", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const params = paramsSchema.safeParse(request.params);
    const body = previewSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: "A valid attendance CSV import is required." });
    const accessError = await assertImportAccess(params.data.workspaceId, body.data.farmId, body.data.seasonId, request.appUser);
    if (accessError) return reply.code(403).send({ message: accessError });
    const labourers = await selectedLabourers(params.data.workspaceId, body.data.farmId);
    const parsedPayload = buildPreview(body.data.csvText, labourers, body.data.from, body.data.to);
    const attendance = await db.select().from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, params.data.workspaceId), eq(operationalRecords.farmId, body.data.farmId),
      eq(operationalRecords.seasonId, body.data.seasonId), eq(operationalRecords.entityType, "attendance"),
    ));
    const existing = new Set(attendance.map((record) => {
      const payload = record.payload; return `${String(payload.labourerId)}:${String(payload.date)}`;
    }));
    const duplicateRecords = parsedPayload.rows.reduce((count, row) => count + row.cells.filter((cell) => cell.status && row.matchedLabourerId && existing.has(`${row.matchedLabourerId}:${cell.date}`)).length, 0);
    const validationSummary = previewSummary(parsedPayload, duplicateRecords);
    const [session] = await db.insert(attendanceImportSessions).values({
      workspaceId: params.data.workspaceId, farmId: body.data.farmId, seasonId: body.data.seasonId,
      uploadedBy: request.appUser.id, originalFilename: body.data.originalFilename,
      fileHash: stableId(body.data.csvText), parsedPayload, validationSummary,
    }).returning();
    return reply.code(201).send({ sessionId: session!.id, preview: { ...parsedPayload, summary: validationSummary, labourers } });
  });

  app.post("/api/workspaces/:workspaceId/attendance-imports/confirm", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    request.log.info("attendance import confirm request received");
    const params = paramsSchema.safeParse(request.params);
    const body = confirmSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({
      message: "A valid attendance import confirmation is required.",
      fields: params.error.issues.map((issue) => issue.path.join(".") || "workspaceId"),
    });
    if (!body.success) return reply.code(400).send({
      message: "A valid attendance import confirmation is required.",
      fields: body.error.issues.map((issue) => issue.path.join(".") || "confirmation"),
    });
    const [session] = await db.select().from(attendanceImportSessions).where(and(
      eq(attendanceImportSessions.id, body.data.sessionId), eq(attendanceImportSessions.workspaceId, params.data.workspaceId),
      eq(attendanceImportSessions.uploadedBy, request.appUser.id),
    )).limit(1);
    if (!session) return reply.code(404).send({ message: "Attendance import session was not found." });
    request.log.info({ importSessionId: session.id }, "attendance import session loaded");
    if (session.status === "confirmed") return reply.code(409).send({ message: "Attendance import session has already been confirmed." });
    if ((body.data.farmId && body.data.farmId !== session.farmId) || (body.data.seasonId && body.data.seasonId !== session.seasonId)) {
      return reply.code(403).send({ message: "Import confirmation farm and season must match the preview session." });
    }
    const accessError = await assertImportAccess(params.data.workspaceId, session.farmId, session.seasonId, request.appUser);
    if (accessError) return reply.code(403).send({ message: accessError });
    const parsed = session.parsedPayload as unknown as ImportPayload;
    if (parsed.errors.length) return reply.code(400).send({ message: "Resolve CSV validation errors before importing.", errors: parsed.errors });
    if (parsed.warnings.length && !body.data.warningsConfirmed) return reply.code(400).send({ message: "Confirm validation warnings before importing." });
    const decisions = new Map(body.data.mappings.map((mapping) => [mapping.rowIndex, mapping]));
    const unresolvedRows = parsed.rows.filter((row) => !row.matchedLabourerId && !decisions.has(row.rowIndex)).map((row) => row.labourName);
    if (unresolvedRows.length) return reply.code(400).send({ message: "Resolve all labour mappings before importing.", fields: unresolvedRows });
    request.log.info({ importSessionId: session.id, mappings: decisions.size }, "attendance import labour mappings resolved");
    const result = await db.transaction(async (tx) => {
      request.log.info({ importSessionId: session.id }, "attendance import database transaction started");
      const labourers = await selectedLabourers(params.data.workspaceId, session.farmId);
      const validLabour = new Set(labourers.map((labourer) => labourer.id));
      const attendance = await tx.select().from(operationalRecords).where(and(
        eq(operationalRecords.workspaceId, params.data.workspaceId), eq(operationalRecords.farmId, session.farmId),
        eq(operationalRecords.seasonId, session.seasonId), eq(operationalRecords.entityType, "attendance"),
      ));
      const attendanceByIdentity = new Map(attendance.map((record) => [`${String(record.payload.labourerId)}:${String(record.payload.date)}`, record]));
      const existingAdvances = await tx.select({ clientRecordId: operationalRecords.clientRecordId }).from(operationalRecords).where(and(
        eq(operationalRecords.workspaceId, params.data.workspaceId), eq(operationalRecords.farmId, session.farmId),
        eq(operationalRecords.seasonId, session.seasonId), eq(operationalRecords.entityType, "advance"),
      ));
      const existingAdvanceIds = new Set(existingAdvances.map((record) => record.clientRecordId));
      const labourerWrites: Array<typeof operationalRecords.$inferInsert> = [];
      const attendanceWrites = new Map<string, typeof operationalRecords.$inferInsert>();
      const advanceWrites = new Map<string, typeof operationalRecords.$inferInsert>();
      let created = 0; let updated = 0; let skipped = 0; let duplicateAdvancesSkipped = 0;
      for (const row of parsed.rows) {
        const decision = decisions.get(row.rowIndex);
        let labourerId = row.matchedLabourerId;
        if (decision?.action === "skip" || (!labourerId && !decision)) {
          skipped += row.cells.filter((cell) => cell.status || cell.advanceAmount !== null).length; continue;
        }
        if (decision?.action === "match") labourerId = decision.labourerId ?? null;
        if (decision?.action === "create") {
          labourerId = randomUUID();
          const timestamp = new Date();
          labourerWrites.push({
            workspaceId: params.data.workspaceId, farmId: session.farmId, clientRecordId: labourerId, entityType: "labourer",
            payload: { id: labourerId, name: row.labourName, group: decision.group || "Imported", dailyWage: decision.dailyWage ?? 0, createdAt: timestamp.toISOString(), updatedAt: timestamp.toISOString(), source: "old_android_csv" },
            recordedBy: request.appUser!.id, clientUpdatedAt: timestamp,
          });
          validLabour.add(labourerId);
        }
        if (!labourerId || !validLabour.has(labourerId)) throw new Error(`Invalid labour mapping for ${row.labourName}.`);
        for (const cell of row.cells) {
          const timestamp = new Date();
          if (cell.status) {
            const identity = `${labourerId}:${cell.date}`;
            const existing = attendanceByIdentity.get(identity);
            if (existing && body.data.duplicateMode !== "update_existing") skipped += 1;
            else {
              const clientRecordId = existing?.clientRecordId ?? `csv-attendance-${stableId(params.data.workspaceId, session.farmId, session.seasonId, labourerId, cell.date)}`;
              const payload = { id: clientRecordId, labourerId, date: cell.date, status: cell.status, source: "old_android_csv", sourceImportSessionId: session.id, createdAt: timestamp.toISOString(), updatedAt: timestamp.toISOString() };
              attendanceWrites.set(identity, {
                workspaceId: params.data.workspaceId, farmId: session.farmId, seasonId: session.seasonId,
                clientRecordId, entityType: "attendance", payload, recordedBy: request.appUser!.id, clientUpdatedAt: timestamp, updatedAt: timestamp,
              });
              if (existing) updated += 1; else created += 1;
            }
          }
          if (cell.advanceAmount !== null) {
            const clientRecordId = `csv-advance-${stableId(params.data.workspaceId, session.farmId, session.seasonId, session.fileHash, row.rowIndex, cell.column)}`;
            if (existingAdvanceIds.has(clientRecordId) || advanceWrites.has(clientRecordId)) duplicateAdvancesSkipped += 1;
            else {
              advanceWrites.set(clientRecordId, {
                workspaceId: params.data.workspaceId, farmId: session.farmId, seasonId: session.seasonId,
                clientRecordId, entityType: "advance", payload: {
                  id: clientRecordId, labourerId, date: cell.date, amount: cell.advanceAmount, source: "old_android_csv",
                  sourceImportSessionId: session.id, originalRow: row.rowIndex, originalDateColumn: cell.column,
                  createdAt: timestamp.toISOString(), updatedAt: timestamp.toISOString(),
                }, recordedBy: request.appUser!.id, clientUpdatedAt: timestamp,
              });
            }
          }
        }
      }
      request.log.info({ importSessionId: session.id, records: attendanceWrites.size }, "attendance import attendance records prepared");
      request.log.info({ importSessionId: session.id, records: advanceWrites.size }, "attendance import advance records prepared");
      for (const batch of chunks(labourerWrites)) if (batch.length) await tx.insert(operationalRecords).values(batch);
      for (const batch of chunks([...attendanceWrites.values()])) if (batch.length) await tx.insert(operationalRecords).values(batch).onConflictDoUpdate({
        target: [operationalRecords.workspaceId, operationalRecords.entityType, operationalRecords.clientRecordId],
        set: { payload: sql`excluded.payload`, clientUpdatedAt: sql`excluded.client_updated_at`, updatedAt: new Date() },
      });
      for (const batch of chunks([...advanceWrites.values()])) if (batch.length) await tx.insert(operationalRecords).values(batch).onConflictDoNothing({
        target: [operationalRecords.workspaceId, operationalRecords.entityType, operationalRecords.clientRecordId],
      });
      await tx.update(attendanceImportSessions).set({ status: "confirmed", confirmedAt: new Date() }).where(eq(attendanceImportSessions.id, session.id));
      await tx.insert(auditLogs).values({
        workspaceId: params.data.workspaceId, farmId: session.farmId, userId: request.appUser!.id,
        action: "attendance_csv_import_confirmed", entityType: "attendance_import", entityId: session.id,
        details: { source: "old_android_csv", originalFilename: session.originalFilename, totalRecordsCreated: created, totalRecordsUpdated: updated, totalRecordsSkipped: skipped, advancesCreated: advanceWrites.size, duplicateAdvancesSkipped, labourersCreated: labourerWrites.length },
      });
      return { attendanceCreated: created, attendanceUpdated: updated, attendanceSkipped: skipped, advancesCreated: advanceWrites.size, duplicateAdvancesSkipped, labourersCreated: labourerWrites.length, errors: [] as string[] };
    });
    request.log.info({ importSessionId: session.id }, "attendance import database transaction completed");
    request.log.info({ importSessionId: session.id, result }, "attendance import response sent");
    return { sessionId: session.id, result };
  });
}
