import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/api/server.ts";
import { AGENTE, CRED, HUMANO, comToken } from "./helpers.ts";
import { dependenciaPendente, ESTADOS_ATIVOS } from "../src/domain/dependencias.ts";

let daemon: Daemon;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "atm-rev-"));
  daemon = await startDaemon({ dbPath: join(dir, "atm.db"), port: 0, credenciais: CRED, anexosDir: join(dir, "anexos"), anexoMaxBytes: 1000 });
});
afterEach(async () => {
  await daemon.close();
  rmSync(dir, { recursive: true, force: true });
});

const req = (method: string, path: string, token: string, body?: unknown) =>
  fetch(daemon.url + path, {
    method,
    headers: comToken(token, { "content-type": "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const acao = (id: string, a: string, token = HUMANO, body?: unknown) => req("POST", `/tarefas/${id}/${a}`, token, body);
const nova = async (extra: Record<string, unknown> = {}, token = AGENTE) =>
  (await (await req("POST", "/tarefas", token, { title: "T", ...extra })).json()).id as string;
const contrato = { objetivo: "Entregar X", repositorioPrincipal: "org/repo", criterios: ["ok"] };
type T = { id: string; phase: string; state: string; dependenciasPendentes: { id: string }[] };
const obter = async (id: string) => (await (await req("GET", `/tarefas/${id}`, HUMANO)).json()) as T;
const eventos = async (id: string) => (await (await req("GET", `/tarefas/${id}/eventos`, HUMANO)).json()) as Record<string, string>[];
const depende = (b: string, a: string, token = HUMANO) => req("POST", `/tarefas/${b}/dependencias`, token, { dependeDe: a });
const aprovada = async () => {
  const id = await nova();
  await acao(id, "autorizar");
  await acao(id, "iniciar", AGENTE);
  await acao(id, "plano-pronto", AGENTE);
  await acao(id, "aprovar");
  return id;
};
const naExecucao = async () => {
  const id = await nova();
  await acao(id, "converter-execucao", HUMANO, contrato);
  return id;
};

// 1 — dependência segura também a Execução
test("dependência pendente segura iniciar-execucao; só forcar-inicio (humano) libera, com registro", async () => {
  const a = await nova();
  const b = await naExecucao();
  await depende(b, a);
  const r = await acao(b, "iniciar-execucao");
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /dependência/i);
  assert.equal((await obter(b)).state, "Na fila");

  assert.equal((await acao(b, "forcar-inicio", AGENTE)).status, 403);
  const f = await acao(b, "forcar-inicio", HUMANO, { motivo: "urgente" });
  assert.equal(f.status, 200);
  assert.deepEqual([(await obter(b)).phase, (await obter(b)).state], ["Execução", "Em execução"]);
  const ev = (await eventos(b)).filter((e) => e.tipo === "forcar-inicio");
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].autor, ev[0].de, ev[0].para, ev[0].motivo], ["humano", "Na fila", "Em execução", "urgente"]);
  assert.ok(!Number.isNaN(Date.parse(ev[0].em)));
});

test("forcar-inicio na fila sem dependência pendente é 409; sem pendência iniciar-execucao funciona", async () => {
  const b = await naExecucao();
  assert.equal((await acao(b, "forcar-inicio")).status, 409);
  assert.equal((await acao(b, "iniciar-execucao")).status, 200);
});

test("converter-execucao com dependência pendente é 409; com forcar-inicio posterior segue", async () => {
  const a = await nova();
  const b = await nova();
  await depende(b, a);
  assert.equal((await acao(b, "converter-execucao", HUMANO, contrato)).status, 409);
  assert.equal((await obter(b)).phase, "Exploração");
});

// 2 — estados que satisfazem a dependência e cascata para a Execução
test("domínio: Aprovado, Na fila, Em execução, Em validação e Concluído satisfazem a dependência", () => {
  for (const s of ["Aprovado", "Na fila", "Em execução", "Em validação", "Concluído"] as const)
    assert.equal(dependenciaPendente(s), false, s);
  for (const s of ["Novo", "Explorando", "Plano pronto para aprovação", "Rejeitado"] as const)
    assert.equal(dependenciaPendente(s), true, s);
  for (const s of ["Na fila", "Em execução", "Em validação"] as const) assert.ok(ESTADOS_ATIVOS.includes(s), s);
});

test("A convertida para Execução não é dependência pendente para sempre", async () => {
  const a = await aprovada();
  const b = await nova();
  await depende(b, a);
  assert.equal((await obter(b)).dependenciasPendentes.length, 0);
  await acao(a, "converter-execucao", HUMANO, contrato);
  assert.equal((await obter(b)).dependenciasPendentes.length, 0);
  await acao(a, "iniciar-execucao");
  await acao(a, "validar-execucao");
  await acao(a, "concluir-execucao");
  assert.equal((await obter(b)).dependenciasPendentes.length, 0);
});

