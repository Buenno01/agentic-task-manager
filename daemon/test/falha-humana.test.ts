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

const VAR_TOKEN = "ATM_SHOPIFY_TOKEN_FALHA";
const TOKEN = "shpat_segredo-da-loja-0123456789";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "atm-falha-humana-"));
  process.env[VAR_TOKEN] = TOKEN;
  loja = criarShopifyFalso();
  daemon = await startDaemon({
    dbPath: join(dir, "atm.db"),
    port: 0,
    credenciais: CRED,
    logsDir: join(dir, "logs"),
    coleta: { relogio: () => Date.parse("2026-03-10T12:00:00Z"), shopify: { http: loja.http, dormir: async () => {} } },
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

let contextoId = "";
const novoColetor = async (extra: Record<string, unknown> = {}) => {
  contextoId = (await json("POST", "/contextos", { name: "Loja", kind: "loja" })).id as string;
  const res = await send("POST", "/coletores", {
    contextId: contextoId,
    source: "shopify",
    tokenEnv: VAR_TOKEN,
    recollectWindowDays: 1,
    params: { shop: "minha-loja.myshopify.com" },
    ...extra,
  });
  assert.equal(res.status, 201);
  return res.json();
};

async function coletar(coletorId: string, period = "2026-03-09") {
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

type Tarefa = { id: string; title: string; description: string; state: string; phase: string; contextId: string | null };
const tarefasDoContexto = async (): Promise<Tarefa[]> =>
  ((await json("GET", "/tarefas")) as Tarefa[]).filter((t) => t.contextId === contextoId);

const recusa = (status: number) => ({ status, headers: {}, body: { errors: "recusado" } });

test("token expirado gera exatamente uma Tarefa Novo, mesmo com várias falhas seguidas", async () => {
  const c = await novoColetor();
  loja.cenas.push(recusa(401), recusa(401), recusa(401));
  for (let i = 0; i < 3; i++) assert.equal((await coletar(c.id)).state, "falhou");

  const tarefas = await tarefasDoContexto();
  assert.equal(tarefas.length, 1);
  assert.equal(tarefas[0].state, "Novo");
  assert.equal(tarefas[0].phase, "Exploração");
  assert.match(tarefas[0].title, /token/i);
  // falhas iguais só registram evento na Tarefa aberta
  const eventos = (await json("GET", `/tarefas/${tarefas[0].id}/eventos`)) as Array<{ tipo: string }>;
  assert.equal(eventos.filter((e) => e.tipo === "falha-repetida").length, 2);
  // o token nunca vai para a Tarefa
  assert.ok(!JSON.stringify([tarefas, eventos]).includes(TOKEN));
});

test("várias falhas iguais de períodos da mesma Coleta geram uma única Tarefa", async () => {
  const c = await novoColetor({ recollectWindowDays: 3 });
  loja.cenas.push(recusa(401), recusa(401), recusa(401));
  await coletar(c.id);
  assert.equal((await tarefasDoContexto()).length, 1);
});

test("nova categoria de causa gera outra Tarefa", async () => {
  const c = await novoColetor();
  loja.cenas.push(recusa(401), recusa(404), recusa(403));
  for (let i = 0; i < 3; i++) await coletar(c.id);
  const tarefas = await tarefasDoContexto();
  assert.equal(tarefas.length, 3);
  assert.equal(new Set(tarefas.map((t) => t.title)).size, 3);
});

test("ACCESS_DENIED do GraphQL (escopo faltando) cai na mesma categoria do 403", async () => {
  const c = await novoColetor();
  loja.cenas.push(recusa(403), { status: 200, headers: {}, body: { errors: [{ message: "Access denied for orders field", extensions: { code: "ACCESS_DENIED" } }] } });
  await coletar(c.id);
  await coletar(c.id);
  assert.equal((await tarefasDoContexto()).length, 1);
});

test("fechada a Tarefa, nova falha igual cria outra", async () => {
  const c = await novoColetor();
  loja.cenas.push(recusa(401), recusa(401));
  await coletar(c.id);
  const [primeira] = await tarefasDoContexto();
  assert.equal((await send("POST", `/tarefas/${primeira.id}/rejeitar`, { motivo: "resolvido" })).status, 200);
  await coletar(c.id);
  const tarefas = await tarefasDoContexto();
  assert.equal(tarefas.length, 2);
  assert.equal(tarefas.filter((t) => t.state === "Novo").length, 1);
});

test("5xx, timeout e 429 nunca geram Tarefa", async () => {
  const c = await novoColetor();
  const r5 = { status: 503, headers: {}, body: {} };
  const r429 = { status: 429, headers: { "retry-after": "1" }, body: {} };
  loja.cenas.push(r5, r5, r5, { erro: "timeout" }, { erro: "timeout" }, { erro: "timeout" }, r429, r429, r429);
  for (let i = 0; i < 3; i++) assert.equal((await coletar(c.id)).state, "falhou");
  assert.equal((await tarefasDoContexto()).length, 0);
});

test("o período fica como Lacuna e é recuperado quando a causa é resolvida", async () => {
  const c = await novoColetor();
  loja.cenas.push(recusa(401));
  await coletar(c.id);
  const abertas = (await json("GET", `/coletores/${c.id}/lacunas`)) as Array<{ period: string; recoveredAt: string | null }>;
  assert.equal(abertas.length, 1);
  assert.equal(abertas[0].period, "2026-03-09");
  assert.equal(abertas[0].recoveredAt, null);

  assert.equal((await coletar(c.id, "2026-03-10")).state, "concluída");
  const depois = (await json("GET", `/coletores/${c.id}/lacunas`)) as Array<{ period: string; recoveredAt: string | null }>;
  assert.ok(depois[0].recoveredAt);
});

test("analytics indisponível por plano/escopo: Coleta parcial e exatamente uma Tarefa Novo por Coletor, mesmo repetindo", async () => {
  loja.pedidos.push({ createdAt: "2026-03-09T13:00:00Z", total: 100 });
  loja.analyticsSemAcesso = true;
  const c = await novoColetor();
  for (let i = 0; i < 3; i++) {
    const coleta = await coletar(c.id);
    assert.equal(coleta.state, "concluída");
    assert.equal(coleta.partial, true);
  }
  const tarefas = await tarefasDoContexto();
  assert.equal(tarefas.length, 1);
  assert.equal(tarefas[0].state, "Novo");
  assert.match(tarefas[0].title, /analytics/i);
  const eventos = (await json("GET", `/tarefas/${tarefas[0].id}/eventos`)) as Array<{ tipo: string }>;
  assert.equal(eventos.filter((e) => e.tipo === "falha-repetida").length, 2);
  const [lacuna] = (await json("GET", `/coletores/${c.id}/lacunas`)) as Array<{ partial: boolean; cause: string }>;
  assert.equal(lacuna.partial, true);
  assert.equal(lacuna.cause, "analytics-indisponivel");
});

test("analytics falhou (transitório) nunca gera Tarefa", async () => {
  loja.pedidos.push({ createdAt: "2026-03-09T13:00:00Z", total: 100 });
  const c = await novoColetor();
  for (let i = 0; i < 2; i++) {
    loja.cenasAnalytics.push({ status: 503, headers: {}, body: "x" }, { status: 503, headers: {}, body: "x" }, { status: 503, headers: {}, body: "x" });
    assert.equal((await coletar(c.id)).partial, true);
  }
  assert.equal((await tarefasDoContexto()).length, 0);
});
