import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startDaemon, type Daemon } from "../../daemon/src/api/server.ts";
import { iniciarMcpHttp, type McpHttp } from "../src/http.ts";
import { criarClienteFalso, type ClienteFalso } from "../../daemon/src/coleta/falso.ts";

const HUMANO = "tok-humano";
const AGENTE = "tok-agente";
let daemon: Daemon;
let mcp: McpHttp;
let dir: string;
let client: Client;
let tokensVistos: (string | undefined)[];
let cliente: ClienteFalso;
const VAR_TOKEN = "ATM_MCP_COLETOR_TOKEN";

beforeEach(async () => {
  process.env[VAR_TOKEN] = "segredo-do-coletor-mcp-0123456789";
  cliente = criarClienteFalso();
  dir = mkdtempSync(join(tmpdir(), "atm-mcp-"));
  daemon = await startDaemon({
    dbPath: join(dir, "atm.db"),
    port: 0,
    credenciais: { humano: HUMANO, agentes: { "agente-a": AGENTE } },
    logsDir: join(dir, "logs"),
    coleta: { cliente, relogio: () => Date.parse("2026-03-10T12:00:00Z") },
  });
  tokensVistos = [];
  const fetchEspiao: typeof fetch = (input, init) => {
    tokensVistos.push(new Headers(init?.headers).get("authorization") ?? undefined);
    return fetch(input, init);
  };
  mcp = await iniciarMcpHttp({ apiUrl: daemon.url, token: AGENTE, port: 0, fetch: fetchEspiao });
  client = new Client({ name: "teste", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: { authorization: `Bearer ${AGENTE}` } } }),
  );
});
afterEach(async () => {
  await client.close();
  await mcp.close();
  await daemon.close();
  delete process.env[VAR_TOKEN];
  rmSync(dir, { recursive: true, force: true });
});

