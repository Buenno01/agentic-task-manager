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
  dir = mkdtempSync(join(tmpdir(), "atm-dep-"));
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
const nova = async () => (await (await req("POST", "/tarefas", AGENTE, { title: "T" })).json()).id as string;
const depende = (b: string, a: string, token = HUMANO) => req("POST", `/tarefas/${b}/dependencias`, token, { dependeDe: a });
type T = { id: string; state: string; dependeDe: string[]; dependenciasPendentes: { id: string; state: string }[] };
const tarefa = async (id: string) =>
  ((await (await req("GET", "/tarefas", HUMANO)).json()) as T[]).find((t) => t.id === id)!;
const eventos = async (id: string) =>
  (await (await req("GET", `/tarefas/${id}/eventos`, HUMANO)).json()) as Record<string, string>[];
const autorizada = async () => {
  const id = await nova();
  await acao(id, "autorizar");
  return id;
};

test("declarar dependência expõe aviso explícito de dependência pendente na API", async () => {
  const a = await nova();
  const b = await nova();
  assert.equal((await depende(b, a)).status, 201);
  const tb = await tarefa(b);
  assert.deepEqual(tb.dependeDe, [a]);
  assert.deepEqual(tb.dependenciasPendentes.map((d) => [d.id, d.state]), [[a, "Novo"]]);
  assert.deepEqual((await tarefa(a)).dependenciasPendentes, []);
});

test("auto-dependência, ciclo, duplicata e Tarefa inexistente são recusados", async () => {
  const a = await nova();
  const b = await nova();
  const c = await nova();
  assert.equal((await depende(a, a)).status, 400);
  assert.equal((await depende(b, a)).status, 201);
  assert.equal((await depende(c, b)).status, 201);
  assert.equal((await depende(a, c)).status, 400); // ciclo a→c→b→a
  assert.equal((await depende(a, b)).status, 400); // ciclo direto
  assert.equal((await depende(b, a)).status, 400); // duplicata
  assert.equal((await depende(b, "nao-existe")).status, 404);
  assert.equal((await depende("nao-existe", a)).status, 404);
  assert.deepEqual((await tarefa(a)).dependeDe, []);
});

test("dependência pendente segura o início; quando A é aprovada, B inicia", async () => {
  const a = await nova();
  const b = await autorizada();
  await depende(b, a);
  const r = await acao(b, "iniciar", AGENTE);
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /dependência/i);
  assert.equal((await tarefa(b)).state, "Autorizada para explorar");

  await acao(a, "autorizar");
  await acao(a, "iniciar", AGENTE);
  await acao(a, "plano-pronto", AGENTE);
  await acao(a, "aprovar");
  assert.deepEqual((await tarefa(b)).dependenciasPendentes, []);
  assert.equal((await acao(b, "iniciar", AGENTE)).status, 200);
});

test("Forçar início é só do humano, exige dependência pendente e fica registrado com autor e horário", async () => {
  const a = await nova();
  const b = await autorizada();
  assert.equal((await acao(b, "forcar-inicio")).status, 409); // sem dependência pendente
  await depende(b, a);
  assert.equal((await acao(b, "forcar-inicio", AGENTE)).status, 403);
  assert.equal((await tarefa(b)).state, "Autorizada para explorar");

  const r = await acao(b, "forcar-inicio", HUMANO, { motivo: "A não é necessária agora" });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).state, "Explorando");
  assert.equal((await tarefa(b)).state, "Explorando");
  const ev = (await eventos(b)).filter((e) => e.tipo === "forcar-inicio");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].autor, "humano");
  assert.equal(ev[0].para, "Explorando");
  assert.equal(ev[0].motivo, "A não é necessária agora");
  assert.ok(!Number.isNaN(Date.parse(ev[0].em)));
});

test("rejeitar A leva B ativa a Aguardando humano com o motivo; reabrir A faz o mesmo", async () => {
  const a = await nova();
  const b = await autorizada();
  const livre = await autorizada();
  await depende(b, a);
  await acao(b, "forcar-inicio");
  assert.equal((await acao(a, "rejeitar", HUMANO, { motivo: "escopo errado" })).status, 200);
  assert.equal((await tarefa(b)).state, "Aguardando humano");
  assert.equal((await tarefa(livre)).state, "Autorizada para explorar");
  const ev = (await eventos(b)).at(-1)!;
  assert.equal(ev.tipo, "dependencia-rejeitada");
  assert.equal(ev.autor, "humano");
  assert.equal(ev.para, "Aguardando humano");
  assert.match(ev.motivo, new RegExp(a));
  assert.match(ev.motivo, /rejeitada/i);
  assert.match(ev.motivo, /escopo errado/);

  await acao(b, "retomar", AGENTE);
  assert.equal((await tarefa(b)).state, "Explorando");
  assert.equal((await acao(a, "reabrir")).status, 200);
  assert.equal((await tarefa(b)).state, "Aguardando humano");
  const ev2 = (await eventos(b)).at(-1)!;
  assert.equal(ev2.tipo, "dependencia-reaberta");
  assert.match(ev2.motivo, /reaberta/i);
});

test("remover dependência libera B", async () => {
  const a = await nova();
  const b = await nova();
  await depende(b, a);
  assert.equal((await req("DELETE", `/tarefas/${b}/dependencias/${a}`, HUMANO)).status, 204);
  assert.deepEqual((await tarefa(b)).dependeDe, []);
  assert.equal((await req("DELETE", `/tarefas/${b}/dependencias/${a}`, HUMANO)).status, 404);
});
