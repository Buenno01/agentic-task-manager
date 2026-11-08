import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/api/server.ts";
import { criarClienteFalso, type ClienteFalso } from "../src/coleta/falso.ts";
import { CRED, HUMANO, AGENTE, comToken } from "./helpers.ts";

let daemon: Daemon;
let dir: string;
let cliente: ClienteFalso;
let agoraMs: number;

const VAR_TOKEN = "ATM_ANOMALIA_TOKEN";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "atm-anomalia-"));
  process.env[VAR_TOKEN] = "segredo-anomalia-0123456789";
  agoraMs = Date.parse("2026-03-10T12:00:00Z"); // terça; o dia corrente é 2026-03-10
  cliente = criarClienteFalso();
  daemon = await startDaemon({
    dbPath: join(dir, "atm.db"),
    port: 0,
    credenciais: CRED,
    logsDir: join(dir, "logs"),
    coleta: { cliente, relogio: () => agoraMs },
  });
});
afterEach(async () => {
  await daemon.close();
  delete process.env[VAR_TOKEN];
  rmSync(dir, { recursive: true, force: true });
});

const send = (method: string, path: string, body?: unknown, token = HUMANO) =>
  fetch(daemon.url + path, {
    method,
    headers: comToken(token, { "content-type": "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (method: string, path: string, body?: unknown) => (await send(method, path, body)).json();

const novoColetor = async (extra: Record<string, unknown> = {}) => {
  const ctx = (await json("POST", "/contextos", { name: "Loja", kind: "loja" })).id as string;
  const res = await send("POST", "/coletores", { contextId: ctx, source: "falso", tokenEnv: VAR_TOKEN, recollectWindowDays: 1, ...extra });
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

// 2026-03-02 (segunda) é o dia avaliado nos testes; as 4 segundas anteriores são 02-23, 02-16, 02-09, 02-02.
const ALVO = "2026-03-02";
const SEGUNDAS = ["2026-02-02", "2026-02-09", "2026-02-16", "2026-02-23"];
const metricas = (orders: number, netRevenue = 1000, averageTicket = 50, conversion: number | null = 2) => ({ orders, netRevenue, averageTicket, conversion });

async function semear(c: { id: string }, base: Record<string, number | null> = metricas(20), alvo: Record<string, number | null> = metricas(20)) {
  for (const p of SEGUNDAS) {
    cliente.definir(p, { moeda: "BRL", metricas: base });
    await coletar(c.id, p);
  }
  cliente.definir(ALVO, { moeda: "BRL", metricas: alvo });
  await coletar(c.id, ALVO);
}
const anomalias = (id: string) => json("GET", `/coletores/${id}/anomalias`);

test("queda acima do limiar gera Anomalia persistida com valor, base e variação", async () => {
  const c = await novoColetor();
  await semear(c, metricas(20), metricas(10)); // pedidos 20 -> 10 = -50%
  const lista = await anomalias(c.id);
  assert.equal(lista.length, 1);
  const a = lista[0];
  assert.equal(a.coletorId, c.id);
  assert.equal(a.period, ALVO);
  assert.equal(a.metric, "orders");
  assert.equal(a.value, 10);
  assert.equal(a.base, 20);
  assert.equal(a.variation, -50);
});

test("alta acima do limiar também gera Anomalia; dentro do limiar não", async () => {
  const c = await novoColetor();
  // pedidos 20 -> 24 (+20%, dentro de 25); receita 1000 -> 1300 (+30%, fora de 25)
  await semear(c, metricas(20), metricas(24, 1300));
  const lista = await anomalias(c.id);
  assert.deepEqual(lista.map((a: { metric: string }) => a.metric), ["netRevenue"]);
  assert.equal(lista[0].variation, 30);
  assert.equal(lista[0].base, 1000);
});

test("a base é a média das 4 mesmas segundas, não do dia anterior", async () => {
  const c = await novoColetor();
  const valores = [10, 20, 30, 40]; // média 25
  for (const [i, p] of SEGUNDAS.entries()) {
    cliente.definir(p, { moeda: "BRL", metricas: metricas(valores[i]) });
    await coletar(c.id, p);
  }
  cliente.definir("2026-03-01", { moeda: "BRL", metricas: metricas(1000) }); // domingo: ruído que deve ser ignorado
  cliente.definir(ALVO, { moeda: "BRL", metricas: metricas(50) }); // +100% sobre 25
  await coletar(c.id, ALVO);
  const [a] = await anomalias(c.id);
  assert.equal(a.base, 25);
  assert.equal(a.variation, 100);
});

test("base com menos de 10 pedidos não gera Anomalia", async () => {
  const c = await novoColetor();
  await semear(c, metricas(9, 1000), metricas(1, 10)); // queda enorme, mas base de 9 pedidos
  assert.deepEqual(await anomalias(c.id), []);
});

test("o dia corrente nunca é avaliado", async () => {
  const c = await novoColetor();
  agoraMs = Date.parse("2026-03-02T12:00:00Z"); // ALVO passa a ser o dia corrente
  await semear(c, metricas(20), metricas(1));
  assert.deepEqual(await anomalias(c.id), []);
  agoraMs = Date.parse("2026-03-03T12:00:00Z"); // no dia seguinte ele já está fechado: a recoleta o avalia
  cliente.definir(ALVO, { moeda: "BRL", metricas: metricas(10) });
  await coletar(c.id, "2026-03-03");
  assert.equal((await anomalias(c.id)).length, 1);
});

test("métrica ausente não é avaliada (conversão null não vira zero)", async () => {
  const c = await novoColetor();
  await semear(c, metricas(20), metricas(20, 1000, 50, null));
  assert.deepEqual(await anomalias(c.id), []);
  // e métrica ausente na base também não é avaliada
  const d = await novoColetor();
  await semear(d, metricas(20, 1000, 50, null), metricas(20, 1000, 50, 0.1));
  assert.deepEqual(await anomalias(d.id), []);
});

test("sem as 4 ocorrências anteriores não há base e não há Anomalia", async () => {
  const c = await novoColetor();
  for (const p of SEGUNDAS.slice(1)) {
    cliente.definir(p, { moeda: "BRL", metricas: metricas(20) });
    await coletar(c.id, p);
  }
  cliente.definir(ALVO, { moeda: "BRL", metricas: metricas(1) });
  await coletar(c.id, ALVO);
  assert.deepEqual(await anomalias(c.id), []);
});

test("quebra por produto não gera Anomalia: só as 4 métricas são avaliadas", async () => {
  const c = await novoColetor();
  await semear(c, { ...metricas(20), unitsProdutoA: 100 }, { ...metricas(20), unitsProdutoA: 1 });
  assert.deepEqual(await anomalias(c.id), []);
});

test("limiares são configuráveis por Coletor", async () => {
  const c = await novoColetor({ thresholds: { orders: 60 } });
  await semear(c, metricas(20), metricas(10)); // -50%: abaixo de 60
  assert.deepEqual(await anomalias(c.id), []);
  const d = await novoColetor({ thresholds: { orders: 10 } });
  await semear(d, metricas(20), metricas(24)); // +20%: acima de 10
  assert.deepEqual((await anomalias(d.id)).map((a: { metric: string }) => a.metric), ["orders"]);
});

test("reavaliar o mesmo dia não duplica a Anomalia", async () => {
  const c = await novoColetor();
  await semear(c, metricas(20), metricas(10));
  await coletar(c.id, ALVO);
  await coletar(c.id, ALVO);
  assert.equal((await anomalias(c.id)).length, 1);
});

test("agente lê Anomalias mas não escreve; Coletor inexistente dá 404", async () => {
  const c = await novoColetor();
  assert.equal((await send("GET", `/coletores/${c.id}/anomalias`, undefined, AGENTE)).status, 200);
  assert.notEqual((await send("POST", `/coletores/${c.id}/anomalias`, {})).status, 201, "não existe escrita de Anomalia nem para humano");
  assert.equal((await send("POST", `/coletores/${c.id}/anomalias`, {}, AGENTE)).status >= 400, true);
  assert.equal((await send("GET", "/coletores/nao-existe/anomalias")).status, 404);
});
