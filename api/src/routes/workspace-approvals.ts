import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";
import { workspaceApprovalConfigurations, workspaceApprovals } from "../db/schema.js";
import { hasPermission, type WorkspacePermission, type WorkspaceRole } from "../permissions.js";
import { approvalEntityBelongsToWorkspace } from "../tenant-ownership.js";

const entityPermission: Record<"expense" | "attendance" | "sale" | "dispatch", WorkspacePermission> = {
  expense: "APPROVE_EXPENSE",
  attendance: "APPROVE_ATTENDANCE",
  sale: "APPROVE_SALE",
  dispatch: "APPROVE_DISPATCH",
};

const submitSchema = z.object({
  workspaceId: z.string().uuid(),
  entityType: z.enum(["expense", "attendance", "sale", "dispatch"]),
  entityId: z.string().uuid(),
});

const decisionSchema = z.object({
  workspaceId: z.string().uuid(),
  approvalId: z.string().uuid(),
  decision: z.enum(["approved", "rejected"]),
});

export async function workspaceApprovalRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/workspace/:workspaceId/approvals", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const parsed = z.object({ workspaceId: z.string().uuid() }).safeParse(request.params);
    const workspaceId = parsed.success ? parsed.data.workspaceId : undefined;
    const canApprove = workspaceId && Object.values(entityPermission).some((permission) => hasPermission(request.appUser!, permission, workspaceId));
    if (!parsed.success || request.appUser.workspaceId !== workspaceId || !canApprove) {
      return reply.code(403).send({ message: "Workspace approval permission is required." });
    }
    if (localDevelopmentMode) return { approvals: [] };
    const approvals = await db.select().from(workspaceApprovals)
      .where(and(eq(workspaceApprovals.workspaceId, parsed.data.workspaceId), eq(workspaceApprovals.status, "pending")));
    return { approvals };
  });

  app.post("/v1/workspace/approvals", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const parsed = submitSchema.safeParse(request.body);
    if (!parsed.success || request.appUser.workspaceId !== parsed.data.workspaceId
      || !hasPermission(request.appUser, "SUBMIT_RECORDS", parsed.data.workspaceId)) {
      return reply.code(403).send({ message: "Workspace record submission permission is required." });
    }
    if (localDevelopmentMode) return reply.code(201).send();
    if (!(await approvalEntityBelongsToWorkspace(parsed.data.workspaceId, parsed.data.entityType, parsed.data.entityId))) {
      return reply.code(403).send({ message: "Approval entity does not belong to the selected workspace." });
    }
    await db.insert(workspaceApprovals).values({ ...parsed.data, submittedBy: request.appUser.id });
    return reply.code(201).send();
  });

  app.post("/v1/workspace/approvals/decision", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const parsed = decisionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "A valid workspace approval decision is required." });
    if (request.appUser.workspaceId !== parsed.data.workspaceId) return reply.code(403).send({ message: "Select this workspace before deciding approvals." });
    if (localDevelopmentMode) return reply.code(204).send();
    const [approval] = await db.select().from(workspaceApprovals)
      .where(and(eq(workspaceApprovals.id, parsed.data.approvalId), eq(workspaceApprovals.workspaceId, parsed.data.workspaceId)))
      .limit(1);
    if (!approval || approval.status !== "pending") return reply.code(404).send({ message: "Pending approval not found." });
    const [configuration] = await db.select().from(workspaceApprovalConfigurations)
      .where(and(
        eq(workspaceApprovalConfigurations.workspaceId, parsed.data.workspaceId),
        eq(workspaceApprovalConfigurations.entityType, approval.entityType),
      )).limit(1);
    const requiredRoles = configuration?.requiredRoles ?? ["workspace_owner"];
    const membership = request.appUser.memberships.find((item) => item.active && item.workspaceId === parsed.data.workspaceId);
    const requiredRole = requiredRoles[approval.currentStep] as WorkspaceRole | undefined;
    if (!membership || membership.role !== requiredRole || !hasPermission(request.appUser, entityPermission[approval.entityType], parsed.data.workspaceId)) {
      return reply.code(403).send({ message: "This approval is assigned to another workspace role." });
    }
    const isFinalStep = parsed.data.decision === "rejected" || approval.currentStep + 1 >= requiredRoles.length;
    await db.update(workspaceApprovals).set(isFinalStep ? {
      status: parsed.data.decision,
      decidedBy: request.appUser.id,
      decidedAt: new Date(),
      updatedAt: new Date(),
    } : {
      currentStep: approval.currentStep + 1,
      updatedAt: new Date(),
    }).where(and(eq(workspaceApprovals.id, approval.id), eq(workspaceApprovals.workspaceId, parsed.data.workspaceId)));
    return reply.code(204).send();
  });
}