test("rejeitar A leva B em Execução a Aguardando humano (retomável pela Execução)", async () => {
  const a = await nova();
  const b = await naExecucao();
  await depende(b, a);
  await acao(b, "forcar-inicio");
  assert.equal((await obter(b)).state, "Em execução");
  assert.equal((await acao(a, "rejeitar", HUMANO, { motivo: "escopo errado" })).status, 200);
  assert.equal((await obter(b)).state, "Aguardando humano");
  const ev = (await eventos(b)).at(-1)!;
  assert.equal(ev.tipo, "dependencia-rejeitada");
  assert.match(ev.motivo, /escopo errado/);
  assert.equal((await acao(b, "retomar-execucao")).status, 200);
  assert.equal((await obter(b)).state, "Em execução");
});

// 3 — rotas de configuração só do humano
test("Contexto, reassociação de Tarefa e remoção de dependência são só do humano; GET segue aberto", async () => {
  const c = await (await req("POST", "/contextos", HUMANO, { name: "C", kind: "cliente" })).json();
  const t = await nova();
  const outra = await nova();
  assert.equal((await req("POST", "/contextos", AGENTE, { name: "X", kind: "cliente" })).status, 403);
  assert.equal((await req("PATCH", `/contextos/${c.id}`, AGENTE, { name: "Y" })).status, 403);
  assert.equal((await req("PUT", `/tarefas/${t}/contexto`, AGENTE, { contextId: c.id })).status, 403);
  await depende(t, outra);
  assert.equal((await req("DELETE", `/tarefas/${t}/dependencias/${outra}`, AGENTE)).status, 403);
  assert.deepEqual((await obter(t)).dependenciasPendentes.map((d) => d.id), [outra]);
  assert.equal((await req("GET", "/contextos", AGENTE)).status, 200);
  assert.equal((await req("GET", `/contextos/${c.id}`, AGENTE)).status, 200);
  assert.equal((await req("GET", `/contextos/${c.id}/resolvido`, AGENTE)).status, 200);
  assert.equal(((await (await req("GET", `/contextos/${c.id}`, HUMANO)).json()) as { name: string }).name, "C");
});

test("agente pode declarar dependência (planejamento), mas não removê-la", async () => {
  const a = await nova();
  const b = await nova();
  assert.equal((await depende(b, a, AGENTE)).status, 201);
});

// 4 — PATCH /execucao e matriz de rotas por ator
test("agente não alcança a Execução pelo PATCH /execucao; em plano Aprovado só devolve à Aprovação", async () => {
  const id = await aprovada();
  const r = await req("PATCH", `/tarefas/${id}/execucao`, AGENTE, { ...contrato, criterios: ["outro"] });
  assert.equal(r.status, 200);
  const t = await obter(id);
  assert.deepEqual([t.phase, t.state], ["Exploração", "Plano pronto para aprovação"]);
  assert.notEqual(t.phase, "Execução");

  const e = await naExecucao();
  assert.equal((await req("PATCH", `/tarefas/${e}/execucao`, AGENTE, { criterios: ["x"] })).status, 403);
  assert.equal((await req("PATCH", `/tarefas/${e}/execucao`, AGENTE, { objetivo: "x" })).status, 403);
  assert.deepEqual([(await obter(e)).phase, (await obter(e)).state], ["Execução", "Na fila"]);
});

test("agente pode propor edição do plano na Exploração (RF6)", async () => {
  const id = await nova();
  assert.equal((await req("PATCH", `/tarefas/${id}/execucao`, AGENTE, contrato)).status, 200);
  assert.equal((await obter(id)).phase, "Exploração");
});

test("matriz: rotas que mudam estado recusam o agente com 403", async () => {
  const mae = await nova();
  const sub = await nova({ parentId: mae });
  const ctx = await (await req("POST", "/contextos", HUMANO, { name: "C", kind: "cliente" })).json();
  const dep = await nova();
  await depende(mae, dep);
  const acoes = [
    "autorizar", "aprovar", "rejeitar", "reabrir", "converter-execucao", "aprovar-subtarefa", "forcar-inicio",
    "iniciar-execucao", "aguardar-humano-execucao", "retomar-execucao", "validar-execucao", "concluir-execucao",
  ];
  for (const a of acoes) assert.equal((await acao(sub, a, AGENTE, contrato)).status, 403, a);
  assert.equal((await req("PATCH", `/tarefas/${sub}`, AGENTE, { title: "x" })).status, 403);
  assert.equal((await req("POST", "/tarefas", AGENTE, { title: "D", phase: "Execução", ...contrato })).status, 403);
  assert.equal((await req("POST", "/contextos", AGENTE, { name: "X", kind: "cliente" })).status, 403);
  assert.equal((await req("PATCH", `/contextos/${ctx.id}`, AGENTE, { name: "Z" })).status, 403);
  assert.equal((await req("PUT", `/tarefas/${mae}/contexto`, AGENTE, { contextId: ctx.id })).status, 403);
  assert.equal((await req("DELETE", `/tarefas/${mae}/dependencias/${dep}`, AGENTE)).status, 403);
  // prioridade definida pelo humano não é sobrescrita pelo agente
  const just = { impacto: "a", urgencia: "b", esforco: "c" };
  await req("PUT", `/tarefas/${mae}/prioridade`, HUMANO, { nivel: "urgente" });
  assert.equal((await req("PUT", `/tarefas/${mae}/prioridade`, AGENTE, { nivel: "baixa", ...just })).status, 409);
  const s = await obter(sub);
  assert.deepEqual([s.phase, s.state], ["Exploração", "Novo"]);
});

