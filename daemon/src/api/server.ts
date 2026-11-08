import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { abrirBanco } from "../db/index.ts";
import { TRANSICOES } from "../domain/exploracao.ts";
import { ErroValidacao, novaTarefa } from "../domain/tarefa.ts";
import { abrirContextos } from "../db/contextos.ts";
import { rotaContextos, cadeia } from "./contextos.ts";
import { resolverContexto } from "../domain/contexto.ts";
import { criarWorkspaces } from "../workspace/workspace.ts";
import { join } from "node:path";
import { abrirAnexos } from "../db/anexos.ts";
import { dispositionSegura, LIMITE_ANEXO_PADRAO, rotaAnexos, tipoSeguro } from "./anexos.ts";
import { ErroCorpoGrande, LIMITE_JSON, lerCorpoLimitado } from "./corpo.ts";
import { abrirComentarios } from "../db/comentarios.ts";
import { rotaHistorico } from "./historico.ts";
import { abrirModuloDependencias } from "./dependencias.ts";
import { abrirPrioridades } from "../db/prioridade.ts";
import { ordenarPorPrioridade } from "../domain/prioridade.ts";
import { definirPrioridade } from "./prioridade.ts";
import { abrirConsolidado } from "../db/consolidado.ts";
import { rotaConsolidado } from "./consolidado.ts";
import { abrirAuditoria } from "../db/auditoria.ts";
import { abrirArea } from "../db/area.ts";
import { criarArea } from "./area.ts";
import { abrirExecucao } from "../db/execucao.ts";
import { criarDiretoNaExecucao, rotaExecucao } from "./execucao.ts";
import { abrirModuloSubtarefas } from "./subtarefas.ts";
import { abrirBusca } from "../db/busca.ts";
import { rotaBusca } from "./busca.ts";
import { abrirRodadas } from "../db/rodadas.ts";
import { criarRodadas } from "../rodada/executar.ts";
import { rotaRodadas } from "./rodadas.ts";
import { executorNaoConfigurado, type Executor } from "../executor/executor.ts";
import { AUTOR_ORQUESTRADOR, criarOrquestrador, type Orquestrador, type OpcoesOrquestrador } from "../orquestrador/orquestrador.ts";
import { apenasHumano, autenticar, rotuloAutor, type Autor, type Credenciais } from "../auth/credenciais.ts";

export interface Daemon {
  url: string;
  /** Uma varredura do orquestrador (aguarda terminar); no-op se desligado. */
  varrer(): Promise<void>;
  close(): Promise<void>;
}

export interface OpcoesDaemon {
  dbPath: string;
  port: number;
  host?: string;
  /** Obrigatório: sem credenciais todo mundo viraria "humano" (falha aberta). */
  credenciais: Credenciais;
  anexosDir?: string;
  anexoMaxBytes?: number;
  /** Origens CORS permitidas (padrão: a UI local em :5173). */
  corsOrigins?: string[];
  /** Adaptador do Executor (injetável; testes usam o falso). Padrão: nenhum configurado. */
  executor?: Executor;
  /** Raiz dos Workspaces das Rodadas (padrão: ATM_WORKSPACES_DIR ou ./data/workspaces). */
  workspacesDir?: string;
  /** Volume dos clones (padrão: ATM_REPOS_DIR ou ../repos ao lado dos Workspaces). */
  reposDir?: string;
  /** URL do MCP entregue ao processo do agente (ADR-0008; padrão: ATM_MCP_URL ou http://mcp:3100/mcp). */
  mcpUrl?: string;
  /** Orquestrador (ticket 02). `false` desliga; sem Executor injetado ele também fica desligado. */
  orquestrador?: OpcoesOrquestrador | false;
}

export const CORS_ORIGENS_PADRAO = ["http://127.0.0.1:5173", "http://localhost:5173"];

