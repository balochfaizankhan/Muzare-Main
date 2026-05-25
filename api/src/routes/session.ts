import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticateUser, createSession, requireUser, revokeSession } from "../auth.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/auth/login", { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "Valid email and password are required." });

    const user = await authenticateUser(parsed.data.email, parsed.data.password);
    if (!user) {
      return reply.code(401).send({ message: "Invalid email or password." });
    }

    const token = await createSession(user.id);
    return {
      token,
      user: {
        ...user,
      },
    };
  });

  app.post("/v1/auth/logout", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (token) await revokeSession(token);
    return reply.code(204).send();
  });

  app.get("/v1/session", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;

    return {
      user: request.appUser,
      permissions: {
        canWrite: request.appUser.role !== "viewer",
        canAdminister: request.appUser.role === "admin",
      },
    };
  });
}
