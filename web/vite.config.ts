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
