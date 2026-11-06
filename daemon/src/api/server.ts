import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { abrirBanco } from "../db/index.ts";
import { TRANSICOES } from "../domain/exploracao.ts";
import { ErroValidacao, novaTarefa } from "../domain/tarefa.ts";
import { abrirContextos } from "../db/contextos.ts";
import { rotaContextos } from "./contextos.ts";
import { abrirModuloDependencias } from "./dependencias.ts";
import { abrirAuditoria } from "../db/auditoria.ts";
import { apenasHumano, autenticar, rotuloAutor, type Autor, type Credenciais } from "../auth/credenciais.ts";

export interface Daemon {
  url: string;
  close(): Promise<void>;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

function envio(res: ServerResponse, status: number, corpo?: unknown) {
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

export function startDaemon(opts: { dbPath: string; port: number; host?: string; credenciais?: Credenciais }): Promise<Daemon> {
  const repo = abrirBanco(opts.dbPath);
  const ctx = abrirContextos(opts.dbPath);
  const audit = abrirAuditoria(opts.dbPath);
  const deps = abrirModuloDependencias(opts.dbPath, repo);
  const comContexto = <T extends { id: string }>(t: T) => ({ ...t, contextId: ctx.contextoDaTarefa(t.id), ...deps.anexar(t.id) });
  const server = createServer(async (req, res) => {
    // Autenticação e auditoria (ADR-0001): toda ação registra o autor.
    let autor: Autor = { tipo: "humano" };
    let path = "/";
    const enviar = (r: ServerResponse, status: number, corpo?: unknown) => {
      audit.registrar(rotuloAutor(autor), req.method ?? "GET", path, status);
      envio(r, status, corpo);
    };
    try {
      const url = new URL(req.url ?? "/", "http://x");
      path = url.pathname;
      if (req.method === "OPTIONS") return enviar(res, 204);
      // Healthcheck sem autenticação (usado pelo docker compose).
      if (path === "/health" && req.method === "GET") return enviar(res, 200, { status: "ok" });
      if (opts.credenciais) {
        const a = autenticar(opts.credenciais, req.headers.authorization);
        if (!a) {
          audit.registrar("anonimo", req.method ?? "GET", path, 401);
          return envio(res, 401, { error: "Não autenticado" });
        }
        autor = a;
      }
      if (path === "/auditoria" && req.method === "GET") return enviar(res, 200, audit.listar());
      const me = path.match(/^\/tarefas\/([^/]+)\/eventos$/);
      if (me && req.method === "GET") {
        if (!repo.obterTarefa(me[1])) return enviar(res, 404, { error: "Não encontrado" });
        return enviar(res, 200, repo.listarEventos(me[1]));
      }
      // Ciclo de vida da Exploração: guarda apenasHumano antes de qualquer outra checagem.
      const ma = path.match(/^\/tarefas\/([^/]+)\/([a-z-]+)$/);
      const tr = ma && req.method === "POST" ? TRANSICOES[ma[2]] : undefined;
      if (ma && tr) {
        if (tr.apenasHumano && !apenasHumano(autor)) return enviar(res, 403, { error: "Apenas o humano pode fazer isso" });
        const t = repo.obterTarefa(ma[1]);
        if (!t) return enviar(res, 404, { error: "Não encontrado" });
        if (!tr.de.includes(t.state)) return enviar(res, 409, { error: `Transição inválida: ${t.state} → ${tr.para}` });
        const bloqueio = deps.antes(t, ma[2]);
        if (bloqueio) return enviar(res, bloqueio.status, bloqueio.corpo);
        const { motivo } = await lerJson(req);
        const m = typeof motivo === "string" ? motivo : "";
        repo.transicionar(t.id, { autor: rotuloAutor(autor), tipo: ma[2], de: t.state, para: tr.para, motivo: m });
        deps.depois(t, ma[2], rotuloAutor(autor), m);
        return enviar(res, 200, comContexto({ ...t, state: tr.para }));
      }
      const rd = await deps.rota(req.method ?? "GET", path, () => lerJson(req));
      if (rd) return enviar(res, rd.status, rd.corpo);
      const rc = rotaContextos(ctx, req.method ?? "GET", path, url.searchParams, () => lerJson(req), () =>
        repo.listarTarefas().map(comContexto),
      );
      if (rc) {
        const r = await rc;
        return enviar(res, r.status, r.corpo);
      }
      if (path === "/tarefas" && req.method === "GET") return enviar(res, 200, repo.listarTarefas().map(comContexto));
      if (path === "/tarefas" && req.method === "POST") {
        const entrada = await lerJson(req);
        const contextId = entrada.contextId ?? null;
        if (contextId !== null && (typeof contextId !== "string" || !ctx.obter(contextId)))
          throw new ErroValidacao("Contexto não existe");
        const tarefa = novaTarefa(entrada);
        repo.inserirTarefa(tarefa);
        ctx.associarTarefa(tarefa.id, contextId);
        return enviar(res, 201, comContexto(tarefa));
      }
      const mt = path.match(/^\/tarefas\/([^/]+)\/contexto$/);
      if (mt && req.method === "PUT") {
        if (!ctx.tarefaExiste(mt[1])) return enviar(res, 404, { error: "Não encontrado" });
        const { contextId = null } = await lerJson(req);
        if (contextId !== null && (typeof contextId !== "string" || !ctx.obter(contextId)))
          throw new ErroValidacao("Contexto não existe");
        ctx.associarTarefa(mt[1], contextId);
        return enviar(res, 200, { id: mt[1], contextId });
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
              ctx.close();
              audit.close();
              deps.close();
              r();
            });
            server.closeAllConnections();
          }),
      });
    });
  });
}
