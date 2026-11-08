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

const VAR_TOKEN = "ATM_COLETOR_FALSO_TOKEN";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "atm-consulta-"));
  process.env[VAR_TOKEN] = "segredo-plantado-do-coletor-0123456789";
  cliente = criarClienteFalso();
  daemon = await startDaemon({
    dbPath: join(dir, "atm.db"),
    port: 0,
    credenciais: CRED,
    logsDir: join(dir, "logs"),
    coleta: { cliente, relogio: () => Date.parse("2026-03-10T12:00:00Z") },
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
const json = async (method: string, path: string, body?: unknown, token = HUMANO) => (await send(method, path, body, token)).json();

async function coletorComProdutos() {
  const ctx = (await json("POST", "/contextos", { name: "Loja", kind: "loja" })).id as string;
  const c = await json("POST", "/coletores", { contextId: ctx, source: "falso", tokenEnv: VAR_TOKEN });
  cliente.definir("2026-03-09", {
    moeda: "BRL",
    metricas: { orders: 3, netRevenue: 300, "produto:1:unidades": 5, "produto:1:receita": 260, "produto:2:unidades": 1, "produto:2:receita": 40 },
  });
  const r = await send("POST", `/coletores/${c.id}/coletas`, { period: "2026-03-09" });
  const { id } = await r.json();
  for (let i = 0; i < 200 && (await json("GET", `/coletas/${id}`)).state === "em andamento"; i++) await new Promise((x) => setTimeout(x, 10));
  return c as { id: string };
}

test("quebra por produto: lista unidades e receita por produto e período; agente lê", async () => {
  const c = await coletorComProdutos();
  const res = await send("GET", `/coletores/${c.id}/produtos`, undefined, AGENTE);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), [
    { period: "2026-03-09", productId: "1", units: 5, revenue: 260 },
    { period: "2026-03-09", productId: "2", units: 1, revenue: 40 },
  ]);
  assert.equal((await send("GET", "/coletores/nao-existe/produtos")).status, 404);
});

test("série de uma métrica de produto é consultável pela rota de séries", async () => {
  const c = await coletorComProdutos();
  const s = await json("GET", `/coletores/${c.id}/series/produto:1:unidades`, undefined, AGENTE);
  assert.equal(s.find((p: { period: string }) => p.period === "2026-03-09").value, 5);
});

test("token de agente recebe 403 em qualquer escrita de Coletor ou Coleta, seja qual for o método", async () => {
  const c = await coletorComProdutos();
  const alvos = [
    ["POST", "/coletores"],
    ["PUT", `/coletores/${c.id}`],
    ["PATCH", `/coletores/${c.id}`],
    ["DELETE", `/coletores/${c.id}`],
    ["POST", `/coletores/${c.id}/coletas`],
    ["PUT", `/coletores/${c.id}/coletas`],
    ["DELETE", `/coletores/${c.id}/coletas`],
    ["POST", `/coletores/${c.id}/anomalias`],
    ["POST", `/coletores/${c.id}/lacunas`],
    ["POST", `/coletores/${c.id}/revisoes`],
    ["PATCH", "/coletas/qualquer"],
    ["DELETE", "/coletas/qualquer"],
    ["POST", "/coletas/qualquer"],
  ];
  for (const [m, p] of alvos) assert.equal((await send(m, p, {}, AGENTE)).status, 403, `${m} ${p}`);
  assert.equal((await json("GET", "/coletores")).length, 1, "nada foi apagado");
});

test("consultas existentes respondem ao agente: Coletores, Coletas, Lacunas, Revisões, Anomalias", async () => {
  const c = await coletorComProdutos();
  for (const p of ["/coletores", `/coletores/${c.id}`, `/coletores/${c.id}/coletas`, `/coletores/${c.id}/lacunas`, `/coletores/${c.id}/revisoes`, `/coletores/${c.id}/anomalias`, `/coletores/${c.id}/consolidado`])
    assert.equal((await send("GET", p, undefined, AGENTE)).status, 200, p);
  const coletas = await json("GET", `/coletores/${c.id}/coletas`, undefined, AGENTE);
  assert.equal((await send("GET", `/coletas/${coletas[0].id}`, undefined, AGENTE)).status, 200);
});
