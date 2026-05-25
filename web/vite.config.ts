import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

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
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["muzare-mark.svg"],
      manifest: {
        name: "Muzare - Smart Farm Operations",
        short_name: "Muzare",
        description: "Workforce, crop dispatch and farm ledger management.",
        theme_color: "#002B4E",
        background_color: "#FFFFFF",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          {
            src: "/muzare-mark.svg",
            sizes: "any",
            type: "image/svg+xml",
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
