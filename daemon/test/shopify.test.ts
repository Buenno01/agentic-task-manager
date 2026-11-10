import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/api/server.ts";
import { esperaDoRetryAfter } from "../src/coleta/shopify.ts";
import { criarShopifyFalso, type ShopifyFalso } from "../src/coleta/shopify-falso.ts";
import { CRED, HUMANO, comToken } from "./helpers.ts";

let daemon: Daemon;
let dir: string;
let loja: ShopifyFalso;
let dormidas: number[];

const VAR_TOKEN = "ATM_SHOPIFY_TOKEN_TESTE";
const TOKEN = "shpat_segredo-da-loja-0123456789";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "atm-shopify-"));
  process.env[VAR_TOKEN] = TOKEN;
  loja = criarShopifyFalso();
  dormidas = [];
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

const novoColetor = async (params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
  const ctx = (await json("POST", "/contextos", { name: "Loja", kind: "loja" })).id as string;
  const res = await send("POST", "/coletores", {
    contextId: ctx,
    source: "shopify",
    tokenEnv: VAR_TOKEN,
    recollectWindowDays: 1,
    params: { shop: "minha-loja.myshopify.com", ...params },
    ...extra,
  });
  assert.equal(res.status, 201);
  return res.json();
};

async function coletar(coletorId: string, period: string) {
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

type Linha = { period: string; metric: string; value: number | null; currency: string };
const consolidado = async (id: string, period: string) => {
  const linhas = (await json("GET", `/coletores/${id}/consolidado`)) as Linha[];
  return Object.fromEntries(linhas.filter((l) => l.period === period).map((l) => [l.metric, l.value]));
};

const DIA = "2026-03-09";
// Fuso padrão America/Sao_Paulo (UTC-3): o dia 2026-03-09 vai de 03-09T03:00Z a 03-10T03:00Z.
const pedidosDoDia = () => {
  loja.pedidos.push(
    { createdAt: "2026-03-09T13:00:00Z", total: 100, refunded: 20, linhas: [{ productId: 1, quantity: 2, total: 60 }, { productId: 2, quantity: 1, total: 40 }] },
    { createdAt: "2026-03-09T18:00:00Z", total: 200, linhas: [{ productId: 1, quantity: 3, total: 200 }] },
  );
};

test("a Coleta grava pedidos, receitas, reembolsos, ticket médio, unidades e quebra por produto", async () => {
  pedidosDoDia();
  const c = await novoColetor();
  const coleta = await coletar(c.id, DIA);
  assert.equal(coleta.state, "concluída");
  const m = await consolidado(c.id, DIA);
  assert.equal(m.orders, 2);
  assert.equal(m.grossRevenue, 300);
  assert.equal(m.refunds, 20);
  assert.equal(m.netRevenue, 280);
  assert.equal(m.averageTicket, 140);
  assert.equal(m.units, 6);
  assert.equal(m["produto:1:unidades"], 5);
  assert.equal(m["produto:1:receita"], 260);
  assert.equal(m["produto:2:unidades"], 1);
  assert.equal(m["produto:2:receita"], 40);
  // sessões e conversão ainda não vêm daqui: ausentes, nunca zero
  assert.equal(m.conversion ?? null, null);
});

test("dia sem pedidos tem zero pedidos e ticket médio ausente", async () => {
  const c = await novoColetor();
  await coletar(c.id, DIA);
  const m = await consolidado(c.id, DIA);
  assert.equal(m.orders, 0);
  assert.equal(m.netRevenue, 0);
  assert.equal(m.averageTicket ?? null, null);
});

test("o dia civil segue o fuso da loja e a moeda fica no Snapshot", async () => {
  loja.moeda = "USD";
  loja.pedidos.push(
    { createdAt: "2026-03-09T02:30:00Z", total: 10 }, // 23:30 de 03-08 em São Paulo
    { createdAt: "2026-03-09T03:30:00Z", total: 20 }, // 00:30 de 03-09
    { createdAt: "2026-03-10T02:30:00Z", total: 40 }, // 23:30 de 03-09
    { createdAt: "2026-03-10T03:30:00Z", total: 80 }, // 00:30 de 03-10
  );
  const c = await novoColetor();
  await coletar(c.id, DIA);
  const m = await consolidado(c.id, DIA);
  assert.equal(m.orders, 2);
  assert.equal(m.grossRevenue, 60);
  const linhas = (await json("GET", `/coletores/${c.id}/consolidado`)) as Linha[];
  assert.ok(linhas.every((l) => l.currency === "USD"));
  assert.ok(linhas.length > 0);
});

test("outro fuso muda a janela do dia", async () => {
  // Tóquio (UTC+9): 2026-03-09 vai de 03-08T15:00Z a 03-09T15:00Z.
  loja.pedidos.push({ createdAt: "2026-03-08T16:00:00Z", total: 10 }, { createdAt: "2026-03-09T16:00:00Z", total: 20 });
  const c = await novoColetor({ timezone: "Asia/Tokyo" });
  await coletar(c.id, DIA);
  const m = await consolidado(c.id, DIA);
  assert.equal(m.orders, 1);
  assert.equal(m.grossRevenue, 10);
});

test("pagina os pedidos até o fim", async () => {
  pedidosDoDia();
  loja.porPagina = 1;
  const c = await novoColetor();
  await coletar(c.id, DIA);
  assert.equal((await consolidado(c.id, DIA)).orders, 2);
  assert.equal(loja.requisicoes.length, 2);
});

test("envia o token só no cabeçalho de acesso, para a loja e versão da API configuradas", async () => {
  const c = await novoColetor({ apiVersion: "2026-01" });
  await coletar(c.id, DIA);
  const req = loja.requisicoes[0];
  assert.equal(req.headers["x-shopify-access-token"], TOKEN);
  assert.equal(req.url, "https://minha-loja.myshopify.com/admin/api/2026-01/graphql.json");
  assert.ok(!req.body.includes(TOKEN));
});

test("429 respeita Retry-After e a Coleta conclui na tentativa seguinte", async () => {
  pedidosDoDia();
  loja.cenas.push({ status: 429, headers: { "retry-after": "7" }, body: {} });
  const c = await novoColetor();
  const coleta = await coletar(c.id, DIA);
  assert.equal(coleta.state, "concluída");
  assert.deepEqual(dormidas, [7000]);
  assert.equal((await consolidado(c.id, DIA)).orders, 2);
});

test("5xx e timeout são retentados com backoff exponencial", async () => {
  pedidosDoDia();
  loja.cenas.push({ status: 503, headers: {}, body: "indisponível" }, { erro: "timeout" });
  const c = await novoColetor();
  const coleta = await coletar(c.id, DIA);
  assert.equal(coleta.state, "concluída");
  assert.deepEqual(dormidas, [1000, 2000]);
  assert.equal(loja.requisicoes.length, 3);
});

test("esgotadas as 3 tentativas a falha vira Lacuna", async () => {
  loja.cenas.push({ status: 500, headers: {}, body: "erro" }, { status: 502, headers: {}, body: "erro" }, { status: 503, headers: {}, body: "erro" });
  const c = await novoColetor();
  const coleta = await coletar(c.id, DIA);
  assert.equal(coleta.state, "falhou");
  assert.equal(loja.requisicoes.length, 3);
  assert.deepEqual(dormidas, [1000, 2000]);
  const [lacuna] = await json("GET", `/coletores/${c.id}/lacunas`);
  assert.equal(lacuna.period, DIA);
  assert.match(lacuna.error, /503/);
  assert.equal(lacuna.recoveredAt, null);
});

test("timeout em todas as tentativas vira Lacuna", async () => {
  loja.cenas.push({ erro: "timeout" }, { erro: "timeout" }, { erro: "timeout" });
  const c = await novoColetor();
  const coleta = await coletar(c.id, DIA);
  assert.equal(coleta.state, "falhou");
  const [lacuna] = await json("GET", `/coletores/${c.id}/lacunas`);
  assert.match(lacuna.error, /timeout/i);
});

test("401 e 403 não são retentados e a Lacuna diz que a credencial foi recusada", async () => {
  for (const status of [401, 403]) {
    loja.requisicoes.length = 0;
    loja.cenas.push({ status, headers: {}, body: { errors: "[API] Invalid API key or access token" } });
    const c = await novoColetor();
    const coleta = await coletar(c.id, DIA);
    assert.equal(coleta.state, "falhou");
    assert.equal(loja.requisicoes.length, 1);
    assert.deepEqual(dormidas, []);
    const [lacuna] = await json("GET", `/coletores/${c.id}/lacunas`);
    assert.match(lacuna.error, new RegExp(String(status)));
  }
});

test("o custo do GraphQL espaça as páginas: espera o balde repor antes da próxima", async () => {
  pedidosDoDia();
  loja.porPagina = 1;
  loja.custo = { requestedQueryCost: 100, currentlyAvailable: 20, restoreRate: 50 };
  const c = await novoColetor();
  await coletar(c.id, DIA);
  assert.deepEqual(dormidas, [2000]); // (100 - 20) / 50 = 1,6 s, arredondado para cima
});

test("THROTTLED no corpo 200 é retentado esperando o custo", async () => {
  pedidosDoDia();
  loja.cenas.push({
    status: 200,
    headers: {},
    body: { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }], extensions: { cost: { requestedQueryCost: 200, throttleStatus: { currentlyAvailable: 0, restoreRate: 50 } } } },
  });
  const c = await novoColetor();
  const coleta = await coletar(c.id, DIA);
  assert.equal(coleta.state, "concluída");
  assert.deepEqual(dormidas, [4000]);
});

