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
  dir = mkdtempSync(join(tmpdir(), "atm-sub-"));
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
const nova = async (extra: Record<string, unknown> = {}, token = AGENTE) =>
  (await (await req("POST", "/tarefas", token, { title: "T", ...extra })).json()).id as string;
type Sub = { id: string; title: string; state: string; decisao: string | null };
type T = {
  id: string;
  state: string;
  title: string;
  maeId?: string;
  subtarefas: Sub[];
  resolucaoSubtarefas: { total: number; aprovadas: number; rejeitadas: number; resolvida: boolean };
};
const obter = async (id: string) => (await (await req("GET", `/tarefas/${id}`, HUMANO)).json()) as T;
const eventos = async (id: string) => (await (await req("GET", `/tarefas/${id}/eventos`, HUMANO)).json()) as Record<string, string>[];

test("agente cria Subtarefa em Novo na Exploração; a mãe lista suas Subtarefas", async () => {
  const mae = await nova();
  const r = await req("POST", "/tarefas", AGENTE, { title: "Sub 1", parentId: mae, state: "Aprovado" });
  assert.equal(r.status, 201);
  const sub = (await r.json()) as T;
  assert.equal(sub.maeId, mae);
  assert.equal(sub.state, "Novo");
  const m = await obter(mae);
  assert.deepEqual(m.subtarefas.map((s) => [s.id, s.title, s.state, s.decisao]), [[sub.id, "Sub 1", "Novo", null]]);
  assert.deepEqual(m.resolucaoSubtarefas, { total: 1, aprovadas: 0, rejeitadas: 0, resolvida: false });
});

test("agente não cria Subtarefa na Execução; mãe inexistente é recusada", async () => {
  const mae = await nova();
  assert.equal((await req("POST", "/tarefas", AGENTE, { title: "S", parentId: mae, phase: "Execução" })).status, 403);
  assert.equal((await req("POST", "/tarefas", HUMANO, { title: "S", parentId: mae, phase: "Execução" })).status, 400);
  assert.equal((await req("POST", "/tarefas", AGENTE, { title: "S", parentId: "nao-existe" })).status, 404);
  assert.equal((await obter(mae)).subtarefas.length, 0);
});

test("humano edita Subtarefa; agente não", async () => {
  const mae = await nova();
  const s = await nova({ parentId: mae });
  assert.equal((await req("PATCH", `/tarefas/${s}`, AGENTE, { title: "x" })).status, 403);
  assert.equal((await req("PATCH", `/tarefas/${s}`, HUMANO, { title: "Novo título", description: "d" })).status, 200);
  const m = await obter(mae);
  assert.equal(m.subtarefas[0].title, "Novo título");
  assert.equal((await eventos(s)).at(-1)!.tipo, "editar");
  assert.equal((await req("PATCH", `/tarefas/${mae}`, HUMANO, { title: "x" })).status, 200); // Tarefa comum também é editável pelo humano
});

test("aprovar/rejeitar individualmente é só do humano; mãe resolve quando todas decididas", async () => {
  const mae = await nova();
  const a = await nova({ parentId: mae });
  const b = await nova({ parentId: mae });
  assert.equal((await acao(a, "aprovar-subtarefa", AGENTE)).status, 403);
  assert.equal((await acao(a, "aprovar-subtarefa")).status, 200);
  let m = await obter(mae);
  assert.deepEqual(m.resolucaoSubtarefas, { total: 2, aprovadas: 1, rejeitadas: 0, resolvida: false });
  assert.equal((await eventos(mae)).some((e) => e.tipo === "mae-resolvida"), false);
  assert.equal((await acao(b, "rejeitar", HUMANO, { motivo: "fora de escopo" })).status, 200);
  m = await obter(mae);
  assert.deepEqual(m.resolucaoSubtarefas, { total: 2, aprovadas: 1, rejeitadas: 1, resolvida: true });
  assert.deepEqual(m.subtarefas.map((s) => s.decisao), ["aprovada", "rejeitada"]);
  const ev = (await eventos(mae)).filter((e) => e.tipo === "mae-resolvida");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].autor, "humano");
});

test("reabrir Subtarefa rejeitada desfaz a resolução; nova resolução registra de novo", async () => {
  const mae = await nova();
  const a = await nova({ parentId: mae });
  await acao(a, "rejeitar");
  assert.equal((await obter(mae)).resolucaoSubtarefas.resolvida, true);
  await acao(a, "reabrir");
  assert.equal((await obter(mae)).resolucaoSubtarefas.resolvida, false);
  await acao(a, "aprovar-subtarefa");
  assert.equal((await obter(mae)).resolucaoSubtarefas.resolvida, true);
  assert.equal((await eventos(mae)).filter((e) => e.tipo === "mae-resolvida").length, 2);
});

test("aprovar-subtarefa só vale para Subtarefa em Novo; aprovadas seguem sozinhas (converter sem a mãe)", async () => {
  const solta = await nova();
  assert.equal((await acao(solta, "aprovar-subtarefa")).status, 409);
  const mae = await nova();
  const s = await nova({ parentId: mae });
  await acao(s, "aprovar-subtarefa");
  assert.equal((await acao(s, "aprovar-subtarefa")).status, 409);
  const r = await acao(s, "converter-execucao", HUMANO, { objetivo: "o", repositorioPrincipal: "r", criterios: ["c"] });
  assert.equal(r.status, 200);
  const m = await obter(mae);
  assert.equal(m.state, "Novo"); // mãe segue o próprio ciclo
  assert.equal(m.subtarefas[0].state, "Na fila");
  assert.equal(m.subtarefas[0].decisao, "aprovada");
});

test("comentário na Subtarefa e na mãe reutiliza o histórico", async () => {
  const mae = await nova();
  const s = await nova({ parentId: mae });
  assert.equal((await req("POST", `/tarefas/${s}/comentarios`, HUMANO, { texto: "ajustar escopo" })).status, 201);
  assert.equal((await req("POST", `/tarefas/${mae}/comentarios`, HUMANO, { texto: "ajustar a sub 1" })).status, 201);
});
