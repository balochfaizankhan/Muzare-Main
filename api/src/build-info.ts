import { execSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const apiPackage = require("../package.json") as { version?: string };

function safeGit(command: string) {
  try {
    return execSync(command, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

const gitCommit =
  process.env.RENDER_GIT_COMMIT
  ?? process.env.GIT_COMMIT
  ?? safeGit("git rev-parse --short HEAD")
  ?? "unknown";

const buildTime =
  process.env.BUILD_TIME
  ?? process.env.RENDER_BUILD_TIMESTAMP
  ?? new Date().toISOString();

const appVersion = apiPackage.version ?? "0.0.0";

export const buildInfo = {
  gitCommit,
  buildTime,
  appVersion,
} as const;

