import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { startDaemon } from "./api/server.ts";
import { carregarCredenciais } from "./auth/credenciais.ts";

const dbPath = process.env.ATM_DB_PATH ?? "./data/atm.db";
const port = Number(process.env.ATM_PORT ?? 3000);
const credenciais = (() => {
  try {
    return carregarCredenciais();
  } catch (e) {
    console.error(`Credenciais inválidas: ${(e as Error).message}`);
    process.exit(1);
  }
})();
if (!credenciais) {
  console.error("ATM_HUMAN_TOKEN não definido (variável de ambiente ou .env). Recusando iniciar sem credenciais.");
  process.exit(1);
}
mkdirSync(dirname(dbPath), { recursive: true });
const host = process.env.ATM_HOST ?? "127.0.0.1";
const corsOrigins = process.env.ATM_CORS_ORIGIN?.split(",").map((o) => o.trim()).filter(Boolean);
const daemon = await startDaemon({ dbPath, port, host, credenciais, corsOrigins });
console.log(`Daemon ouvindo em ${daemon.url} (banco: ${dbPath})`);
