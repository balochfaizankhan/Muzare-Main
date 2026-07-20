import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { allowedOrigins } from "./config.js";
import { bootstrapRoutes } from "./routes/bootstrap.js";
import { healthRoutes } from "./routes/health.js";
import { sessionRoutes } from "./routes/session.js";
import { workspaceApprovalRoutes } from "./routes/workspace-approvals.js";
import { adminDashboardRoutes } from "./routes/admin-dashboard.js";
import { adminUserRoutes } from "./routes/admin-users.js";
import { adminWorkspaceRoutes } from "./routes/admin-workspaces.js";
import { adminWorkspaceSeasonRoutes } from "./routes/admin-workspace-seasons.js";
import { operationalSyncRoutes } from "./routes/operational-sync.js";
import { workspaceAccountRoutes } from "./routes/workspace-accounts.js";
import { workspaceFarmRoutes } from "./routes/workspace-farms.js";
import { workspaceProfileRoutes } from "./routes/workspace-profile.js";
import { workspaceSeasonRoutes } from "./routes/workspace-seasons.js";
import { workspaceTeamRoutes } from "./routes/workspace-team.js";
import { attendanceReportRoutes } from "./routes/attendance-report.js";
import { advanceReportRoutes } from "./routes/advance-report.js";
import { expenseCategoryRoutes } from "./routes/expense-categories.js";
import { attendanceImportRoutes } from "./routes/attendance-imports.js";
import { labourManagementRoutes } from "./routes/labour-management.js";
import { expenseImportRoutes } from "./routes/expense-imports.js";
import { expenseSearchRoutes } from "./routes/expense-search.js";
import { expenseAttachmentRoutes } from "./routes/expense-attachments.js";
import { farmOperationRoutes } from "./routes/farm-operations.js";
import { migrationImportRoutes } from "./routes/migration-import.js";
import { accountingDiagnosticsRoutes } from "./routes/accounting-diagnostics.js";
import { accountingReconciliationRoutes } from "./routes/accounting-reconciliation.js";
import { adminLabourWageSettlementDiagnosticsRoutes } from "./routes/admin-labour-wage-settlement-diagnostics.js";
import { wageRateRoutes } from "./routes/wage-rates.js";
import { labourWageSettlementRoutes } from "./routes/labour-wage-settlements.js";
import { labourPaymentRoutes } from "./routes/labour-payments.js";

export async function buildApp() {
  const app = Fastify({ logger: true });
  const corsMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
  const corsHeaders = ["Content-Type", "Authorization", "X-Workspace-Id", "X-Farm-Id", "X-Season-Id", "X-Requested-With"];

  app.setErrorHandler((error, request, reply) => {
    app.log.error(error);
    const statusCode = typeof (error as { statusCode?: number }).statusCode === "number" ? (error as { statusCode: number }).statusCode : 500;
    if (statusCode < 500) {
      const message = error instanceof Error && error.message.trim()
        ? error.message
        : "The request could not be completed.";
      return reply.code(statusCode).send({ message });
    }
    return reply.code(statusCode).send({
      message: "Something went wrong. Please try again or contact support.",
      requestId: request.id,
    });
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
  await app.register(adminUserRoutes);
  await app.register(adminWorkspaceRoutes);
  await app.register(adminWorkspaceSeasonRoutes);
  await app.register(operationalSyncRoutes);
  await app.register(workspaceProfileRoutes);
  await app.register(workspaceFarmRoutes);
  await app.register(workspaceAccountRoutes);
  await app.register(workspaceSeasonRoutes);
  await app.register(workspaceTeamRoutes);
  await app.register(attendanceReportRoutes);
  await app.register(advanceReportRoutes);
  await app.register(expenseCategoryRoutes);
  await app.register(attendanceImportRoutes);
  await app.register(labourManagementRoutes);
  await app.register(expenseImportRoutes);
  await app.register(expenseSearchRoutes);
  await app.register(expenseAttachmentRoutes);
  await app.register(wageRateRoutes);
  await app.register(labourWageSettlementRoutes);
  await app.register(labourPaymentRoutes);
  await app.register(farmOperationRoutes);
  await app.register(migrationImportRoutes);
  await app.register(accountingDiagnosticsRoutes);
  await app.register(accountingReconciliationRoutes);
  await app.register(adminLabourWageSettlementDiagnosticsRoutes);

  return app;
}
