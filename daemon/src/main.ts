import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { startDaemon } from "./api/server.ts";
import { carregarCredenciais } from "./auth/credenciais.ts";
import { criarExecutorHermes, opcoesHermesDoAmbiente } from "./executor/hermes.ts";

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
if (!credenciais.agentes.orquestrador) {
  console.error('ATM_AGENT_TOKENS deve incluir o agente "orquestrador" (orquestrador:<token>); ver ADR-0008. Recusando iniciar.');
  process.exit(1);
}
mkdirSync(dirname(dbPath), { recursive: true });
const host = process.env.ATM_HOST ?? "127.0.0.1";
const corsOrigins = process.env.ATM_CORS_ORIGIN?.split(",").map((o) => o.trim()).filter(Boolean);
// ATM_EXECUTOR=hermes liga o adaptador do Hermes (ADR-0009); sem isso nenhum Executor está configurado.
const nomeExecutor = process.env.ATM_EXECUTOR;
if (nomeExecutor && nomeExecutor !== "hermes") {
  console.error(`ATM_EXECUTOR="${nomeExecutor}" desconhecido (valores aceitos: hermes). Recusando iniciar.`);
  process.exit(1);
}
const executor = nomeExecutor === "hermes" ? criarExecutorHermes(opcoesHermesDoAmbiente()) : undefined;
const daemon = await startDaemon({ dbPath, port, host, credenciais, corsOrigins, executor });
console.log(`Daemon ouvindo em ${daemon.url} (banco: ${dbPath})`);
