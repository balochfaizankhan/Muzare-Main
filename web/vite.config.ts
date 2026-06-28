import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const require = createRequire(import.meta.url);
const webPackage = require("./package.json") as { version?: string };

function safeGit(command: string) {
  try {
    return execSync(command, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "unknown";
  }
}

const frontendCommitHash = process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? safeGit("git rev-parse --short HEAD");
const frontendBuildTime = process.env.BUILD_TIME ?? process.env.RENDER_BUILD_TIMESTAMP ?? new Date().toISOString();
const frontendAppVersion = webPackage.version ?? "0.0.0";

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react") || id.includes("node_modules/@tanstack")) return "react";
          if (id.includes("node_modules/i18next")) return "i18n";
          return undefined;
        },
      },
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(frontendAppVersion),
    __BUILD_TIME__: JSON.stringify(frontendBuildTime),
    __GIT_COMMIT_HASH__: JSON.stringify(frontendCommitHash),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["muzare-logo.png", "muzare-logo.jpg", "pwa-192.png", "pwa-512.png"],
      manifest: {
        name: "Muzare - Smart Farm Operations",
        short_name: "Muzare",
        description: "Workforce, crop dispatch and farm ledger management.",
        theme_color: "#05233F",
        background_color: "#F8FAF2",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          {
            src: "/pwa-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/pwa-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        globPatterns: ["**/*.{js,css,html,svg,png,webp,woff2}"],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/.*\/v1\//,
            handler: "NetworkOnly",
          },
        ],
      },
    }),
  ],
});
