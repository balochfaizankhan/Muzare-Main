import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { allowedOrigins } from "./config.js";
import { bootstrapRoutes } from "./routes/bootstrap.js";
import { healthRoutes } from "./routes/health.js";
import { sessionRoutes } from "./routes/session.js";
import { workspaceApprovalRoutes } from "./routes/workspace-approvals.js";
import { adminDashboardRoutes } from "./routes/admin-dashboard.js";
import { adminWorkspaceRoutes } from "./routes/admin-workspaces.js";

export async function buildApp() {
  const app = Fastify({ logger: true });

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    return reply.code(500).send({ message: "Something went wrong. Please try again or contact support." });
  });

  await app.register(cors, {
    origin: allowedOrigins,
    credentials: true,
  });
  await app.register(rateLimit, { global: false });

  await app.register(healthRoutes);
  await app.register(sessionRoutes);
  await app.register(bootstrapRoutes);
  await app.register(workspaceApprovalRoutes);
  await app.register(adminDashboardRoutes);
  await app.register(adminWorkspaceRoutes);

  return app;
}
