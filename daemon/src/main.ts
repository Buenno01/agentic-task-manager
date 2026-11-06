import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { startDaemon } from "./api/server.ts";
import { carregarCredenciais } from "./auth/credenciais.ts";

const dbPath = process.env.ATM_DB_PATH ?? "./data/atm.db";
const port = Number(process.env.ATM_PORT ?? 3000);
const credenciais = carregarCredenciais();
if (!credenciais) {
  console.error("ATM_HUMAN_TOKEN não definido (variável de ambiente ou .env). Recusando iniciar sem credenciais.");
  process.exit(1);
}
mkdirSync(dirname(dbPath), { recursive: true });
const daemon = await startDaemon({ dbPath, port, credenciais });
console.log(`Daemon ouvindo em ${daemon.url} (banco: ${dbPath})`);
