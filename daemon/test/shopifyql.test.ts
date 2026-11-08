import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/api/server.ts";
import { criarShopifyFalso, type ShopifyFalso } from "../src/coleta/shopify-falso.ts";
import { CRED, HUMANO, comToken } from "./helpers.ts";

let daemon: Daemon;
let dir: string;
let loja: ShopifyFalso;
let dormidas: number[];

const VAR_TOKEN = "ATM_SHOPIFYQL_TOKEN_TESTE";
const TOKEN = "shpat_segredo-do-analytics-0123456789";
const DIA = "2026-03-09";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "atm-shopifyql-"));
  process.env[VAR_TOKEN] = TOKEN;
  loja = criarShopifyFalso();
  dormidas = [];
  loja.pedidos.push({ createdAt: "2026-03-09T13:00:00Z", total: 100 }, { createdAt: "2026-03-09T18:00:00Z", total: 200 });
  daemon = await startDaemon({
    dbPath: join(dir, "atm.db"),
    port: 0,
    credenciais: CRED,
    logsDir: join(dir, "logs"),
    coleta: { relogio: () => Date.parse("2026-03-10T12:00:00Z"), shopify: { http: loja.http, dormir: async (ms) => void dormidas.push(ms) } },
  });
});
afterEach(async () => {
  await daemon.close();
  delete process.env[VAR_TOKEN];
  rmSync(dir, { recursive: true, force: true });
});

