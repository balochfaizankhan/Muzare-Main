import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default("0.0.0.0"),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  DATABASE_URL: z.string().min(1).optional(),
  SESSION_DAYS: z.coerce.number().int().positive().default(30),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(8).optional(),
  BOOTSTRAP_ADMIN_NAME: z.string().default("Administrator"),
  LOCAL_ADMIN_EMAIL: z.string().email().default("admin@muzare.local"),
  LOCAL_ADMIN_PASSWORD: z.string().min(8).default("ChangeMe123!"),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === "production" && !env.DATABASE_URL) {
    ctx.addIssue({
      code: "custom",
      path: ["DATABASE_URL"],
      message: "DATABASE_URL is required in production.",
    });
  }
});

export const config = envSchema.parse(process.env);
export const databaseConfigured = Boolean(config.DATABASE_URL);
export const localDevelopmentMode = config.NODE_ENV !== "production" && !databaseConfigured;
