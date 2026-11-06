import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { criarApi } from "./api.ts";
import { criarServidorMcp } from "./servidor.ts";

export interface McpHttp {
  url: string;
  close(): Promise<void>;
}

const igual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Streamable HTTP sem sessão: cada requisição ganha seu servidor/transport. Exige o token do agente como bearer. */
export function iniciarMcpHttp(opts: { apiUrl: string; token: string; port: number; host?: string; fetch?: typeof fetch }): Promise<McpHttp> {
  const api = criarApi({ apiUrl: opts.apiUrl, token: opts.token, fetch: opts.fetch });
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
      return;
    }
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!bearer || !igual(bearer, opts.token)) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" }).end('{"error":"Não autenticado"}');
      return;
    }
    if (path !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":"Não encontrado"}');
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST", "content-type": "application/json" }).end('{"error":"Use POST"}');
      return;
    }
    const mcp = criarServidorMcp(api);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      console.error("Erro no MCP:", e instanceof Error ? e.message : e);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end('{"error":"Erro interno"}');
    }
  });
  return new Promise((resolve) => {
    server.listen(opts.port, opts.host ?? "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        close: () => new Promise<void>((r) => (server.close(() => r()), server.closeAllConnections())),
      });
    });
  });
}
