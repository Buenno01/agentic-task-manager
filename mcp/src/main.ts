import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { criarApi } from "./api.ts";
import { iniciarMcpHttp } from "./http.ts";
import { criarServidorMcp } from "./servidor.ts";

const apiUrl = process.env.ATM_API_URL ?? "http://127.0.0.1:3000";
const token = process.env.ATM_AGENT_TOKEN;
if (!token) {
  console.error("ATM_AGENT_TOKEN não definido. Defina o token do agente (um dos de ATM_AGENT_TOKENS do daemon). Recusando iniciar.");
  process.exit(1);
}

if (process.argv.includes("--stdio") || process.env.ATM_MCP_TRANSPORT === "stdio") {
  // Em stdio, stdout é o protocolo: logs só em stderr.
  await criarServidorMcp(criarApi({ apiUrl, token })).connect(new StdioServerTransport());
  console.error(`MCP (stdio) usando a API em ${apiUrl}`);
} else {
  const port = Number(process.env.ATM_MCP_PORT ?? 3100);
  const host = process.env.ATM_MCP_HOST ?? "127.0.0.1";
  const mcp = await iniciarMcpHttp({ apiUrl, token, port, host });
  console.log(`MCP ouvindo em ${host}:${port}/mcp (API: ${apiUrl})`);
  void mcp;
}