// 5 — auditoria
test("OPTIONS e /health não entram na auditoria", async () => {
  await fetch(daemon.url + "/health");
  await fetch(daemon.url + "/tarefas", { method: "OPTIONS" });
  await req("POST", "/tarefas", AGENTE, { title: "x" });
  const log = (await (await req("GET", "/auditoria", HUMANO)).json()) as { autor: string; metodo: string; caminho: string }[];
  assert.ok(!log.some((l) => l.metodo === "OPTIONS" || l.caminho === "/health"));
  assert.equal(log[0].autor, "agente:agente-a");
});

// 6 — edição de Subtarefa preserva o original
test("editar Subtarefa registra título e descrição antigos e novos no evento", async () => {
  const mae = await nova();
  const s = await nova({ parentId: mae, title: "Original", description: "desc velha" });
  const r = await req("PATCH", `/tarefas/${s}`, HUMANO, { title: "Novo título", description: "desc nova" });
  assert.equal(r.status, 200);
  const ev = (await eventos(s)).filter((e) => e.tipo === "editar");
  assert.equal(ev.length, 1);
  for (const trecho of ["Original", "Novo título", "desc velha", "desc nova"]) assert.ok(ev[0].motivo.includes(trecho), trecho);
});

// 7 — mãe da Subtarefa criada por agente
test("agente só cria Subtarefa sob mãe na Exploração e não Rejeitada (409)", async () => {
  const rejeitada = await nova();
  await acao(rejeitada, "rejeitar");
  assert.equal((await req("POST", "/tarefas", AGENTE, { title: "S", parentId: rejeitada })).status, 409);
  const emExecucao = await naExecucao();
  assert.equal((await req("POST", "/tarefas", AGENTE, { title: "S", parentId: emExecucao })).status, 409);
  const viva = await nova();
  assert.equal((await req("POST", "/tarefas", AGENTE, { title: "S", parentId: viva })).status, 201);
  assert.equal((await req("POST", "/tarefas", HUMANO, { title: "S", parentId: emExecucao })).status, 201);
});

// 10 — limites e download seguro
test("corpo JSON acima de 1 MiB é 413", async () => {
  const r = await req("POST", "/tarefas", HUMANO, { title: "x", description: "a".repeat(1024 * 1024 + 10) });
  assert.equal(r.status, 413);
  assert.deepEqual(await (await req("GET", "/tarefas", HUMANO)).json(), []);
});

test("upload sem content-length acima do limite é 413 e nada é salvo", async () => {
  const id = await nova();
  const corpo = new ReadableStream({
    start(c) {
      for (let i = 0; i < 20; i++) c.enqueue(new Uint8Array(500));
      c.close();
    },
  });
  const r = await fetch(`${daemon.url}/tarefas/${id}/anexos?nome=g.bin`, {
    method: "POST",
    headers: comToken(HUMANO),
    body: corpo,
    duplex: "half",
  } as RequestInit);
  assert.equal(r.status, 413);
  assert.equal(((await (await req("GET", `/tarefas/${id}/anexos`, HUMANO)).json()) as unknown[]).length, 0);
});

test("download: nosniff; tipos fora da allowlist viram octet-stream", async () => {
  const id = await nova();
  const subir = async (nome: string, tipo: string, dados: string) =>
    (await (await fetch(`${daemon.url}/tarefas/${id}/anexos?nome=${nome}`, { method: "POST", headers: comToken(HUMANO, { "content-type": tipo }), body: dados })).json()) as { id: string };
  const html = await subir("x.html", "text/html", "<script>alert(1)</script>");
  const png = await subir("x.png", "image/png", "png");
  const d1 = await fetch(`${daemon.url}/anexos/${html.id}`, { headers: comToken(HUMANO) });
  assert.equal(d1.headers.get("content-type"), "application/octet-stream");
  assert.equal(d1.headers.get("x-content-type-options"), "nosniff");
  assert.match(d1.headers.get("content-disposition")!, /^attachment/);
  const d2 = await fetch(`${daemon.url}/anexos/${png.id}`, { headers: comToken(HUMANO) });
  assert.equal(d2.headers.get("content-type"), "image/png");
  assert.equal(d2.headers.get("x-content-type-options"), "nosniff");
});
