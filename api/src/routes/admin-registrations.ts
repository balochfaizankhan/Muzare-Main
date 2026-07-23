import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { approveRegistration, rejectRegistration, requireAdmin, requireRegistrationAdmin } from "../auth.js";
import { config, localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";
import { auditLogs, userStatus, users } from "../db/schema.js";
import { sendAccountApprovedEmail, sendAccountRejectedEmail } from "../email.js";

const registrationStatusFilter = z.enum([...userStatus.enumValues, "all"]);

const listQuerySchema = z.object({
  status: registrationStatusFilter.default("pending"),
  search: z.string().trim().max(200).optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const userIdParams = z.object({ userId: z.string().uuid() });
const rejectBodySchema = z.object({ reason: z.string().trim().max(2000).optional() });

function loginUrlFor(request: { headers: Record<string, unknown> }) {
  const baseUrl = config.APP_BASE_URL
    ?? String(request.headers.origin ?? "")
    ?? `${String(request.headers["x-forwarded-proto"] ?? "https")}://${String(request.headers["x-forwarded-host"] ?? request.headers.host ?? "localhost")}`;
  return `${(baseUrl || "https://app.muzare.com").replace(/\/+$/, "")}/login`;
}

export async function adminRegistrationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/admin/registrations", { preHandler: requireAdmin }, async (request, reply) => {
    if (localDevelopmentMode) return { registrations: [], page: 1, pageSize: 20, total: 0 };

    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ message: "Invalid registration filter parameters." });
    const { status, search, from, to, page, pageSize } = parsed.data;

    const conditions = [];
    if (status !== "all") conditions.push(eq(users.status, status));
    if (search) {
      const term = `%${search.replace(/[%_]/g, (char) => `\\${char}`)}%`;
      conditions.push(or(ilike(users.email, term), ilike(users.displayName, term)));
    }
    if (from) {
      const fromDate = new Date(from);
      if (!Number.isNaN(fromDate.getTime())) conditions.push(gte(users.createdAt, fromDate));
    }
    if (to) {
      const toDate = new Date(to);
      if (!Number.isNaN(toDate.getTime())) conditions.push(lte(users.createdAt, toDate));
    }
    const where = conditions.length ? and(...conditions) : undefined;

    const [countRow] = await db.select({ count: sql<number>`count(*)::int` }).from(users).where(where);
    const count = countRow?.count ?? 0;

    const rows = await db.select({
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      phone: users.phone,
      status: users.status,
      active: users.active,
      createdAt: users.createdAt,
      registrationLanguage: users.registrationLanguage,
      registrationSource: users.registrationSource,
      approvedAt: users.approvedAt,
      approvedBy: users.approvedBy,
      rejectedAt: users.rejectedAt,
      rejectedBy: users.rejectedBy,
      suspendedAt: users.suspendedAt,
      suspendedBy: users.suspendedBy,
      internalReviewNote: users.internalReviewNote,
    }).from(users)
      .where(where)
      .orderBy(status === "pending" ? asc(users.createdAt) : desc(users.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return {
      registrations: rows.map((row) => ({
        ...row,
        // No email-verification feature exists yet in this codebase; surface a
        // stable, honest value instead of fabricating a verified/unverified state.
        emailVerificationStatus: "not_applicable" as const,
      })),
      page,
      pageSize,
      total: Number(count ?? 0),
    };
  });

  app.post("/v1/admin/registrations/:userId/approve", { preHandler: requireRegistrationAdmin }, async (request, reply) => {
    if (!request.appUser) return reply;
    const params = userIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: "A valid user id is required." });
    if (localDevelopmentMode) return reply.code(204).send();

    let outcome: { alreadyApproved: boolean };
    try {
      outcome = await approveRegistration(params.data.userId, request.appUser.id);
    } catch (error) {
      return reply.code(409).send({ message: error instanceof Error ? error.message : "Unable to approve this registration." });
    }

    if (!outcome.alreadyApproved) {
      const [approvedUser] = await db.select({ email: users.email, displayName: users.displayName })
        .from(users).where(eq(users.id, params.data.userId)).limit(1);
      await db.insert(auditLogs).values({
        userId: request.appUser.id,
        action: "account.registration_approved",
        entityType: "user",
        entityId: params.data.userId,
        details: { approvedUserEmail: approvedUser?.email ?? null },
      });
      if (approvedUser) {
        await sendAccountApprovedEmail({
          to: approvedUser.email,
          displayName: approvedUser.displayName ?? approvedUser.email,
          loginUrl: loginUrlFor(request),
        }).catch(() => undefined);
      }
    }

    return reply.code(204).send();
  });

  app.post("/v1/admin/registrations/:userId/reject", { preHandler: requireRegistrationAdmin }, async (request, reply) => {
    if (!request.appUser) return reply;
    const params = userIdParams.safeParse(request.params);
    const body = rejectBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ message: "A valid user id is required." });
    if (localDevelopmentMode) return reply.code(204).send();

    let outcome: { alreadyRejected: boolean };
    try {
      outcome = await rejectRegistration(params.data.userId, request.appUser.id, body.data.reason ?? null);
    } catch (error) {
      return reply.code(409).send({ message: error instanceof Error ? error.message : "Unable to reject this registration." });
    }

    if (!outcome.alreadyRejected) {
      const [rejectedUser] = await db.select({ email: users.email, displayName: users.displayName })
        .from(users).where(eq(users.id, params.data.userId)).limit(1);
      await db.insert(auditLogs).values({
        userId: request.appUser.id,
        action: "account.registration_rejected",
        entityType: "user",
        entityId: params.data.userId,
        details: { rejectedUserEmail: rejectedUser?.email ?? null, hasReason: Boolean(body.data.reason) },
      });
      if (rejectedUser) {
        await sendAccountRejectedEmail({
          to: rejectedUser.email,
          displayName: rejectedUser.displayName ?? rejectedUser.email,
        }).catch(() => undefined);
      }
    }

    return reply.code(204).send();
  });
}
