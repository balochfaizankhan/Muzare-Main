import type { FastifyInstance } from "fastify";
import { and, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { db } from "../db/client.js";
import { accounts, farms } from "../db/schema.js";
import { hasPermission } from "../permissions.js";
import { validateTenantReferences } from "../tenant-ownership.js";

const paramsSchema = z.object({ workspaceId: z.string().uuid() });
const querySchema = z.object({
  search: z.string().trim().optional().default(""),
  farmId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
});

export async function workspaceAccountRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/workspace/:workspaceId/accounts", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply.code(401).send({ message: "Authentication token is required." });
    const params = paramsSchema.safeParse(request.params);
    const query = querySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ message: "A valid account query is required." });
    const { workspaceId } = params.data;
    if (request.appUser.platformRole !== "platform_admin" && request.appUser.workspaceId !== workspaceId) {
      return reply.code(403).send({ message: "Select this workspace before viewing accounts." });
    }
    if (!request.appUser.platformRole && !hasPermission(request.appUser, "VIEW_REPORTS", workspaceId)) {
      return reply.code(403).send({ message: "Workspace report permission is required." });
    }
    if (query.data.farmId) {
      const ownershipError = await validateTenantReferences(workspaceId, { farmId: query.data.farmId });
      if (ownershipError) return reply.code(403).send({ message: ownershipError });
    }
    const search = query.data.search.trim().toLowerCase();
    const rows = await db.select({
      id: accounts.id,
      farmId: accounts.farmId,
      farmName: farms.name,
      name: accounts.name,
      accountType: accounts.accountType,
      active: accounts.active,
      oldAndroidId: accounts.oldAndroidId,
      sourceType: accounts.sourceType,
    }).from(accounts).innerJoin(farms, eq(farms.id, accounts.farmId)).where(and(
      eq(farms.workspaceId, workspaceId),
      query.data.farmId ? eq(accounts.farmId, query.data.farmId) : undefined,
      search ? or(
        ilike(accounts.name, `%${search}%`),
        ilike(sql`${accounts.id}::text`, `%${search}%`),
        ilike(sql`COALESCE(${accounts.oldAndroidId}::text, '')`, `%${search}%`),
      ) : undefined,
    )).orderBy(accounts.name);
    return {
      accounts: rows.map((row) => ({
        id: row.id,
        farmId: row.farmId,
        farmName: row.farmName,
        name: row.name,
        accountType: row.accountType,
        active: row.active,
        oldAndroidId: row.oldAndroidId,
        sourceType: row.sourceType,
      })),
    };
  });
}
