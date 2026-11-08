import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/api/server.ts";
import { criarClienteFalso, type ClienteFalso } from "../src/coleta/falso.ts";
import { CRED, HUMANO, AGENTE, comToken } from "./helpers.ts";

let daemon: Daemon;
let dir: string;
let cliente: ClienteFalso;
let agoraMs: number;

const VAR_TOKEN = "ATM_COLETOR_FALSO_TOKEN";
const SEGREDO = "segredo-plantado-do-coletor-0123456789";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "atm-coleta-"));
  process.env[VAR_TOKEN] = SEGREDO;
  agoraMs = Date.parse("2026-03-10T12:00:00Z");
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

const contexto = async () => (await json("POST", "/contextos", { name: "Loja Wine", kind: "loja" })).id as string;
const novoColetor = async (extra: Record<string, unknown> = {}) => {
  const res = await send("POST", "/coletores", { contextId: await contexto(), source: "falso", tokenEnv: VAR_TOKEN, ...extra });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  return res.json();
};

/** Dispara uma Coleta e espera terminar (assíncrona, RF25). */
async function coletar(coletorId: string, corpo: Record<string, unknown> = {}) {
  const res = await send("POST", `/coletores/${coletorId}/coletas`, corpo);
  assert.equal(res.status, 202, JSON.stringify(await res.clone().json()));
  const { id } = await res.json();
  for (let i = 0; i < 200; i++) {
    const c = await json("GET", `/coletas/${id}`);
    if (c.state !== "em andamento") return c;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("Coleta não terminou");
}

test("cria Coletor num Contexto com padrões; guarda só o nome da variável do token", async () => {
  const contextId = await contexto();
  const res = await send("POST", "/coletores", { contextId, source: "falso", tokenEnv: VAR_TOKEN, token: SEGREDO, params: { loja: "x" } });
  assert.equal(res.status, 201);
  const c = await res.json();
  assert.equal(c.contextId, contextId);
  assert.equal(c.source, "falso");
  assert.equal(c.frequency, "diaria");
  assert.deepEqual(c.params, { loja: "x" });
  assert.equal(c.recollectWindowDays, 7);
  assert.equal(c.automaticAnalysis, false);
  assert.deepEqual(c.thresholds, { orders: 25, netRevenue: 25, averageTicket: 20, conversion: 30 });
  assert.equal(c.tokenEnv, VAR_TOKEN);
  assert.equal(JSON.stringify(c).includes(SEGREDO), false);
  assert.deepEqual(await json("GET", `/coletores/${c.id}`), c);
  assert.deepEqual(await json("GET", "/coletores"), [c]);
});

test("valida Coletor: Contexto, fonte e nome da variável de ambiente", async () => {
  const contextId = await contexto();
  const base = { contextId, source: "falso", tokenEnv: VAR_TOKEN };
  for (const ruim of [
    { contextId: "nao-existe" },
    { source: "gopher" },
    { tokenEnv: undefined },
    { tokenEnv: SEGREDO }, // valor no lugar do nome
    { recollectWindowDays: 0 },
    { thresholds: { orders: -1 } },
  ])
    assert.equal((await send("POST", "/coletores", { ...base, ...ruim })).status, 400, JSON.stringify(ruim));
});

test("token de agente recebe 403 ao criar Coletor ou disparar Coleta, mas pode ler", async () => {
  const c = await novoColetor();
  assert.equal((await send("POST", "/coletores", { contextId: c.contextId, source: "falso", tokenEnv: VAR_TOKEN }, AGENTE)).status, 403);
  assert.equal((await send("POST", `/coletores/${c.id}/coletas`, {}, AGENTE)).status, 403);
  assert.equal((await send("GET", "/coletores", undefined, AGENTE)).status, 200);
  assert.equal((await send("GET", `/coletores/${c.id}/consolidado`, undefined, AGENTE)).status, 200);
  assert.equal((await json("GET", `/coletores/${c.id}/coletas`)).length, 0);
});

test("Coleta sob demanda é assíncrona e gera Snapshot imutável com hash e moeda; a visão consolidada aponta para ele", async () => {
  cliente.definir("2026-03-09", { moeda: "BRL", metricas: { orders: 12, netRevenue: 3400.5, conversion: null } });
  const c = await novoColetor({ recollectWindowDays: 1 });

  const res = await send("POST", `/coletores/${c.id}/coletas`, {});
  assert.equal(res.status, 202);
  const iniciada = await res.json();
  assert.equal(iniciada.coletorId, c.id);
  assert.equal(iniciada.state, "em andamento");
  assert.equal(iniciada.period, "2026-03-09"); // padrão: o dia anterior ao relógio

  let coleta = await json("GET", `/coletas/${iniciada.id}`);
  for (let i = 0; i < 200 && coleta.state === "em andamento"; i++) {
    await new Promise((r) => setTimeout(r, 10));
    coleta = await json("GET", `/coletas/${iniciada.id}`);
  }
  assert.equal(coleta.state, "concluída");
  assert.equal(coleta.snapshots.length, 1);

  const snap = await json("GET", `/snapshots/${coleta.snapshots[0]}`);
  assert.equal(snap.coletorId, c.id);
  assert.equal(snap.period, "2026-03-09");
  assert.equal(snap.currency, "BRL");
  assert.deepEqual(snap.payload, { orders: 12, netRevenue: 3400.5, conversion: null });
  assert.match(snap.hash, /^[0-9a-f]{64}$/);
  // sha256 de {"period","currency","payload"} em JSON compacto com chaves do payload ordenadas (calculado fora do código).
  assert.equal(snap.hash, "719014a4ce7154ce7c57d4136d960d083ee6c92d91afee2905aff27e4d0fbc71");

  const consolidado = await json("GET", `/coletores/${c.id}/consolidado`);
  const pedidos = consolidado.find((l: { period: string; metric: string }) => l.period === "2026-03-09" && l.metric === "orders");
  assert.equal(pedidos.value, 12);
  assert.equal(pedidos.snapshotId, snap.id);
  assert.equal(pedidos.currency, "BRL");
});

test("Snapshot é imutável: a API não expõe escrita e o banco recusa UPDATE/DELETE", async () => {
  const c = await novoColetor();
  const coleta = await coletar(c.id);
  const id = coleta.snapshots[0];
  assert.equal((await send("PUT", `/snapshots/${id}`, { payload: {} })).status, 404);
  assert.equal((await send("DELETE", `/snapshots/${id}`)).status, 404);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(dir, "atm.db"));
  assert.throws(() => db.prepare("UPDATE snapshots SET payload = '{}' WHERE id = ?").run(id), /imutável/);
  assert.throws(() => db.prepare("DELETE FROM snapshots WHERE id = ?").run(id), /imutável/);
  db.close();
});

