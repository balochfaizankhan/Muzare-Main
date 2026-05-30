import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireAdmin, requirePermission } from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";
import { farms, workspaces } from "../db/schema.js";

const workspaceSchema = z.object({
  name: z.string().trim().min(2).max(120),
  contactEmail: z.string().email(),
  contactPhone: z.string().trim().max(40).optional(),
});
const workspaceIdSchema = z.object({ workspaceId: z.string().uuid() });

export async function adminWorkspaceRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/admin/workspaces", { preHandler: requireAdmin }, async () => {
    if (localDevelopmentMode) return { workspaces: [] };
    return { workspaces: await db.select().from(workspaces).orderBy(desc(workspaces.createdAt)) };
  });

  app.post("/v1/admin/workspaces", { preHandler: requirePermission("CREATE_WORKSPACE") }, async (request, reply) => {
    const parsed = workspaceSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "Valid workspace details are required." });
    if (localDevelopmentMode) return reply.code(201).send();
    const slug = `${parsed.data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace"}-${randomBytes(3).toString("hex")}`;
    await db.insert(workspaces).values({ ...parsed.data, contactPhone: parsed.data.contactPhone || null, slug, status: "approved", approvedAt: new Date() });
    return reply.code(201).send();
  });

  app.post("/v1/admin/workspaces/:workspaceId/suspend", { preHandler: requirePermission("CREATE_WORKSPACE") }, async (request, reply) => {
    const parsed = workspaceIdSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ message: "A valid workspace id is required." });
    if (!localDevelopmentMode) await db.update(workspaces).set({ status: "suspended", updatedAt: new Date() }).where(eq(workspaces.id, parsed.data.workspaceId));
    return reply.code(204).send();
  });

  app.delete("/v1/admin/workspaces/:workspaceId", { preHandler: requirePermission("DELETE_WORKSPACE") }, async (request, reply) => {
    const parsed = workspaceIdSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ message: "A valid workspace id is required." });
    if (localDevelopmentMode) return reply.code(204).send();
    const [result] = await db.select({ count: sql<number>`count(*)::int` }).from(farms).where(eq(farms.workspaceId, parsed.data.workspaceId));
    if (Number(result?.count) > 0) return reply.code(409).send({ message: "Suspend this workspace instead. Operational farm records must be archived before deletion." });
    await db.delete(workspaces).where(eq(workspaces.id, parsed.data.workspaceId));
    return reply.code(204).send();
  });
}
