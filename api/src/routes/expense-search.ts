import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";
import { operationalRecords, userSessions } from "../db/schema.js";
import { validateTenantReferences } from "../tenant-ownership.js";

const paramsSchema = z.object({ workspaceId: z.string().uuid() });
const querySchema = z.object({
  farmId: z.string().uuid(),
  seasonId: z.string().uuid(),
  search: z.string().trim().max(200).optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  category: z.string().trim().max(100).optional(),
  subcategory: z.string().trim().max(100).optional(),
  accountId: z.string().min(1).max(255).optional(),
});

type AccountPayload = { name?: unknown };

function hasWorkspace(request: FastifyRequest, workspaceId: string) {
  return request.appUser?.workspaceId === workspaceId
    && request.appUser.memberships.some((membership) => membership.active && membership.workspaceId === workspaceId);
}

export async function expenseSearchRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/workspace/:workspaceId/expenses/search", { preHandler: requireUser }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const query = querySchema.safeParse(request.query);
    if (!request.appUser || !request.sessionId || !params.success || !query.success || !hasWorkspace(request, params.data.workspaceId)) {
      return reply.code(403).send({ message: "Workspace membership is required." });
    }
    if (query.data.from && query.data.to && query.data.from > query.data.to) {
      return reply.code(400).send({ message: "Expense search date range is invalid." });
    }
    if (localDevelopmentMode) return { records: [] };

    const [session] = await db.select({ activeFarmId: userSessions.activeFarmId, activeSeasonId: userSessions.activeSeasonId })
      .from(userSessions).where(eq(userSessions.id, request.sessionId)).limit(1);
    if (session?.activeFarmId !== query.data.farmId || session.activeSeasonId !== query.data.seasonId) {
      return reply.code(403).send({ message: "Select this farm and season before searching expenses." });
    }
    const ownershipError = await validateTenantReferences(params.data.workspaceId, {
      farmId: query.data.farmId,
      seasonId: query.data.seasonId,
      accountId: query.data.accountId,
    });
    if (ownershipError) return reply.code(403).send({ message: ownershipError });

    const term = query.data.search ? `%${query.data.search.toLowerCase()}%` : null;
    const records = await db.select().from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, params.data.workspaceId),
      eq(operationalRecords.farmId, query.data.farmId),
      or(eq(operationalRecords.seasonId, query.data.seasonId), isNull(operationalRecords.seasonId)),
      eq(operationalRecords.entityType, "voucher"),
      sql`${operationalRecords.payload}->>'deletedAt' is null`,
      query.data.from ? gte(sql`${operationalRecords.payload}->>'date'`, query.data.from) : undefined,
      query.data.to ? lte(sql`${operationalRecords.payload}->>'date'`, query.data.to) : undefined,
      query.data.category ? sql`(
        lower(coalesce(${operationalRecords.payload}->>'category', '')) = ${query.data.category.toLowerCase()}
        or exists (
          select 1
          from jsonb_array_elements(coalesce(${operationalRecords.payload}->'items', '[]'::jsonb)) as item
          where lower(coalesce(item->>'category', '')) = ${query.data.category.toLowerCase()}
        )
      )` : undefined,
      query.data.subcategory ? sql`(
        lower(coalesce(${operationalRecords.payload}->>'subcategory', '')) = ${query.data.subcategory.toLowerCase()}
        or exists (
          select 1
          from jsonb_array_elements(coalesce(${operationalRecords.payload}->'items', '[]'::jsonb)) as item
          where lower(coalesce(item->>'subcategory', '')) = ${query.data.subcategory.toLowerCase()}
        )
      )` : undefined,
      query.data.accountId ? sql`${operationalRecords.payload}->>'accountId' = ${query.data.accountId}` : undefined,
      term ? sql`(
        lower(coalesce(${operationalRecords.payload}->>'voucherNumber', '')) like ${term}
        or lower(coalesce(${operationalRecords.payload}->>'description', '')) like ${term}
        or lower(coalesce(${operationalRecords.payload}->>'notes', '')) like ${term}
        or lower(coalesce(${operationalRecords.payload}->>'category', '')) like ${term}
        or lower(coalesce(${operationalRecords.payload}->>'subcategory', '')) like ${term}
        or lower(coalesce(${operationalRecords.payload}->>'amount', '')) like ${term}
        or lower(coalesce(${operationalRecords.payload}->>'date', '')) like ${term}
        or replace(substring(coalesce(${operationalRecords.payload}->>'date', '') from 6 for 5), '-', '/') like ${term}
        or exists (
          select 1
          from jsonb_array_elements(coalesce(${operationalRecords.payload}->'items', '[]'::jsonb)) as item
          where lower(coalesce(item->>'category', '')) like ${term}
            or lower(coalesce(item->>'subcategory', '')) like ${term}
            or lower(coalesce(item->>'description', '')) like ${term}
            or lower(coalesce(item->>'remarks', '')) like ${term}
            or lower(coalesce(item->>'amount', '')) like ${term}
        )
        or exists (
          select 1
          from operational_records account
          where account.workspace_id = ${operationalRecords.workspaceId}
            and account.farm_id = ${operationalRecords.farmId}
            and account.season_id = ${operationalRecords.seasonId}
            and account.entity_type = 'account'
            and account.client_record_id = ${operationalRecords.payload}->>'accountId'
            and lower(coalesce(account.payload->>'name', '')) like ${term}
        )
      )` : undefined,
    ));
    const accounts = await db.select().from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, params.data.workspaceId),
      eq(operationalRecords.farmId, query.data.farmId),
      eq(operationalRecords.seasonId, query.data.seasonId),
      eq(operationalRecords.entityType, "account"),
    ));
    const accountById = new Map(accounts.map((record) => {
      const payload = record.payload as AccountPayload;
      return [record.clientRecordId, typeof payload.name === "string" ? payload.name : ""] as const;
    }));
    return {
      records: records.map((record) => ({
        ...record.payload,
        id: record.clientRecordId,
        workspaceId: record.workspaceId,
        farmId: record.farmId,
        seasonId: record.seasonId,
        accountName: accountById.get(String(record.payload.accountId ?? "")) ?? "",
        createdAt: String(record.payload.createdAt ?? record.createdAt.toISOString()),
        updatedAt: record.clientUpdatedAt.toISOString(),
      })),
    };
  });
}
