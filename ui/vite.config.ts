/// <reference types="vitest/config" />
import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Em desenvolvimento a UI chama a API pelo mesmo origin (/api/*); o Vite repassa
// ao daemon removendo o prefixo, então não há CORS. Use ATM_API_URL para outro destino.
const api = process.env.ATM_API_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  server: {
    host: process.env.UI_HOST ?? "127.0.0.1",
    port: Number(process.env.UI_PORT ?? 5173),
    proxy: { "/api": { target: api, changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") } },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
