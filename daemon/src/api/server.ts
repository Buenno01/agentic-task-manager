import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { abrirBanco } from "../db/index.ts";
import { ErroValidacao, novaTarefa } from "../domain/tarefa.ts";

export interface Daemon {
  url: string;
  close(): Promise<void>;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function enviar(res: ServerResponse, status: number, corpo?: unknown) {
  res.writeHead(status, { ...CORS, "content-type": "application/json; charset=utf-8" });
  res.end(corpo === undefined ? undefined : JSON.stringify(corpo));
}

async function lerJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    const v = raw ? JSON.parse(raw) : {};
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {}
  throw new ErroValidacao("Corpo da requisição inválido");
}

export function startDaemon(opts: { dbPath: string; port: number; host?: string }): Promise<Daemon> {
  const repo = abrirBanco(opts.dbPath);
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (req.method === "OPTIONS") return enviar(res, 204);
      if (path === "/tarefas" && req.method === "GET") return enviar(res, 200, repo.listarTarefas());
      if (path === "/tarefas" && req.method === "POST") {
        const tarefa = novaTarefa(await lerJson(req));
        repo.inserirTarefa(tarefa);
        return enviar(res, 201, tarefa);
      }
      enviar(res, 404, { error: "Não encontrado" });
    } catch (e) {
      if (e instanceof ErroValidacao) return enviar(res, 400, { error: e.message });
      console.error(e);
      enviar(res, 500, { error: "Erro interno" });
    }
  });
  return new Promise((resolve) => {
    server.listen(opts.port, opts.host ?? "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => {
              repo.close();
              r();
            });
            server.closeAllConnections();
          }),
      });
    });
  });
}
