import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { criarApi, type Api } from "./api.ts";
import { iniciarMcpHttp } from "./http.ts";
import { criarServidorAssistente } from "./assistente.ts";
import { criarServidorMcp } from "./servidor.ts";

const apiUrl = process.env.ATM_API_URL ?? "http://127.0.0.1:3000";
// Perfil "assistente" (ATM_MCP_PERFIL=assistente): opera em nome do humano, com o token humano (ATM_HUMAN_TOKEN).
const assistente = process.env.ATM_MCP_PERFIL === "assistente";
const token = assistente ? process.env.ATM_HUMAN_TOKEN : process.env.ATM_AGENT_TOKEN;
if (!token) {
  console.error(
    assistente
      ? "ATM_HUMAN_TOKEN não definido. O perfil assistente usa o token humano do daemon. Recusando iniciar."
      : "ATM_AGENT_TOKEN não definido. Defina o token do agente (um dos de ATM_AGENT_TOKENS do daemon). Recusando iniciar.",
  );
  process.exit(1);
}
const bearer = assistente ? process.env.ATM_ASSISTANT_MCP_TOKEN || undefined : undefined;
if (bearer && bearer.length < 16) {
  console.error("ATM_ASSISTANT_MCP_TOKEN é curto demais: use ao menos 16 caracteres. Recusando iniciar.");
  process.exit(1);
}
const criarServidor = assistente
  ? (api: Api) => criarServidorAssistente(api, { permitirAprovacao: process.env.ATM_MCP_PERMITIR_APROVACAO === "1" })
  : criarServidorMcp;

if (process.argv.includes("--stdio") || process.env.ATM_MCP_TRANSPORT === "stdio") {
  // Em stdio, stdout é o protocolo: logs só em stderr.
  await criarServidor(criarApi({ apiUrl, token })).connect(new StdioServerTransport());
  console.error(`MCP (stdio) usando a API em ${apiUrl}`);
} else {
  const port = Number(process.env.ATM_MCP_PORT ?? 3100);
  const host = process.env.ATM_MCP_HOST ?? "127.0.0.1";
  const mcp = await iniciarMcpHttp({ apiUrl, token, port, host, bearer, criarServidor });
  console.log(`MCP (${assistente ? "assistente" : "agente"}) ouvindo em ${host}:${port}/mcp (API: ${apiUrl})`);
  void mcp;
}
