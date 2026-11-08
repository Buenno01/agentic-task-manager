import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/api/server.ts";
import { criarClienteFalso, type ClienteFalso } from "../src/coleta/falso.ts";
import { CRED, HUMANO, comToken } from "./helpers.ts";

const VAR_TOKEN = "ATM_ANALISE_TOKEN";
let dir: string;
let cliente: ClienteFalso;
let agoraMs: number;
let daemons: Daemon[];

const iniciar = async () => {
  const d = await startDaemon({
    dbPath: join(dir, "atm.db"),
    port: 0,
    credenciais: CRED,
    logsDir: join(dir, "logs"),
    coleta: { cliente, relogio: () => agoraMs, agendador: { agendar: () => () => {} } },
  });
  daemons.push(d);
  return d;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atm-analise-"));
  process.env[VAR_TOKEN] = "segredo-analise-0123456789";
  agoraMs = Date.parse("2026-03-10T12:00:00Z"); // terça, 09:00 em São Paulo
  cliente = criarClienteFalso();
  daemons = [];
});
afterEach(async () => {
  for (const d of daemons) await d.close();
  delete process.env[VAR_TOKEN];
  rmSync(dir, { recursive: true, force: true });
});

const send = (d: Daemon, method: string, path: string, body?: unknown) =>
  fetch(d.url + path, {
    method,
    headers: comToken(HUMANO, { "content-type": "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (d: Daemon, method: string, path: string, body?: unknown) => (await send(d, method, path, body)).json();

async function novoColetor(d: Daemon, extra: Record<string, unknown> = {}, ctxExtra: Record<string, unknown> = {}) {
  const ctx = (await json(d, "POST", "/contextos", { name: "Loja Wine", kind: "loja", ...ctxExtra })).id as string;
  const res = await send(d, "POST", "/coletores", { contextId: ctx, source: "falso", tokenEnv: VAR_TOKEN, recollectWindowDays: 1, ...extra });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  return { ...(await res.json()), contextId: ctx } as { id: string; contextId: string };
}

async function coletar(d: Daemon, coletorId: string, period: string) {
  const res = await send(d, "POST", `/coletores/${coletorId}/coletas`, { period });
  assert.equal(res.status, 202);
  const { id } = await res.json();
  for (let i = 0; i < 200; i++) {
    const c = await json(d, "GET", `/coletas/${id}`);
    if (c.state !== "em andamento") return c;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("Coleta não terminou");
}

interface TarefaApi {
  id: string;
  title: string;
  description: string;
  phase: string;
  state: string;
  contextId: string | null;
  priority: { nivel: string; justificativa: { impacto: string; urgencia: string; esforco: string }; origem: string };
}
const analises = async (d: Daemon) =>
  ((await json(d, "GET", "/tarefas")) as TarefaApi[]).filter((t) => t.title.startsWith("Análise de monitoramento"));
const evidencias = async (d: Daemon, id: string) =>
  ((await json(d, "GET", `/tarefas/${id}/eventos`)) as { autor: string; tipo: string; texto: string }[]).filter((c) => c.autor === "monitoramento" && c.tipo === "comentario");

const ALVO = "2026-03-02";
const SEGUNDAS = ["2026-02-02", "2026-02-09", "2026-02-16", "2026-02-23"];
const metricas = (orders: number, netRevenue = 1000) => ({ orders, netRevenue, averageTicket: 50, conversion: 2 });

/** Quatro segundas estáveis e um alvo; devolve depois de coletar o alvo (a Anomalia nasce nessa Coleta). */
async function semear(d: Daemon, coletorId: string, alvo: ReturnType<typeof metricas>) {
  for (const p of SEGUNDAS) {
    cliente.definir(p, { moeda: "BRL", metricas: metricas(20) });
    await coletar(d, coletorId, p);
  }
  cliente.definir(ALVO, { moeda: "BRL", metricas: alvo });
  await coletar(d, coletorId, ALVO);
  // A varredura do agendador completa os dias restantes; a segunda seguinte fica na média para não gerar Anomalia extra.
  cliente.definir("2026-03-09", { moeda: "BRL", metricas: metricas(20) });
}

test("Anomalia cria Tarefa de análise no Contexto do Coletor, com evidência, prioridade média e justificativa", async () => {
  const d = await iniciar();
  const c = await novoColetor(d, {}, { instructions: "Falar de vinhos em reais; ignorar frete." });
  await semear(d, c.id, metricas(10)); // pedidos 20 -> 10 = -50%
  const ts = await analises(d);
  assert.equal(ts.length, 1);
  const t = ts[0];
  assert.equal(t.contextId, c.contextId);
  assert.equal(t.phase, "Exploração");
  assert.equal(t.state, "Novo");
  assert.equal(t.priority.nivel, "média");
  assert.ok(t.priority.justificativa.impacto && t.priority.justificativa.urgencia && t.priority.justificativa.esforco);
  // corpo = template fixo + instruções do Contexto
  assert.match(t.description, /não altere nada/i);
  assert.match(t.description, /Falar de vinhos em reais; ignorar frete\./);
  const ev = await evidencias(d, t.id);
  assert.equal(ev.length, 1);
  assert.match(ev[0].texto, /orders/);
  assert.match(ev[0].texto, new RegExp(ALVO));
  assert.match(ev[0].texto, /-50/);
});

test("novas Anomalias e fechamentos se anexam à Tarefa de análise aberta, sem criar outra", async () => {
  const d = await iniciar();
  const c = await novoColetor(d);
  await semear(d, c.id, metricas(10, 500)); // pedidos e receita fora do limiar: duas Anomalias numa Coleta
  let ts = await analises(d);
  assert.equal(ts.length, 1);
  const antes = (await evidencias(d, ts[0].id)).length;
  assert.equal(antes, 2);
  // Um Coletor existente há uma semana: o fechamento semanal seguinte anexa à Tarefa aberta, sem criar outra.
  await d.varrerColetas(); // registra o fechamento já ocorrido (não gera nada)
  agoraMs = Date.parse("2026-03-16T12:00:00Z");
  await d.varrerColetas();
  ts = await analises(d);
  assert.equal(ts.length, 1);
  const ev = await evidencias(d, ts[0].id);
  assert.ok(ev.length > antes);
  assert.equal(ev.filter((e) => /Fechamento semanal/.test(e.texto)).length, 1);
});

test("Tarefa de análise rejeitada deixa de ser 'aberta': o próximo evento cria outra", async () => {
  const d = await iniciar();
  const c = await novoColetor(d);
  await semear(d, c.id, metricas(10));
  const [primeira] = await analises(d);
  assert.equal((await send(d, "POST", `/tarefas/${primeira.id}/rejeitar`, {})).status, 200);
  await d.varrerColetas(); // registra o fechamento já ocorrido
  agoraMs = Date.parse("2026-03-16T12:00:00Z");
  await d.varrerColetas(); // fechamento semanal
  const ts = await analises(d);
  assert.equal(ts.length, 2);
  const nova = ts.find((t) => t.id !== primeira.id)!;
  assert.equal(nova.state, "Novo");
  assert.equal((await evidencias(d, primeira.id)).length, 1);
});

test("com analise_automatica a Tarefa nasce 'Autorizada para explorar', com a pré-autorização no histórico", async () => {
  const d = await iniciar();
  const c = await novoColetor(d, { automaticAnalysis: true });
  await semear(d, c.id, metricas(10));
  const [t] = await analises(d);
  assert.equal(t.state, "Autorizada para explorar");
  assert.equal(t.phase, "Exploração");
  const eventos = (await json(d, "GET", `/tarefas/${t.id}/eventos`)) as { autor: string; tipo: string; para: string; motivo: string }[];
  const auto = eventos.find((e) => e.para === "Autorizada para explorar");
  assert.ok(auto);
  assert.equal(auto.autor, "monitoramento");
  assert.match(auto.motivo, /analise_automatica|análise automática/i);
});

test("Coletor novo não gera análise do fechamento passado; só os fechamentos seguintes valem, sem repetir", async () => {
  const d = await iniciar();
  const c = await novoColetor(d);
  await d.varrerColetas(); // backfill; terça 10/03 09:00: o fechamento de 09/03 é anterior ao Coletor
  assert.deepEqual(await analises(d), []);
  agoraMs = Date.parse("2026-03-16T12:00:00Z"); // segunda 16/03 09:00: fechou a semana de 09 a 15/03
  await d.varrerColetas();
  const ts = await analises(d);
  assert.equal(ts.length, 1);
  assert.equal(ts[0].contextId, c.contextId);
  const ev = await evidencias(d, ts[0].id);
  assert.equal(ev.length, 1);
  assert.match(ev[0].texto, /2026-03-09/);
  assert.match(ev[0].texto, /2026-03-15/);
  await d.varrerColetas();
  assert.equal((await evidencias(d, ts[0].id)).length, 1);
});

test("backfill de histórico não cria Anomalia nem Tarefa de análise", async () => {
  // Um mês de histórico com um dia fora do padrão no meio: Coletor novo, nada de Anomalia por histórico.
  cliente.definir("2026-02-10", { moeda: "BRL", metricas: metricas(1) });
  for (const p of ["2026-01-13", "2026-01-20", "2026-01-27", "2026-02-03"]) cliente.definir(p, { moeda: "BRL", metricas: metricas(20) });
  const d = await iniciar();
  const c = await novoColetor(d);
  await d.varrerColetas();
  assert.deepEqual(await json(d, "GET", `/coletores/${c.id}/anomalias`), []);
  assert.deepEqual(await analises(d), []);
});

test("segunda antes das 07:00 ainda não fechou a semana: vale o fechamento da segunda anterior", async () => {
  agoraMs = Date.parse("2026-03-09T09:30:00Z"); // segunda 06:30 em São Paulo
  const d = await iniciar();
  await novoColetor(d);
  await d.varrerColetas(); // registra o fechamento de 02/03 (o de 09/03 ainda não ocorreu)
  assert.deepEqual(await analises(d), []);
  agoraMs = Date.parse("2026-03-09T10:30:00Z"); // 07:30: fechou a semana de 02 a 08/03
  await d.varrerColetas();
  const [t] = await analises(d);
  const [e] = await evidencias(d, t.id);
  assert.match(e.texto, /2026-03-02/);
  assert.match(e.texto, /2026-03-08/);
});

test("frequência de fechamento: 'mensal' analisa o mês anterior; 'nenhum' não fecha", async () => {
  const d = await iniciar();
  const mensal = await novoColetor(d, { params: { closingFrequency: "mensal" } });
  await d.varrerColetas();
  agoraMs = Date.parse("2026-04-01T12:00:00Z"); // 1º de abril 09:00: fechou março
  await d.varrerColetas();
  const [t] = await analises(d);
  assert.equal(t.contextId, mensal.contextId);
  const [e] = await evidencias(d, t.id);
  assert.match(e.texto, /Fechamento mensal/);
  assert.match(e.texto, /2026-03-01/);
  assert.match(e.texto, /2026-03-31/);
});

test("fechamento 'nenhum' não cria Tarefa", async () => {
  const d = await iniciar();
  await novoColetor(d, { params: { closingFrequency: "nenhum" } });
  await d.varrerColetas();
  assert.deepEqual(await analises(d), []);
});

test("closingFrequency inválido é recusado na criação do Coletor", async () => {
  const d = await iniciar();
  const ctx = await json(d, "POST", "/contextos", { name: "Loja", kind: "loja" });
  const res = await send(d, "POST", "/coletores", { contextId: ctx.id, source: "falso", tokenEnv: VAR_TOKEN, params: { closingFrequency: "anual" } });
  assert.equal(res.status, 400);
});

test("fechamentos perdidos com a máquina desligada são recuperados no boot, todos, sem teto", async () => {
  agoraMs = Date.parse("2026-03-02T12:00:00Z"); // segunda 09:00 SP
  let d = await iniciar();
  const c = await novoColetor(d);
  await d.varrerColetas(); // registra o fechamento de 02/03
  agoraMs = Date.parse("2026-03-09T12:00:00Z");
  await d.varrerColetas(); // fechamento de 09/03
  const [primeira] = await analises(d);
  assert.equal((await send(d, "POST", `/tarefas/${primeira.id}/rejeitar`, {})).status, 200);
  await d.close();
  daemons = [];
  // máquina desligada por 12 semanas: 12 fechamentos ficaram para trás (mais que qualquer teto razoável)
  agoraMs = Date.parse("2026-06-01T12:00:00Z");
  d = await iniciar();
  await d.varrerColetas();
  const ts = (await analises(d)).filter((t) => t.id !== primeira.id);
  assert.equal(ts.length, 1);
  const ev = await evidencias(d, ts[0].id);
  assert.equal(ev.length, 12);
  const texto = ev.map((e) => e.texto).join("\n");
  assert.match(texto, /2026-03-09/); // semana fechada em 16/03
  assert.match(texto, /2026-05-25/); // semana fechada em 01/06
  assert.equal(c.contextId, ts[0].contextId);
});
