import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/api/server.ts";

const HUMANO = "tok-humano";
const AGENTE = "tok-agente";
let daemon: Daemon;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "atm-cons-"));
  daemon = await startDaemon({
    dbPath: join(dir, "atm.db"),
    port: 0,
    credenciais: { humano: HUMANO, agentes: { "agente-a": AGENTE } },
  });
});
afterEach(async () => {
  await daemon.close();
  rmSync(dir, { recursive: true, force: true });
});

const req = (method: string, path: string, token: string, body?: unknown) =>
  fetch(daemon.url + path, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (method: string, path: string, token = HUMANO, body?: unknown) =>
  (await req(method, path, token, body)).json() as Promise<any>;
const novoContexto = async () => (await json("POST", "/contextos", HUMANO, { name: "Loja", kind: "loja" })).id as string;
const novaTarefa = async () => (await json("POST", "/tarefas", AGENTE, { title: "T" })).id as string;
const atualizar = (ctx: string, texto: string, token = AGENTE, taskId?: string) =>
  req("PUT", `/contextos/${ctx}/consolidado`, token, { text: texto, taskId });

test("sem versões, o Contexto consolidado atual é vazio", async () => {
  const ctx = await novoContexto();
  const atual = await json("GET", `/contextos/${ctx}/consolidado`);
  assert.equal(atual.version, 0);
  assert.equal(atual.text, "");
  assert.deepEqual(await json("GET", `/contextos/${ctx}/consolidado/versoes`), []);
});

test("cada atualização cria versão numerada com Tarefa de origem e autor", async () => {
  const ctx = await novoContexto();
  const t1 = await novaTarefa();
  const t2 = await novaTarefa();
  const r1 = await atualizar(ctx, "Usar Tailwind.", AGENTE, t1);
  assert.equal(r1.status, 201);
  assert.equal((await r1.json()).version, 1);
  await atualizar(ctx, "Usar Tailwind. Deploy às sextas é proibido.", HUMANO, t2);

  const atual = await json("GET", `/contextos/${ctx}/consolidado`);
  assert.equal(atual.version, 2);
  assert.equal(atual.text, "Usar Tailwind. Deploy às sextas é proibido.");
  assert.equal(atual.taskId, t2);
  assert.equal(atual.author, "humano");

  const versoes = await json("GET", `/contextos/${ctx}/consolidado/versoes`);
  assert.deepEqual(versoes.map((v: any) => [v.version, v.taskId, v.author]), [
    [1, t1, "agente:agente-a"],
    [2, t2, "humano"],
  ]);
  assert.equal(versoes[0].text, "Usar Tailwind.");
});

test("valida Contexto, texto e Tarefa de origem", async () => {
  const ctx = await novoContexto();
  assert.equal((await atualizar("nao-existe", "x")).status, 404);
  assert.equal((await json("GET", "/contextos/nao-existe/consolidado")).error, "Não encontrado");
  assert.equal((await atualizar(ctx, "  ")).status, 400);
  assert.equal((await atualizar(ctx, "ok", AGENTE, "tarefa-inexistente")).status, 400);
  assert.deepEqual(await json("GET", `/contextos/${ctx}/consolidado/versoes`), []);
});

test("reverter restaura a versão anterior como NOVA versão, sem apagar histórico", async () => {
  const ctx = await novoContexto();
  await atualizar(ctx, "v1");
  await atualizar(ctx, "v2");
  const rev = await req("POST", `/contextos/${ctx}/consolidado/reverter`, HUMANO, {});
  assert.equal(rev.status, 201);
  const nova = await rev.json();
  assert.equal(nova.version, 3);
  assert.equal(nova.text, "v1");
  assert.equal(nova.revertedFrom, 1);
  assert.equal(nova.author, "humano");

  const versoes = await json("GET", `/contextos/${ctx}/consolidado/versoes`);
  assert.deepEqual(versoes.map((v: any) => v.text), ["v1", "v2", "v1"]);
  assert.equal((await json("GET", `/contextos/${ctx}/consolidado`)).version, 3);
});

test("reverter para versão específica; erros quando não há para onde voltar", async () => {
  const ctx = await novoContexto();
  assert.equal((await req("POST", `/contextos/${ctx}/consolidado/reverter`, AGENTE, {})).status, 409);
  await atualizar(ctx, "v1");
  assert.equal((await req("POST", `/contextos/${ctx}/consolidado/reverter`, AGENTE, {})).status, 409);
  await atualizar(ctx, "v2");
  await atualizar(ctx, "v3");
  assert.equal((await req("POST", `/contextos/${ctx}/consolidado/reverter`, AGENTE, { version: 9 })).status, 400);
  const r = await json("POST", `/contextos/${ctx}/consolidado/reverter`, AGENTE, { version: 1 });
  assert.equal(r.text, "v1");
  assert.equal(r.version, 4);
  assert.equal(r.author, "agente:agente-a");
});

test("versões ficam em Contextos independentes e persistem após reiniciar", async () => {
  const a = await novoContexto();
  const b = await novoContexto();
  await atualizar(a, "só em A");
  assert.equal((await json("GET", `/contextos/${b}/consolidado`)).version, 0);
  await daemon.close();
  daemon = await startDaemon({
    dbPath: join(dir, "atm.db"),
    port: 0,
    credenciais: { humano: HUMANO, agentes: { "agente-a": AGENTE } },
  });
  assert.equal((await json("GET", `/contextos/${a}/consolidado`)).text, "só em A");
});

test("texto é indexável por FTS5 (base para a busca do ticket 13)", async () => {
  const { abrirConsolidado } = await import("../src/db/consolidado.ts");
  const ctx = await novoContexto();
  await atualizar(ctx, "Regra: nunca fazer deploy na sexta-feira");
  await atualizar(ctx, "Regra: usar Tailwind");
  const store = abrirConsolidado(join(dir, "atm.db"));
  try {
    assert.deepEqual(store.buscar("tailwind").map((h) => [h.contextId, h.version]), [[ctx, 2]]);
    assert.deepEqual(store.buscar("deploy").map((h) => h.version), [1]); // versões antigas também indexadas
  } finally {
    store.close();
  }
});
