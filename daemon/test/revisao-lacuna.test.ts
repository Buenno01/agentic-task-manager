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

const VAR_TOKEN = "ATM_REVISAO_TOKEN";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "atm-revisao-"));
  process.env[VAR_TOKEN] = "segredo-revisao-0123456789";
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

const novoColetor = async (extra: Record<string, unknown> = {}) => {
  const ctx = (await json("POST", "/contextos", { name: "Loja", kind: "loja" })).id as string;
  const res = await send("POST", "/coletores", { contextId: ctx, source: "falso", tokenEnv: VAR_TOKEN, ...extra });
  assert.equal(res.status, 201);
  return res.json();
};

async function coletar(coletorId: string, corpo: Record<string, unknown> = {}) {
  const res = await send("POST", `/coletores/${coletorId}/coletas`, corpo);
  assert.equal(res.status, 202);
  const { id } = await res.json();
  for (let i = 0; i < 200; i++) {
    const c = await json("GET", `/coletas/${id}`);
    if (c.state !== "em andamento") return c;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("Coleta não terminou");
}

const resp = (orders: number, netRevenue = 100) => ({ moeda: "BRL", metricas: { orders, netRevenue } });

test("cada Coleta recoleta a janela de 7 dias terminando no período pedido", async () => {
  const c = await novoColetor();
  const coleta = await coletar(c.id, { period: "2026-03-09" });
  assert.equal(coleta.state, "concluída");
  assert.deepEqual(
    cliente.pedidos.map((p) => p.period),
    ["2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09"],
  );
  assert.equal(coleta.snapshots.length, 7);
});

test("janela de recoleta é configurável por Coletor", async () => {
  const c = await novoColetor({ recollectWindowDays: 3 });
  await coletar(c.id, { period: "2026-03-09" });
  assert.deepEqual(cliente.pedidos.map((p) => p.period), ["2026-03-07", "2026-03-08", "2026-03-09"]);
});

test("recoletar com a fonte igual não duplica Snapshot nem gera Revisão", async () => {
  const c = await novoColetor({ recollectWindowDays: 2 });
  cliente.definir("2026-03-09", resp(12));
  const primeira = await coletar(c.id, { period: "2026-03-09" });
  assert.equal(primeira.snapshots.length, 2);

  const segunda = await coletar(c.id, { period: "2026-03-09" });
  assert.equal(segunda.state, "concluída");
  assert.deepEqual(segunda.snapshots, []);
  assert.deepEqual(await json("GET", `/coletores/${c.id}/revisoes`), []);
  assert.equal((await json("GET", `/coletores/${c.id}/consolidado`)).filter((l: { metric: string }) => l.metric === "orders").length, 2);
});

test("mudança na fonte gera novo Snapshot e Revisão com valor anterior e novo por métrica", async () => {
  const c = await novoColetor({ recollectWindowDays: 2 });
  cliente.definir("2026-03-09", resp(12, 300));
  const primeira = await coletar(c.id, { period: "2026-03-09" });
  const antigo = primeira.snapshots.map((id: string) => id)[1]; // 2026-03-09

  cliente.definir("2026-03-09", resp(10, 300)); // reembolso: pedidos 12 -> 10, receita igual
  const segunda = await coletar(c.id, { period: "2026-03-09" });
  assert.equal(segunda.snapshots.length, 1);
  const novo = await json("GET", `/snapshots/${segunda.snapshots[0]}`);
  assert.equal(novo.period, "2026-03-09");
  assert.equal(novo.payload.orders, 10);
  assert.notEqual(novo.id, antigo);
  assert.equal((await json("GET", `/snapshots/${antigo}`)).payload.orders, 12, "o Snapshot antigo continua intacto");

  const revisoes = await json("GET", `/coletores/${c.id}/revisoes`);
  assert.equal(revisoes.length, 1);
  assert.equal(revisoes[0].period, "2026-03-09");
  assert.equal(revisoes[0].coletaId, segunda.id);
  assert.equal(revisoes[0].previousSnapshotId, antigo);
  assert.equal(revisoes[0].snapshotId, novo.id);
  assert.deepEqual(revisoes[0].changes, [{ metric: "orders", previous: 12, new: 10 }]);

  const consolidado = await json("GET", `/coletores/${c.id}/consolidado`);
  const linha = consolidado.find((l: { period: string; metric: string }) => l.period === "2026-03-09" && l.metric === "orders");
  assert.equal(linha.value, 10);
  assert.equal(linha.snapshotId, novo.id);

  // voltar ao valor anterior também é mudança: nova Revisão 10 -> 12
  cliente.definir("2026-03-09", resp(12, 300));
  await coletar(c.id, { period: "2026-03-09" });
  const todas = await json("GET", `/coletores/${c.id}/revisoes`);
  assert.deepEqual(todas[1].changes, [{ metric: "orders", previous: 10, new: 12 }]);
});

test("métrica que passa de ausente a presente (ou o contrário) é Revisão com null", async () => {
  const c = await novoColetor({ recollectWindowDays: 1 });
  cliente.definir("2026-03-09", { moeda: "BRL", metricas: { orders: 5, conversion: null } });
  await coletar(c.id, { period: "2026-03-09" });
  cliente.definir("2026-03-09", { moeda: "BRL", metricas: { orders: 5, conversion: 2.5 } });
  await coletar(c.id, { period: "2026-03-09" });
  const [rev] = await json("GET", `/coletores/${c.id}/revisoes`);
  assert.deepEqual(rev.changes, [{ metric: "conversion", previous: null, new: 2.5 }]);
});

test("falha registra erro e Lacuna consultável; agente também lê", async () => {
  const c = await novoColetor({ recollectWindowDays: 1 });
  cliente.falharCom("fonte fora do ar");
  const coleta = await coletar(c.id, { period: "2026-03-09" });
  assert.equal(coleta.state, "falhou");
  assert.match(coleta.error, /fonte fora do ar/);

  const res = await send("GET", `/coletores/${c.id}/lacunas`, undefined, AGENTE);
  assert.equal(res.status, 200);
  const lacunas = await res.json();
  assert.equal(lacunas.length, 1);
  assert.equal(lacunas[0].period, "2026-03-09");
  assert.equal(lacunas[0].coletaId, coleta.id);
  assert.match(lacunas[0].error, /fonte fora do ar/);
  assert.equal(lacunas[0].recoveredAt, null);
  assert.equal(lacunas[0].recoveredByColetaId, null);

  // nova falha do mesmo período não duplica a Lacuna aberta
  await coletar(c.id, { period: "2026-03-09" });
  assert.equal((await json("GET", `/coletores/${c.id}/lacunas`)).length, 1);
  assert.equal((await send("GET", "/coletores/nao-existe/lacunas")).status, 404);
  assert.equal((await send("GET", "/coletores/nao-existe/revisoes")).status, 404);
});

test("Lacuna é recuperada na próxima Coleta bem-sucedida, mesmo fora da janela", async () => {
  const c = await novoColetor({ recollectWindowDays: 1 });
  cliente.falharCom("fonte fora do ar");
  const falha = await coletar(c.id, { period: "2026-03-01" });
  assert.equal(falha.state, "falhou");
  assert.equal((await json("GET", `/coletores/${c.id}/consolidado`)).length, 0);

  cliente.falharCom(undefined);
  cliente.definir("2026-03-01", resp(7));
  const boa = await coletar(c.id, { period: "2026-03-09" }); // janela de 1 dia nem toca 03-01
  assert.equal(boa.state, "concluída");
  assert.ok(cliente.pedidos.some((p) => p.period === "2026-03-01"), "recoletou o período da Lacuna");

  const [lacuna] = await json("GET", `/coletores/${c.id}/lacunas`);
  assert.equal(lacuna.period, "2026-03-01");
  assert.equal(lacuna.recoveredByColetaId, boa.id);
  assert.equal(lacuna.recoveredAt, new Date(agoraMs).toISOString());
  const serie = await json("GET", `/coletores/${c.id}/series/orders`);
  assert.deepEqual(serie.map((p: { period: string; value: number }) => [p.period, p.value]), [["2026-03-01", 7], ["2026-03-09", 1]]);
  // recuperar um período sem Snapshot anterior não é Revisão
  assert.deepEqual(await json("GET", `/coletores/${c.id}/revisoes`), []);
});
