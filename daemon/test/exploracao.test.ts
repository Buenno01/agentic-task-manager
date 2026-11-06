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
  dir = mkdtempSync(join(tmpdir(), "atm-"));
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
const acao = (id: string, a: string, token = HUMANO, body?: unknown) => req("POST", `/tarefas/${id}/${a}`, token, body);
const estado = async (id: string) =>
  ((await (await req("GET", "/tarefas", HUMANO)).json()) as { id: string; state: string }[]).find((t) => t.id === id)!.state;
const nova = async () => (await (await req("POST", "/tarefas", AGENTE, { title: "T" })).json()).id as string;

test("caminho feliz: Novo → Autorizada → Explorando ↔ Aguardando humano → Plano pronto → Aprovado", async () => {
  const id = await nova();
  const passos: [string, string, string][] = [
    ["autorizar", HUMANO, "Autorizada para explorar"],
    ["iniciar", AGENTE, "Explorando"],
    ["pedir-humano", AGENTE, "Aguardando humano"],
    ["retomar", AGENTE, "Explorando"],
    ["plano-pronto", AGENTE, "Plano pronto para aprovação"],
    ["aprovar", HUMANO, "Aprovado"],
  ];
  for (const [a, tok, esperado] of passos) {
    const r = await acao(id, a, tok);
    assert.equal(r.status, 200, a);
    assert.equal((await r.json()).state, esperado);
    assert.equal(await estado(id), esperado);
  }
});

test("transições inválidas são recusadas (409) e não mudam o estado", async () => {
  const id = await nova();
  assert.equal((await acao(id, "aprovar")).status, 409);
  assert.equal((await acao(id, "iniciar", AGENTE)).status, 409);
  assert.equal((await acao(id, "reabrir")).status, 409);
  assert.equal((await acao(id, "inexistente")).status, 404);
  assert.equal((await acao("nao-existe", "autorizar")).status, 404);
  assert.equal(await estado(id), "Novo");
});

test("agente não autoriza, aprova, rejeita nem reabre (403) e o estado não muda", async () => {
  const id = await nova();
  for (const a of ["autorizar", "aprovar", "rejeitar", "reabrir"]) assert.equal((await acao(id, a, AGENTE)).status, 403, a);
  assert.equal(await estado(id), "Novo");
});

test("Rejeitada pode ser reaberta preservando o histórico, com autor e motivo", async () => {
  const id = await nova();
  await acao(id, "autorizar");
  await acao(id, "iniciar", AGENTE);
  await acao(id, "plano-pronto", AGENTE);
  assert.equal((await acao(id, "rejeitar", HUMANO, { motivo: "escopo errado" })).status, 200);
  assert.equal(await estado(id), "Rejeitado");
  assert.equal((await acao(id, "reabrir")).status, 200);
  assert.equal(await estado(id), "Novo");

  const ev = (await (await req("GET", `/tarefas/${id}/eventos`, HUMANO)).json()) as Record<string, string>[];
  assert.deepEqual(
    ev.map((e) => [e.autor, e.tipo, e.de, e.para]),
    [
      ["humano", "autorizar", "Novo", "Autorizada para explorar"],
      ["agente:agente-a", "iniciar", "Autorizada para explorar", "Explorando"],
      ["agente:agente-a", "plano-pronto", "Explorando", "Plano pronto para aprovação"],
      ["humano", "rejeitar", "Plano pronto para aprovação", "Rejeitado"],
      ["humano", "reabrir", "Rejeitado", "Novo"],
    ],
  );
  assert.equal(ev[3].motivo, "escopo errado");
});

test("transição recusada não gera evento", async () => {
  const id = await nova();
  await acao(id, "aprovar");
  assert.deepEqual(await (await req("GET", `/tarefas/${id}/eventos`, HUMANO)).json(), []);
});
