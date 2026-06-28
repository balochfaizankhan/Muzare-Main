import type { FastifyInstance } from "fastify";
import { buildInfo } from "../build-info.js";
import { localDevelopmentMode } from "../config.js";
import { checkDatabaseConnection } from "../db/client.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async (_request, reply) => {
    if (localDevelopmentMode) {
      return { status: "ok", database: "not configured", mode: "local-development", ...buildInfo };
    }
    try {
      await checkDatabaseConnection();
      return { status: "ok", database: "connected", ...buildInfo };
    } catch {
      return reply.code(503).send({ status: "degraded", database: "unavailable", ...buildInfo });
    }
  });
}
