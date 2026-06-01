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
import { operationalSyncRoutes } from "./routes/operational-sync.js";
import { workspaceFarmRoutes } from "./routes/workspace-farms.js";
import { workspaceSeasonRoutes } from "./routes/workspace-seasons.js";
import { attendanceReportRoutes } from "./routes/attendance-report.js";
import { advanceReportRoutes } from "./routes/advance-report.js";
import { expenseCategoryRoutes } from "./routes/expense-categories.js";
import { attendanceImportRoutes } from "./routes/attendance-imports.js";
import { labourManagementRoutes } from "./routes/labour-management.js";
import { expenseImportRoutes } from "./routes/expense-imports.js";

export async function buildApp() {
  const app = Fastify({ logger: true });
  const corsMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
  const corsHeaders = ["Content-Type", "Authorization", "X-Workspace-Id", "X-Farm-Id", "X-Season-Id", "X-Requested-With"];

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    return reply.code(500).send({ message: "Something went wrong. Please try again or contact support." });
  });

  app.log.info({ allowedOrigins }, "CORS allowed origins");
  await app.register(cors, {
    origin(origin, callback) {
      const normalizedOrigin = origin?.replace(/\/+$/, "");
      const allowed = !normalizedOrigin || allowedOrigins.includes(normalizedOrigin);
      app.log.info({ origin: origin ?? null, allowed }, "CORS origin check");
      callback(null, allowed);
    },
    methods: corsMethods,
    allowedHeaders: corsHeaders,
    credentials: false,
    optionsSuccessStatus: 204,
  });
  await app.register(rateLimit, { global: false });

  await app.register(healthRoutes);
  await app.register(sessionRoutes);
  await app.register(bootstrapRoutes);
  await app.register(workspaceApprovalRoutes);
  await app.register(adminDashboardRoutes);
  await app.register(adminWorkspaceRoutes);
  await app.register(operationalSyncRoutes);
  await app.register(workspaceFarmRoutes);
  await app.register(workspaceSeasonRoutes);
  await app.register(attendanceReportRoutes);
  await app.register(advanceReportRoutes);
  await app.register(expenseCategoryRoutes);
  await app.register(attendanceImportRoutes);
  await app.register(labourManagementRoutes);
  await app.register(expenseImportRoutes);

  return app;
}