test("o token não aparece em banco, logs nem erros", async () => {
  loja.cenas.push({ status: 500, headers: {}, body: `falha ecoando ${TOKEN}` }, { status: 500, headers: {}, body: `falha ecoando ${TOKEN}` }, { status: 500, headers: {}, body: `falha ecoando ${TOKEN}` });
  const c = await novoColetor();
  const coleta = await coletar(c.id, DIA);
  assert.equal(coleta.state, "falhou");
  assert.ok(!JSON.stringify(coleta).includes(TOKEN));
  assert.ok(!JSON.stringify(await json("GET", `/coletores/${c.id}/lacunas`)).includes(TOKEN));
  assert.ok(!JSON.stringify(c).includes(TOKEN));
  await coletar(c.id, DIA); // sucesso
  const arquivos = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? arquivos(join(d, e.name)) : [join(d, e.name)]));
  for (const f of arquivos(dir)) assert.ok(!readFileSync(f).includes(TOKEN), `${f} contém o token`);
});

test("Coletor Shopify exige a loja nos params", async () => {
  const ctx = (await json("POST", "/contextos", { name: "Loja", kind: "loja" })).id as string;
  const res = await send("POST", "/coletores", { contextId: ctx, source: "shopify", tokenEnv: VAR_TOKEN, params: {} });
  assert.equal(res.status, 400);
  const res2 = await send("POST", "/coletores", { contextId: ctx, source: "shopify", tokenEnv: VAR_TOKEN, params: { shop: "https://evil.example.com/x" } });
  assert.equal(res2.status, 400);
});