test("série por métrica: um ponto por período coletado, em ordem; ausente fica null (nunca zero)", async () => {
  cliente.definir("2026-03-07", { moeda: "BRL", metricas: { orders: 10, conversion: 2.5 } });
  cliente.definir("2026-03-08", { moeda: "BRL", metricas: { orders: 14, conversion: null } });
  const c = await novoColetor({ recollectWindowDays: 1 });
  await coletar(c.id, { period: "2026-03-08" });
  await coletar(c.id, { period: "2026-03-07" });

  const pedidos = await json("GET", `/coletores/${c.id}/series/orders`);
  assert.deepEqual(pedidos.map((p: { period: string; value: number | null }) => [p.period, p.value]), [["2026-03-07", 10], ["2026-03-08", 14]]);
  const conversao = await json("GET", `/coletores/${c.id}/series/conversion`);
  assert.deepEqual(conversao.map((p: { value: number | null }) => p.value), [2.5, null]);
  assert.equal((await send("GET", `/coletores/${c.id}/series/inexistente`)).status, 404);
  assert.equal((await send("GET", "/coletores/nao-existe/series/orders")).status, 404);
});

test("falha do cliente deixa a Coleta 'falhou' com o erro e sem Snapshot", async () => {
  const c = await novoColetor();
  cliente.falharCom("fonte fora do ar");
  const coleta = await coletar(c.id);
  assert.equal(coleta.state, "falhou");
  assert.match(coleta.error, /fonte fora do ar/);
  assert.deepEqual(coleta.snapshots, []);
  assert.deepEqual(await json("GET", `/coletores/${c.id}/consolidado`), []);
});

test("segredo plantado: o valor do token não aparece em eventos, logs nem banco", async () => {
  const c = await novoColetor();
  const logado: string[] = [];
  const originais = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a: unknown[]) => void logado.push(a.map(String).join(" "));
  let coleta;
  try {
    cliente.definir("2026-03-09", { moeda: "BRL", metricas: { orders: 1 } });
    await coletar(c.id);
    cliente.falharCom(`401 com token ${SEGREDO}`); // o cliente vaza o segredo no erro
    coleta = await coletar(c.id);
  } finally {
    Object.assign(console, originais);
  }
  assert.equal(cliente.tokensRecebidos.at(-1), SEGREDO, "o cliente recebe o valor lido do ambiente");
  assert.equal(coleta.state, "falhou");

  const textos = [
    JSON.stringify(await json("GET", `/coletores/${c.id}`)),
    JSON.stringify(await json("GET", `/coletores/${c.id}/coletas`)),
    JSON.stringify(await json("GET", `/coletores/${c.id}/consolidado`)),
    JSON.stringify(await json("GET", "/auditoria")),
    logado.join("\n"),
    ...readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => readFileSync(join(e.parentPath, e.name), "latin1")),
  ];
  for (const t of textos) assert.equal(t.includes(SEGREDO), false);
  assert.ok(readdirSync(dir).some((f) => f.startsWith("atm.db")) && statSync(join(dir, "atm.db")).size > 0);
});

test("variável de ambiente do token ausente: a Coleta falha sem chamar o cliente", async () => {
  const c = await novoColetor();
  delete process.env[VAR_TOKEN];
  const coleta = await coletar(c.id);
  assert.equal(coleta.state, "falhou");
  assert.match(coleta.error, new RegExp(VAR_TOKEN));
  assert.equal(cliente.tokensRecebidos.length, 0);
});
