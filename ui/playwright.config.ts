import { defineConfig } from "@playwright/test";
import { E2E } from "./e2e/ambiente";

// E2E contra o daemon REAL (banco SQLite temporário, tokens descartáveis) e o build da UI servido por server.js.
// A UI chama /api no mesmo origin; server.js repassa ao daemon via ATM_API_URL.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: E2E.uiUrl, trace: "retain-on-failure" },
  // E2E_CHROMIUM_PATH (opcional): usa um Chromium já instalado (launchOptions.executablePath) quando o build que o Playwright pede não existe.
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium", launchOptions: process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {} },
    },
  ],
  webServer: [
    {
      command: "node ../daemon/src/main.ts",
      url: `${E2E.apiUrl}/health`,
      reuseExistingServer: false,
      env: {
        ATM_DB_PATH: E2E.dbPath,
        ATM_PORT: String(E2E.apiPorta),
        ATM_HUMAN_TOKEN: E2E.tokenHumano,
        ATM_AGENT_TOKENS: `orquestrador:${E2E.tokenOrquestrador},agente-e2e:${E2E.tokenAgente}`,
        ATM_COLETA_AGENDADOR: "0",
      },
    },
    {
      command: "node server.js",
      url: E2E.uiUrl,
      reuseExistingServer: false,
      env: { UI_PORT: String(E2E.uiPorta), ATM_API_URL: E2E.apiUrl },
    },
  ],
});