test("Retry-After também vale para 5xx", async () => {
  pedidosDoDia();
  loja.cenas.push({ status: 503, headers: { "retry-after": "5" }, body: "indisponível" });
  const c = await novoColetor();
  assert.equal((await coletar(c.id, DIA)).state, "concluída");
  assert.deepEqual(dormidas, [5000]);
});

test("Retry-After em data HTTP é convertido pela diferença para o relógio", async () => {
  assert.equal(esperaDoRetryAfter("Tue, 10 Mar 2026 12:00:09 GMT", Date.parse("2026-03-10T12:00:00Z")), 9000);
  assert.equal(esperaDoRetryAfter("Tue, 10 Mar 2026 11:00:00 GMT", Date.parse("2026-03-10T12:00:00Z")), 0);
  assert.equal(esperaDoRetryAfter("abc", 0), undefined);
  assert.equal(esperaDoRetryAfter(undefined, 0), undefined);
});

test("esperas do servidor são limitadas a 60 s (Retry-After e custo GraphQL)", async () => {
  pedidosDoDia();
  loja.cenas.push({ status: 429, headers: { "retry-after": "86400" }, body: {} });
  loja.porPagina = 1;
  loja.custo = { requestedQueryCost: 100000, currentlyAvailable: 0, restoreRate: 1 };
  const c = await novoColetor();
  assert.equal((await coletar(c.id, DIA)).state, "concluída");
  assert.ok(dormidas.length >= 2);
  assert.ok(dormidas.every((ms) => ms <= 60_000), JSON.stringify(dormidas));
  assert.equal(dormidas[0], 60_000);
});

test("em erro, a resposta crua (mascarada) vai para o disco de logs; sucesso não grava nada", async () => {
  pedidosDoDia();
  const c = await novoColetor();
  await coletar(c.id, DIA);
  assert.equal(existsSync(join(dir, "logs", "coletas")), false);
  for (let i = 0; i < 3; i++) loja.cenas.push({ status: 500, headers: {}, body: `falha ecoando ${TOKEN}` });
  const coleta = await coletar(c.id, DIA);
  assert.equal(coleta.state, "falhou");
  const arq = join(dir, "logs", "coletas", coleta.id, `${DIA}.txt`);
  const texto = readFileSync(arq, "utf8");
  assert.match(texto, /falha ecoando/);
  assert.ok(!texto.includes(TOKEN));
});

test("disco de logs sem permissão não derruba a Coleta", async () => {
  writeFileSync(join(dir, "logs"), "arquivo no lugar do diretório"); // mkdir de logs/coletas falha
  for (let i = 0; i < 3; i++) loja.cenas.push({ status: 500, headers: {}, body: "erro cru" });
  const c = await novoColetor();
  const coleta = await coletar(c.id, DIA);
  assert.equal(coleta.state, "falhou");
  assert.match(coleta.error, /503|500/);
});