const send = (method: string, path: string, body?: unknown) =>
  fetch(daemon.url + path, { method, headers: comToken(HUMANO, { "content-type": "application/json" }), body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (method: string, path: string, body?: unknown) => (await send(method, path, body)).json();

const novoColetor = async () => {
  const ctx = (await json("POST", "/contextos", { name: "Loja", kind: "loja" })).id as string;
  const res = await send("POST", "/coletores", {
    contextId: ctx,
    source: "shopify",
    tokenEnv: VAR_TOKEN,
    recollectWindowDays: 1,
    params: { shop: "minha-loja.myshopify.com" },
  });
  assert.equal(res.status, 201);
  return res.json();
};

async function coletar(coletorId: string, period = DIA) {
  const res = await send("POST", `/coletores/${coletorId}/coletas`, { period });
  assert.equal(res.status, 202);
  const { id } = await res.json();
  for (let i = 0; i < 200; i++) {
    const c = await json("GET", `/coletas/${id}`);
    if (c.state !== "em andamento") return c;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("Coleta não terminou");
}

type Linha = { period: string; metric: string; value: number | null };
const consolidado = async (id: string) => {
  const linhas = (await json("GET", `/coletores/${id}/consolidado`)) as Linha[];
  return Object.fromEntries(linhas.filter((l) => l.period === DIA).map((l) => [l.metric, l.value]));
};

test("sessões e conversão são coletadas quando o ShopifyQL responde", async () => {
  loja.analytics[DIA] = { sessions: 800, conversionRate: 0.0025 };
  const c = await novoColetor();
  const coleta = await coletar(c.id);
  assert.equal(coleta.state, "concluída");
  assert.equal(coleta.partial, false);
  const m = await consolidado(c.id);
  assert.equal(m.sessions, 800);
  assert.equal(m.conversion, 0.0025);
  assert.equal(m.orders, 2);
  assert.deepEqual(await json("GET", `/coletores/${c.id}/lacunas`), []);
  // o token vai só no cabeçalho, também na consulta de analytics
  assert.equal(loja.requisicoesAnalytics[0].headers["x-shopify-access-token"], TOKEN);
  assert.ok(!loja.requisicoesAnalytics[0].body.includes(TOKEN));
});

test("falha do ShopifyQL gera Coleta parcial: métricas ausentes (nunca zero) e Lacuna parcial", async () => {
  loja.cenasAnalytics.push({ status: 500, headers: {}, body: "x" }, { status: 502, headers: {}, body: "x" }, { status: 503, headers: {}, body: "x" });
  const c = await novoColetor();
  const coleta = await coletar(c.id);
  assert.equal(coleta.state, "concluída");
  assert.equal(coleta.partial, true);
  assert.equal(loja.requisicoesAnalytics.length, 3);
  assert.deepEqual(dormidas, [1000, 2000]);
  const m = await consolidado(c.id);
  assert.equal(m.orders, 2);
  assert.equal(m.netRevenue, 300);
  assert.equal(m.sessions, null);
  assert.equal(m.conversion, null);
  const [lacuna] = await json("GET", `/coletores/${c.id}/lacunas`);
  assert.equal(lacuna.period, DIA);
  assert.equal(lacuna.partial, true);
  assert.equal(lacuna.cause, "analytics-falhou");
  assert.deepEqual(lacuna.missing, ["conversion", "sessions"]);
  assert.match(lacuna.error, /503/);
  assert.equal(lacuna.recoveredAt, null);
});

test("loja sem acesso a analytics: Coleta parcial pela causa 'analytics-indisponivel', sem retentativa", async () => {
  loja.analyticsSemAcesso = true;
  const c = await novoColetor();
  const coleta = await coletar(c.id);
  assert.equal(coleta.state, "concluída");
  assert.equal(coleta.partial, true);
  assert.equal(loja.requisicoesAnalytics.length, 1);
  assert.deepEqual(dormidas, []);
  const m = await consolidado(c.id);
  assert.equal(m.orders, 2);
  assert.equal(m.conversion, null);
  const [lacuna] = await json("GET", `/coletores/${c.id}/lacunas`);
  assert.equal(lacuna.partial, true);
  assert.equal(lacuna.cause, "analytics-indisponivel");
});

test("resposta do ShopifyQL sem linhas é parcial, não zero", async () => {
  const c = await novoColetor(); // loja.analytics vazio
  const coleta = await coletar(c.id);
  assert.equal(coleta.partial, true);
  assert.equal((await consolidado(c.id)).sessions, null);
});

test("recoletar com analytics disponível completa o período, recupera a Lacuna e gera Revisão", async () => {
  loja.analyticsSemAcesso = true;
  const c = await novoColetor();
  await coletar(c.id);
  loja.analyticsSemAcesso = false;
  loja.analytics[DIA] = { sessions: 800, conversionRate: 0.0025 };
  const coleta = await coletar(c.id);
  assert.equal(coleta.partial, false);
  const m = await consolidado(c.id);
  assert.equal(m.sessions, 800);
  assert.equal(m.conversion, 0.0025);
  const [lacuna] = await json("GET", `/coletores/${c.id}/lacunas`);
  assert.notEqual(lacuna.recoveredAt, null);
  const [revisao] = await json("GET", `/coletores/${c.id}/revisoes`);
  assert.deepEqual(revisao.changes, [
    { metric: "conversion", previous: null, new: 0.0025 },
    { metric: "sessions", previous: null, new: 800 },
  ]);
});

test("recoletar ainda sem analytics não duplica a Lacuna parcial nem gera Revisão", async () => {
  loja.analyticsSemAcesso = true;
  const c = await novoColetor();
  await coletar(c.id);
  await coletar(c.id);
  assert.equal((await json("GET", `/coletores/${c.id}/lacunas`)).length, 1);
  assert.deepEqual(await json("GET", `/coletores/${c.id}/revisoes`), []);
});

test("analytics que falha depois de já ter sido coletado preserva os valores e não abre Lacuna", async () => {
  loja.analytics[DIA] = { sessions: 800, conversionRate: 0.0025 };
  const c = await novoColetor();
  await coletar(c.id);
  loja.analytics = {};
  loja.analyticsSemAcesso = true;
  const coleta = await coletar(c.id);
  assert.equal(coleta.partial, false);
  const m = await consolidado(c.id);
  assert.equal(m.sessions, 800);
  assert.equal(m.conversion, 0.0025);
  assert.deepEqual(await json("GET", `/coletores/${c.id}/lacunas`), []);
  assert.deepEqual(await json("GET", `/coletores/${c.id}/revisoes`), []);
});

test("falha nos pedidos continua sendo Lacuna total (não parcial)", async () => {
  loja.cenas.push({ status: 401, headers: {}, body: {} });
  const c = await novoColetor();
  const coleta = await coletar(c.id);
  assert.equal(coleta.state, "falhou");
  assert.equal(coleta.partial, false);
  const [lacuna] = await json("GET", `/coletores/${c.id}/lacunas`);
  assert.equal(lacuna.partial, false);
  assert.equal(lacuna.cause, null);
  assert.deepEqual(lacuna.missing, []);
});
