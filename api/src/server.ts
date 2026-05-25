import { buildApp } from "./app.js";
import { ensureBootstrapAdmin } from "./auth.js";
import { config } from "./config.js";
import { closeDatabaseConnection } from "./db/client.js";

const app = await buildApp();

const stop = async () => {
  await app.close();
  await closeDatabaseConnection();
  process.exit(0);
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

try {
  await ensureBootstrapAdmin();
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error(error);
  await closeDatabaseConnection();
  process.exit(1);
}
