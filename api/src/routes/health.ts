import type { FastifyInstance } from "fastify";
import { localDevelopmentMode } from "../config.js";
import { checkDatabaseConnection } from "../db/client.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async (_request, reply) => {
    if (localDevelopmentMode) {
      return { status: "ok", database: "not configured", mode: "local-development" };
    }
    try {
      await checkDatabaseConnection();
      return { status: "ok", database: "connected" };
    } catch {
      return reply.code(503).send({ status: "degraded", database: "unavailable" });
    }
  });
}