const humano = (method: string, path: string, body?: unknown) =>
  fetch(daemon.url + path, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${HUMANO}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function chamar(name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  const texto = (r.content as { type: string; text: string }[])[0].text;
  return { erro: !!r.isError, texto, json: () => JSON.parse(texto) };
}

test("expõe só ferramentas de leitura/criação/entrega, nenhuma de aprovação, transição ou escrita de Coleta", async () => {
  const nomes = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(nomes, [
    "buscar", "checkpoint", "comentar", "criar_subtarefa", "criar_tarefa", "entregar",
    "ler_anomalias", "ler_coleta", "ler_coletor", "ler_contexto", "ler_lacunas", "ler_produtos", "ler_revisoes", "ler_serie", "ler_tarefa",
    "listar_coletas", "listar_coletores", "perguntar",
  ]);
});

async function coletar(coletorId: string, period: string) {
  const res = await humano("POST", `/coletores/${coletorId}/coletas`, { period });
  const { id } = (await res.json()) as { id: string };
  for (let i = 0; i < 200; i++) {
    const c = (await (await humano("GET", `/coletas/${id}`)).json()) as { state: string };
    if (c.state !== "em andamento") return id;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("Coleta não terminou");
}

async function semearAnomalia() {
  const ctx = (await (await humano("POST", "/contextos", { name: "Loja", kind: "loja" })).json()) as { id: string };
  const c = (await (await humano("POST", "/coletores", { contextId: ctx.id, source: "falso", tokenEnv: VAR_TOKEN, recollectWindowDays: 1 })).json()) as { id: string };
  const m = (orders: number) => ({ orders, netRevenue: 1000, averageTicket: 50, conversion: 2, "produto:7:unidades": orders, "produto:7:receita": orders * 50 });
  for (const p of ["2026-02-02", "2026-02-09", "2026-02-16", "2026-02-23"]) {
    cliente.definir(p, { moeda: "BRL", metricas: m(20) });
    await coletar(c.id, p);
  }
  cliente.definir("2026-03-02", { moeda: "BRL", metricas: m(10) });
  const coletaId = await coletar(c.id, "2026-03-02");
  return { coletorId: c.id, coletaId };
}

test("agente de análise lê Coletores, Coletas, Anomalias, séries e quebra por produto só pelo MCP", async () => {
  const { coletorId, coletaId } = await semearAnomalia();
  assert.equal((await chamar("listar_coletores", {})).json().length, 1);
  assert.equal((await chamar("ler_coletor", { coletorId })).json().id, coletorId);
  assert.equal((await chamar("listar_coletas", { coletorId })).json().length, 5);
  assert.equal((await chamar("ler_coleta", { coletaId })).json().id, coletaId);
  const anomalias = (await chamar("ler_anomalias", { coletorId })).json();
  assert.equal(anomalias.length, 1);
  assert.equal(anomalias[0].metric, "orders");
  assert.equal(anomalias[0].variation, -50);
  const serie = (await chamar("ler_serie", { coletorId, metrica: "orders" })).json();
  assert.equal(serie.find((p: { period: string }) => p.period === "2026-03-02").value, 10);
  const produtos = (await chamar("ler_produtos", { coletorId })).json();
  assert.deepEqual(produtos.find((p: { period: string }) => p.period === "2026-03-02"), { period: "2026-03-02", productId: "7", units: 10, revenue: 500 });
  assert.deepEqual((await chamar("ler_lacunas", { coletorId })).json(), []);
  assert.ok(Array.isArray((await chamar("ler_revisoes", { coletorId })).json()));
  assert.match((await chamar("ler_coletor", { coletorId: "nada" })).texto, /404/);
});

test("com o que leu, o agente cria uma Tarefa Novo com evidências", async () => {
  const { coletorId } = await semearAnomalia();
  const [a] = (await chamar("ler_anomalias", { coletorId })).json();
  const t = (await chamar("criar_tarefa", {
    title: "Investigar queda de pedidos",
    description: `Anomalia ${a.id}: ${a.metric} em ${a.period}, valor ${a.value} contra base ${a.base} (${a.variation}%).`,
  })).json();
  assert.equal(t.state, "Novo");
  assert.match((await chamar("ler_tarefa", { id: t.id })).json().tarefa.description, /orders em 2026-03-02, valor 10 contra base 20/);
});

test("perguntar e entregar repassam a API; checkpoint sem Rodada é recusado; aprovar continua do humano", async () => {
  const id = (await (await humano("POST", "/tarefas", { title: "T" })).json() as { id: string }).id;
  await humano("POST", `/tarefas/${id}/autorizar`);
  await humano("POST", `/tarefas/${id}/iniciar`);
  assert.equal((await chamar("checkpoint", { tarefaId: id, progresso: "p" })).erro, true);
  assert.equal((await chamar("perguntar", { tarefaId: id, texto: "Posso?" })).erro, false);
  assert.equal(((await (await humano("GET", `/tarefas/${id}`)).json()) as { state: string }).state, "Aguardando humano");
  // Pergunta sem resposta bloqueia a entrega (409); a resposta do humano devolve a Tarefa à Exploração.
  assert.equal((await chamar("entregar", { tarefaId: id, resumo: "ok" })).erro, true);
  const hist = (await (await humano("GET", `/tarefas/${id}/eventos`)).json()) as { id: string; tipo: string }[];
  const pergunta = hist.find((e) => e.tipo === "pergunta")!;
  await humano("POST", `/tarefas/${id}/comentarios`, { tipo: "resposta", respondeA: pergunta.id, texto: "pode" });
  assert.equal((await chamar("entregar", { tarefaId: id, resumo: "ok" })).erro, false);
  assert.equal(((await (await humano("GET", `/tarefas/${id}`)).json()) as { state: string }).state, "Plano pronto para aprovação");
});

test("criar_tarefa cria em Novo e o agente não consegue aprová-la", async () => {
  const t = (await chamar("criar_tarefa", { title: "Investigar X", description: "detalhes" })).json();
  assert.equal(t.state, "Novo");
  assert.equal(t.phase, "Exploração");
  const lida = (await chamar("ler_tarefa", { id: t.id })).json();
  assert.equal(lida.tarefa.state, "Novo");
  // Com o token que o MCP usa, a API recusa a aprovação.
  const r = await fetch(`${daemon.url}/tarefas/${t.id}/aprovar`, { method: "POST", headers: { authorization: `Bearer ${AGENTE}` } });
  assert.equal(r.status, 403);
  assert.equal((await (await humano("GET", `/tarefas/${t.id}`)).json()).state, "Novo");
});

test("criar_subtarefa cria Subtarefa em Novo ligada à mãe; mãe inexistente devolve o erro da API", async () => {
  const mae = (await chamar("criar_tarefa", { title: "Mãe" })).json();
  const sub = (await chamar("criar_subtarefa", { parentId: mae.id, title: "Filha" })).json();
  assert.equal(sub.state, "Novo");
  assert.equal(sub.maeId, mae.id);
  const lida = (await chamar("ler_tarefa", { id: mae.id })).json();
  assert.equal(lida.tarefa.subtarefas[0].id, sub.id);
  const ruim = await chamar("criar_subtarefa", { parentId: "nao-existe", title: "x" });
  assert.equal(ruim.erro, true);
  assert.match(ruim.texto, /404/);
});

test("comentar registra comentário do agente e ler_tarefa devolve os eventos", async () => {
  const t = (await chamar("criar_tarefa", { title: "T" })).json();
  const p = (await chamar("comentar", { tarefaId: t.id, tipo: "pergunta", texto: "Qual o escopo?" })).json();
  assert.equal(p.autor, "agente:agente-a");
  await chamar("comentar", { tarefaId: t.id, tipo: "resposta", texto: "Todo", respondeA: p.id });
  const lida = (await chamar("ler_tarefa", { id: t.id })).json();
  assert.deepEqual(lida.eventos.map((e: { texto?: string }) => e.texto).filter(Boolean), ["Qual o escopo?", "Todo"]);
  const ruim = await chamar("comentar", { tarefaId: t.id, texto: "  " });
  assert.equal(ruim.erro, true);
  assert.match(ruim.texto, /400/);
});

test("ler_contexto devolve o contexto resolvido e o consolidado", async () => {
  const c = await (await humano("POST", "/contextos", { name: "Projeto", kind: "projeto", instructions: "Regra A" })).json();
  await humano("PUT", `/contextos/${c.id}/consolidado`, { text: "Resumo consolidado do projeto" });
  const r = (await chamar("ler_contexto", { contextoId: c.id })).json();
  assert.equal(r.consolidado.version, 1);
  assert.equal(r.consolidado.text, "Resumo consolidado do projeto");
  assert.ok(r.resolvido);
  const ruim = await chamar("ler_contexto", { contextoId: "nada" });
  assert.equal(ruim.erro, true);
  assert.match(ruim.texto, /404/);
});

test("buscar encontra tarefas e respeita o filtro de contexto", async () => {
  await chamar("criar_tarefa", { title: "Migrar banco de dados" });
  const r = (await chamar("buscar", { q: "banco" })).json();
  assert.equal(r.length, 1);
  assert.equal(r[0].tipo, "tarefa");
  const vazia = await chamar("buscar", { q: "!!!" });
  assert.equal(vazia.erro, true);
  assert.match(vazia.texto, /400/);
});

test("toda chamada à API usa o token do agente", async () => {
  await chamar("criar_tarefa", { title: "T" });
  await chamar("buscar", { q: "T" });
  assert.ok(tokensVistos.length >= 2);
  assert.ok(tokensVistos.every((a) => a === `Bearer ${AGENTE}`));
});

test("o MCP http rejeita requisições sem bearer ou com token errado", async () => {
  const corpo = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  assert.equal((await fetch(mcp.url, { method: "POST", headers, body: corpo })).status, 401);
  assert.equal((await fetch(mcp.url, { method: "POST", headers: { ...headers, authorization: "Bearer errado" }, body: corpo })).status, 401);
  assert.equal((await fetch(mcp.url, { method: "POST", headers: { ...headers, authorization: `Bearer ${HUMANO}` }, body: corpo })).status, 401);
});
