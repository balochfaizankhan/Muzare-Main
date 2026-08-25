import { buildApp } from "./app.js";
import { ensureBootstrapAdmin } from "./auth.js";
import { config, databaseConfigured } from "./config.js";
import { closeDatabaseConnection } from "./db/client.js";
import { ensureDispatchSerialGuard } from "./db/dispatchSerialGuard.js";
import { ensureLabourAdvanceFundingAttribution } from "./db/labourAdvanceFundingAttributionGuard.js";
import { ensureWorkspaceSchema } from "./db/migrations.js";

const app = await buildApp();

const stop = async () => {
  await app.close();
  await closeDatabaseConnection();
  process.exit(0);
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

try {
  if (databaseConfigured) {
    await ensureWorkspaceSchema();
    await ensureDispatchSerialGuard();
    await ensureLabourAdvanceFundingAttribution();
  }
  await ensureBootstrapAdmin();
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error(error);
  await closeDatabaseConnection();
  process.exit(1);
}
