import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { config } from "./config.js";
import { bootstrapRoutes } from "./routes/bootstrap.js";
import { healthRoutes } from "./routes/health.js";
import { sessionRoutes } from "./routes/session.js";

export async function buildApp() {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: config.WEB_ORIGIN.split(",").map((origin) => origin.trim()),
  });
  await app.register(rateLimit, { global: false });

  await app.register(healthRoutes);
  await app.register(sessionRoutes);
  await app.register(bootstrapRoutes);

  return app;
}