const CORS_FIXO = {
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

/** Cabeçalhos CORS: só reflete a origem se estiver na lista permitida. */
function cabecalhosCors(origem: string | undefined, permitidas: string[]): Record<string, string> {
  if (!origem || !permitidas.includes(origem)) return {};
  return { ...CORS_FIXO, "access-control-allow-origin": origem, vary: "Origin" };
}

function envio(res: ServerResponse, cors: Record<string, string>, status: number, corpo?: unknown) {
  res.writeHead(status, { ...cors, "content-type": "application/json; charset=utf-8" });
  res.end(corpo === undefined ? undefined : JSON.stringify(corpo));
}

async function lerJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const bruto = await lerCorpoLimitado(req, LIMITE_JSON);
  if (bruto === null) throw new ErroCorpoGrande();
  const raw = bruto.toString("utf8");
  try {
    const v = raw ? JSON.parse(raw) : {};
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {}
  throw new ErroValidacao("Corpo da requisição inválido");
}

const NEGADO = { error: "Apenas o humano pode fazer isso" };

export function startDaemon(opts: OpcoesDaemon): Promise<Daemon> {
  if (!opts?.credenciais) throw new Error("startDaemon exige credenciais explícitas (recusa iniciar sem autenticação)");
  const credenciais = opts.credenciais;
  const origensCors = opts.corsOrigins?.length ? opts.corsOrigins : CORS_ORIGENS_PADRAO;
  const repo = abrirBanco(opts.dbPath);
  const ctx = abrirContextos(opts.dbPath);
  const audit = abrirAuditoria(opts.dbPath);
  const exec = abrirExecucao(opts.dbPath);
  const anexos = abrirAnexos(opts.dbPath, opts.anexosDir ?? process.env.ATM_ATTACHMENTS_DIR ?? "./data/attachments");
  const coment = abrirComentarios(opts.dbPath);
  const deps = abrirModuloDependencias(opts.dbPath, repo);
  const prios = abrirPrioridades(opts.dbPath);
  const subs = abrirModuloSubtarefas(opts.dbPath, repo);
  const areaDb = abrirArea(opts.dbPath);
  const area = criarArea(repo, ctx, areaDb);
  const comContexto = <T extends { id: string }>(t: T) =>
    area.decorar({
      ...t,
      contextId: ctx.contextoDaTarefa(t.id),
      ...deps.anexar(t.id),
      ...subs.anexar(t.id),
      priority: prios.obter(t.id),
    });
  const cons = abrirConsolidado(opts.dbPath);
  const buscaDb = abrirBusca(opts.dbPath);
  const rodadasDb = abrirRodadas(opts.dbPath);
  let urlDaemon = "";
  let orq: Orquestrador | undefined;
  const workspacesDir = opts.workspacesDir ?? process.env.ATM_WORKSPACES_DIR ?? "./data/workspaces";
  const workspaces = criarWorkspaces({ reposDir: opts.reposDir ?? process.env.ATM_REPOS_DIR ?? join(workspacesDir, "..", "repos"), workspacesDir });
  const reposDaTarefa = (tarefaId: string) => {
    const c = ctx.obter(ctx.contextoDaTarefa(tarefaId) ?? "");
    const r = c ? resolverContexto(cadeia(ctx, c)) : undefined;
    return { repositorio: r?.repository ?? null, consulta: r?.referenceRepositories ?? [] };
  };
  const rodadasCtl = criarRodadas({
    repo,
    rodadas: rodadasDb,
    executor: opts.executor ?? executorNaoConfigurado,
    workspaces,
    reposDaTarefa,
    mcpUrl: opts.mcpUrl ?? process.env.ATM_MCP_URL ?? "http://mcp:3100/mcp",
    tokenAgente: credenciais.agentes.orquestrador ?? "",
    apiUrl: () => urlDaemon,
    aoTerminar: () => orq?.mudou(),
  });
  const orquestrador = rodadasCtl;
  if (opts.executor && opts.orquestrador !== false) {
    orq = criarOrquestrador(
      {
        tarefas: () => repo.listarTarefas(),
        prioridade: (id) => prios.obter(id),
        contextos: () => ctx.listar(),
        contextoDaTarefa: (id) => ctx.contextoDaTarefa(id),
        emAndamento: () => rodadasDb.emAndamento(),
        totalRodadas: (id) => rodadasDb.totalDaTarefa(id),
        dependenciasPendentes: (id) => deps.anexar(id).dependenciasPendentes.length,
        foiForcada: (id) => repo.listarEventos(id).some((e) => e.tipo === "forcar-inicio"),
        marcarInicio: (t, para, tipo) =>
          repo.transicionar(t.id, { autor: AUTOR_ORQUESTRADOR, tipo, de: t.state, para, motivo: "Rodada iniciada pelo orquestrador" }),
        iniciarRodada: (id, tipo) => rodadasCtl.iniciar(id, tipo),
      },
      opts.orquestrador || undefined,
    );
  }
  const server = createServer(async (req, res) => {
    // Autenticação e auditoria (ADR-0001): toda ação autenticada registra o autor.
    // Sondagens (/health, OPTIONS) não entram na auditoria.
    const metodo = req.method ?? "GET";
    const cors = cabecalhosCors(req.headers.origin, origensCors);
    let autor: Autor | undefined;
    let path = "/";
    let auditar = true;
    const enviar = (status: number, corpo?: unknown) => {
      if (auditar) audit.registrar(autor ? rotuloAutor(autor) : "anonimo", metodo, path, status);
      envio(res, cors, status, corpo);
      // Mudança de estado de Tarefa (ou criação): o orquestrador reavalia a fila.
      if (metodo !== "GET" && status < 300) orq?.mudou();
    };
    try {
      const url = new URL(req.url ?? "/", "http://x");
      path = url.pathname;
      if (metodo === "OPTIONS") {
        auditar = false;
        return enviar(204);
      }
      // Healthcheck sem autenticação (usado pelo docker compose).
      if (path === "/health" && metodo === "GET") {
        auditar = false;
        return enviar(200, { status: "ok" });
      }
      const identificado = autenticar(credenciais, req.headers.authorization);
      if (!identificado) return enviar(401, { error: "Não autenticado" });
      autor = identificado;
      const quem = rotuloAutor(autor);
      const humano = apenasHumano(autor);
      const corpoJson = () => lerJson(req);
      if (path === "/auditoria" && metodo === "GET") return enviar(200, audit.listar());
      const respBusca = rotaBusca(
        { busca: buscaDb, anexos, consolidado: cons, contextoExiste: (i) => !!ctx.obter(i), contextos: () => ctx.listar(), contextoDaTarefa: (i) => ctx.contextoDaTarefa(i) },
        metodo, path, url.searchParams,
      );
      if (respBusca) return enviar(respBusca.status, respBusca.corpo);
      const respHistorico = rotaHistorico(
        { comentarios: coment, tarefaExiste: (i) => !!repo.obterTarefa(i), transicoes: (i) => repo.listarEventos(i) },
        metodo, path, quem, corpoJson,
      );
      if (respHistorico) {
        const r = await respHistorico;
        return enviar(r.status, r.corpo);
      }
      const respRodadas = rotaRodadas(
        {
          repo, rodadas: rodadasDb, comentarios: coment,
          iniciar: (id, tipo) => orquestrador.iniciar(id, tipo),
          orquestradorConfigurado: !!credenciais.agentes.orquestrador,
        },
        metodo, path, autor, corpoJson,
      );
      if (respRodadas) {
        const r = await respRodadas;
        return enviar(r.status, r.corpo);
      }
      // Ciclo de vida da Exploração: guarda apenasHumano antes de qualquer outra checagem.
      const matchAcao = path.match(/^\/tarefas\/([^/]+)\/([a-z-]+)$/);
      const transicao = matchAcao && metodo === "POST" ? TRANSICOES[matchAcao[2]] : undefined;
      // "forcar-inicio" de Tarefa já na Execução é tratado pelas rotas de Execução.
      const forcarNaExecucao =
        !!matchAcao && !!transicao && matchAcao[2] === "forcar-inicio" && repo.obterTarefa(matchAcao[1])?.phase === "Execução";
      if (matchAcao && transicao && !forcarNaExecucao) {
        const [, id, acao] = matchAcao;
        if (transicao.apenasHumano && !humano) return enviar(403, NEGADO);
        const t = repo.obterTarefa(id);
        if (!t) return enviar(404, { error: "Não encontrado" });
        if (t.phase !== "Exploração" || !transicao.de.includes(t.state as never)) return enviar(409, { error: `Transição inválida: ${t.state} → ${transicao.para}` });
        const bloqueio = deps.antes(t, acao) ?? subs.antes(t, acao);
        if (bloqueio) return enviar(bloqueio.status, bloqueio.corpo);
        const { motivo } = await corpoJson();
        const m = typeof motivo === "string" ? motivo : "";
        repo.transicionar(t.id, { autor: quem, tipo: acao, de: t.state, para: transicao.para, motivo: m });
        deps.depois(t, acao, quem, m);
        subs.depois(t, acao, quem);
        return enviar(200, comContexto({ ...t, state: transicao.para }));
      }
      const respExecucao = rotaExecucao({ repo, store: exec, autor, metodo, path, corpo: corpoJson, antes: (t, a) => deps.antes(t, a) });
      if (respExecucao) {
        const r = await respExecucao;
        return enviar(r.status, r.corpo);
      }
      const respAnexos = rotaAnexos(anexos, req, metodo, path, url.searchParams,
        (tipo, id) => (tipo === "tarefa" ? ctx.tarefaExiste(id) : !!ctx.obter(id)), opts.anexoMaxBytes ?? LIMITE_ANEXO_PADRAO);
      if (respAnexos) {
        const r = await respAnexos;
        if (!r.arquivo) return enviar(r.status, r.corpo);
        audit.registrar(quem, metodo, path, r.status);
        res.writeHead(200, {
          ...cors,
          "content-type": tipoSeguro(r.arquivo.tipo),
          "x-content-type-options": "nosniff",
          "content-disposition": dispositionSegura(r.arquivo.nome),
          "content-length": r.arquivo.dados.length,
        });
        return void res.end(r.arquivo.dados);
      }
      const respDependencias = await deps.rota(metodo, path, autor, corpoJson);
      if (respDependencias) return enviar(respDependencias.status, respDependencias.corpo);
      const matchPrioridade = path.match(/^\/tarefas\/([^/]+)\/prioridade$/);
      if (matchPrioridade && metodo === "PUT") {
        if (!repo.obterTarefa(matchPrioridade[1])) return enviar(404, { error: "Não encontrado" });
        const r = definirPrioridade(prios, matchPrioridade[1], autor, await corpoJson());
        return enviar(r.status, r.corpo);
      }
      const respArea = await area.rota(metodo, path, corpoJson, quem);
      if (respArea) return enviar(respArea.status, respArea.corpo);
      const respConsolidado = rotaConsolidado(cons, (i) => !!ctx.obter(i), (i) => !!repo.obterTarefa(i), quem, metodo, path, corpoJson);
      if (respConsolidado) {
        const r = await respConsolidado;
        return enviar(r.status, r.corpo);
      }
      // Configuração de Contextos é só do humano (agentes só leem).
      const mudaContexto = (metodo === "POST" && path === "/contextos") || (metodo === "PATCH" && /^\/contextos\/[^/]+$/.test(path));
      if (mudaContexto && !humano) return enviar(403, NEGADO);
      const respContextos = rotaContextos(ctx, metodo, path, url.searchParams, corpoJson, () =>
        ordenarPorPrioridade(repo.listarTarefas().map(comContexto)),
      );
      if (respContextos) {
        const r = await respContextos;
        return enviar(r.status, r.corpo);
      }
      if (path === "/tarefas" && metodo === "GET")
        return enviar(200, ordenarPorPrioridade(repo.listarTarefas().map(comContexto)));
      if (path === "/tarefas" && metodo === "POST") {
        const entrada = await corpoJson();
        const contextId = entrada.contextId ?? null;
        if (contextId !== null && (typeof contextId !== "string" || !ctx.obter(contextId)))
          throw new ErroValidacao("Contexto não existe");
        const sc = subs.avaliarCriacao(entrada, autor);
        if ("erro" in sc) return enviar(sc.erro.status, sc.erro.corpo);
        const naExecucao = entrada.phase === "Execução";
        if (naExecucao && !humano) return enviar(403, { error: "Apenas o humano pode criar na Execução" });
        const tarefa = naExecucao ? criarDiretoNaExecucao(exec, autor, entrada) : novaTarefa(entrada);
        if (!naExecucao) repo.inserirTarefa(tarefa);
        ctx.associarTarefa(tarefa.id, contextId);
        if (sc.maeId) subs.vincular(tarefa, sc.maeId, autor);
        return enviar(201, comContexto(tarefa));
      }
      // Tarefa individual (com Subtarefas e resolução) e edição de Subtarefa.
      const matchTarefa = path.match(/^\/tarefas\/([^/]+)$/);
      if (matchTarefa && metodo === "GET") {
        const t = repo.obterTarefa(matchTarefa[1]);
        return t ? enviar(200, comContexto(t)) : enviar(404, { error: "Não encontrado" });
      }
      if (matchTarefa && metodo === "PATCH") {
        const r = await subs.editar(matchTarefa[1], autor, corpoJson);
        return enviar(r.status, r.corpo);
      }
      const matchContextoDaTarefa = path.match(/^\/tarefas\/([^/]+)\/contexto$/);
      if (matchContextoDaTarefa && metodo === "PUT") {
        if (!humano) return enviar(403, NEGADO);
        if (!ctx.tarefaExiste(matchContextoDaTarefa[1])) return enviar(404, { error: "Não encontrado" });
        const { contextId = null } = await corpoJson();
        if (contextId !== null && (typeof contextId !== "string" || !ctx.obter(contextId)))
          throw new ErroValidacao("Contexto não existe");
        ctx.associarTarefa(matchContextoDaTarefa[1], contextId);
        return enviar(200, { id: matchContextoDaTarefa[1], contextId });
      }
      enviar(404, { error: "Não encontrado" });
    } catch (e) {
      if (e instanceof ErroCorpoGrande) return enviar(413, { error: "Corpo da requisição grande demais" });
      if (e instanceof ErroValidacao) return enviar(400, { error: e.message });
      console.error(e);
      enviar(500, { error: "Erro interno" });
    }
  });
  return new Promise((resolve) => {
    server.listen(opts.port, opts.host ?? "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      urlDaemon = `http://127.0.0.1:${port}`;
      resolve({
        url: urlDaemon,
        varrer: async () => void (await orq?.varrer()),
        close: async () => {
          await orq?.parar();
          await orquestrador.encerrar();
          await new Promise<void>((r) => {
            server.close(() => {
              rodadasDb.close();
              repo.close();
              ctx.close();
              audit.close();
              exec.close();
              anexos.close();
              coment.close();
              deps.close();
              prios.close();
              subs.close();
              areaDb.close();
              cons.close();
              buscaDb.close();
              r();
            });
            server.closeAllConnections();
          });
        },
      });
    });
  });
}
