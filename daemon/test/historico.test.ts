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
const nova = async () => (await (await req("POST", "/tarefas", AGENTE, { title: "T" })).json()).id as string;
const comentar = (id: string, token: string, body: unknown) => req("POST", `/tarefas/${id}/comentarios`, token, body);
const historico = async (id: string) =>
  (await (await req("GET", `/tarefas/${id}/eventos`, HUMANO)).json()) as Record<string, string>[];

test("humano e agente comentam; autor vem do token e aparece no histórico", async () => {
  const id = await nova();
  const r1 = await comentar(id, HUMANO, { texto: "olá do humano", autor: "falso" });
  assert.equal(r1.status, 201);
  assert.equal((await r1.json()).autor, "humano");
  assert.equal((await comentar(id, AGENTE, { texto: "olá do agente" })).status, 201);
  const h = await historico(id);
  assert.deepEqual(
    h.map((e) => [e.autor, e.tipo, e.texto]),
    [
      ["humano", "comentario", "olá do humano"],
      ["agente:agente-a", "comentario", "olá do agente"],
    ],
  );
});

test("histórico mescla comentários, transições e aprovação em ordem cronológica", async () => {
  const id = await nova();
  await comentar(id, AGENTE, { texto: "c1" });
  await req("POST", `/tarefas/${id}/autorizar`, HUMANO);
  await comentar(id, HUMANO, { texto: "c2" });
  await req("POST", `/tarefas/${id}/iniciar`, AGENTE);
  await req("POST", `/tarefas/${id}/plano-pronto`, AGENTE);
  await comentar(id, AGENTE, { texto: "c3" });
  await req("POST", `/tarefas/${id}/aprovar`, HUMANO);
  const h = await historico(id);
  assert.deepEqual(
    h.map((e) => e.texto ?? e.tipo),
    ["c1", "autorizar", "c2", "iniciar", "plano-pronto", "c3", "aprovar"],
  );
  assert.ok(h.every((e) => e.em && e.autor));
  const ems = h.map((e) => e.em);
  assert.deepEqual(ems, [...ems].sort());
});

test("pergunta e resposta: resposta liga à pergunta", async () => {
  const id = await nova();
  const p = await (await comentar(id, AGENTE, { tipo: "pergunta", texto: "qual escopo?" })).json();
  assert.equal(p.tipo, "pergunta");
  const r = await comentar(id, HUMANO, { tipo: "resposta", texto: "só o daemon", respondeA: p.id });
  assert.equal(r.status, 201);
  const h = await historico(id);
  assert.equal(h[1].tipo, "resposta");
  assert.equal(h[1].respondeA, p.id);
});

test("validações: texto vazio, tipo inválido, resposta sem/ com alvo inválido, tarefa inexistente", async () => {
  const id = await nova();
  const outra = await nova();
  const c = await (await comentar(id, HUMANO, { texto: "simples" })).json();
  const p = await (await comentar(outra, HUMANO, { tipo: "pergunta", texto: "?" })).json();
  assert.equal((await comentar(id, HUMANO, { texto: "  " })).status, 400);
  assert.equal((await comentar(id, HUMANO, {})).status, 400);
  assert.equal((await comentar(id, HUMANO, { tipo: "xis", texto: "a" })).status, 400);
  assert.equal((await comentar(id, HUMANO, { tipo: "resposta", texto: "a" })).status, 400);
  assert.equal((await comentar(id, HUMANO, { tipo: "resposta", texto: "a", respondeA: c.id })).status, 400);
  assert.equal((await comentar(id, HUMANO, { tipo: "resposta", texto: "a", respondeA: p.id })).status, 400);
  assert.equal((await comentar(id, HUMANO, { texto: "a", respondeA: p.id })).status, 400);
  assert.equal((await comentar("nao-existe", HUMANO, { texto: "a" })).status, 404);
  assert.equal((await historico(id)).length, 1);
});

test("histórico é imutável: PUT/PATCH/DELETE são recusados e nada muda", async () => {
  const id = await nova();
  const c = await (await comentar(id, HUMANO, { texto: "original" })).json();
  await req("POST", `/tarefas/${id}/autorizar`, HUMANO);
  const antes = await historico(id);
  for (const m of ["PUT", "PATCH", "DELETE"]) {
    for (const p of [`/tarefas/${id}/eventos`, `/tarefas/${id}/comentarios`, `/tarefas/${id}/comentarios/${c.id}`]) {
      assert.equal((await req(m, p, HUMANO, { texto: "editado" })).status, 405, `${m} ${p}`);
    }
  }
  assert.deepEqual(await historico(id), antes);
});
