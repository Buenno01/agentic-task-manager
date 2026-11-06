import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { abrirBanco } from "../db/index.ts";
import { TRANSICOES } from "../domain/exploracao.ts";
import { ErroValidacao, novaTarefa } from "../domain/tarefa.ts";
import { abrirContextos } from "../db/contextos.ts";
import { rotaContextos } from "./contextos.ts";
import { abrirAnexos } from "../db/anexos.ts";
import { dispositionSegura, LIMITE_ANEXO_PADRAO, rotaAnexos } from "./anexos.ts";
import { abrirAuditoria } from "../db/auditoria.ts";
import { abrirExecucao } from "../db/execucao.ts";
import { criarDiretoNaExecucao, rotaExecucao } from "./execucao.ts";
import { apenasHumano, autenticar, rotuloAutor, type Autor, type Credenciais } from "../auth/credenciais.ts";

export interface Daemon {
  url: string;
  close(): Promise<void>;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, OPTIONS",
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

export function startDaemon(opts: { dbPath: string; port: number; host?: string; credenciais?: Credenciais; anexosDir?: string; anexoMaxBytes?: number }): Promise<Daemon> {
  const repo = abrirBanco(opts.dbPath);
  const ctx = abrirContextos(opts.dbPath);
  const audit = abrirAuditoria(opts.dbPath);
  const exec = abrirExecucao(opts.dbPath);
  const anexos = abrirAnexos(opts.dbPath, opts.anexosDir ?? process.env.ATM_ATTACHMENTS_DIR ?? "./data/attachments");
  const comContexto = <T extends { id: string }>(t: T) => ({ ...t, contextId: ctx.contextoDaTarefa(t.id) });
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
        if (t.phase !== "Exploração" || !tr.de.includes(t.state as never)) return enviar(res, 409, { error: `Transição inválida: ${t.state} → ${tr.para}` });
        const { motivo } = await lerJson(req);
        repo.transicionar(t.id, {
          autor: rotuloAutor(autor), tipo: ma[2], de: t.state, para: tr.para, motivo: typeof motivo === "string" ? motivo : "",
        });
        return enviar(res, 200, comContexto({ ...t, state: tr.para }));
      }
      const rx = rotaExecucao({ repo, store: exec, autor, metodo: req.method ?? "GET", path, corpo: () => lerJson(req) });
      if (rx) {
        const r = await rx;
        return enviar(res, r.status, r.corpo);
      }
      const ra = rotaAnexos(anexos, req, req.method ?? "GET", path, url.searchParams,
        (tipo, id) => (tipo === "tarefa" ? ctx.tarefaExiste(id) : !!ctx.obter(id)), opts.anexoMaxBytes ?? LIMITE_ANEXO_PADRAO);
      if (ra) {
        const r = await ra;
        if (!r.arquivo) return enviar(res, r.status, r.corpo);
        audit.registrar(rotuloAutor(autor), req.method ?? "GET", path, r.status);
        res.writeHead(200, { ...CORS, "content-type": r.arquivo.tipo, "content-disposition": dispositionSegura(r.arquivo.nome), "content-length": r.arquivo.dados.length });
        return void res.end(r.arquivo.dados);
      }
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
        const naExecucao = entrada.phase === "Execução";
        if (naExecucao && !apenasHumano(autor)) return enviar(res, 403, { error: "Apenas o humano pode criar na Execução" });
        const tarefa = naExecucao ? criarDiretoNaExecucao(exec, autor, entrada) : novaTarefa(entrada);
        if (!naExecucao) repo.inserirTarefa(tarefa);
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
              exec.close();
              anexos.close();
              r();
            });
            server.closeAllConnections();
          }),
      });
    });
  });
}
