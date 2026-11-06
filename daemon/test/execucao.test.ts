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
type T = { id: string; phase: string; state: string };
const tarefa = async (id: string) =>
  ((await (await req("GET", "/tarefas", HUMANO)).json()) as T[]).find((t) => t.id === id)!;
const eventos = async (id: string) =>
  (await (await req("GET", `/tarefas/${id}/eventos`, HUMANO)).json()) as Record<string, string>[];

const contrato = {
  objetivo: "Entregar X",
  repositorioPrincipal: "org/repo",
  criterios: ["testes passam"],
};
const nova = async () => (await (await req("POST", "/tarefas", AGENTE, { title: "T" })).json()).id as string;
async function aprovada() {
  const id = await nova();
  await acao(id, "autorizar");
  await acao(id, "iniciar", AGENTE);
  await acao(id, "plano-pronto", AGENTE);
  await acao(id, "aprovar");
  return id;
}

test("converter preserva o histórico e registra a conversão", async () => {
  const id = await aprovada();
  const r = await acao(id, "converter-execucao", HUMANO, contrato);
  assert.equal(r.status, 200);
  const t = await tarefa(id);
  assert.deepEqual([t.phase, t.state], ["Execução", "Na fila"]);
  const ev = await eventos(id);
  assert.deepEqual(
    ev.map((e) => e.tipo),
    ["autorizar", "iniciar", "plano-pronto", "aprovar", "converter-execucao"],
  );
  assert.equal(ev[4].de, "Aprovado");
  assert.equal(ev[4].para, "Na fila");
  assert.match(ev[4].motivo, /exploração concluída/i);
});

test("converter sem passar pela aprovação registra que a Exploração foi pulada", async () => {
  const id = await nova();
  assert.equal((await acao(id, "converter-execucao", HUMANO, contrato)).status, 200);
  const ev = await eventos(id);
  assert.equal(ev.at(-1)!.tipo, "converter-execucao");
  assert.match(ev.at(-1)!.motivo, /pulou a exploração/i);
});

test("conversão exige contrato mínimo e é só do humano", async () => {
  const id = await nova();
  assert.equal((await acao(id, "converter-execucao", AGENTE, contrato)).status, 403);
  assert.equal((await acao(id, "converter-execucao", HUMANO, { ...contrato, criterios: [] })).status, 400);
  assert.equal((await acao(id, "converter-execucao", HUMANO, { objetivo: "x" })).status, 400);
  assert.equal((await tarefa(id)).phase, "Exploração");
  await acao(id, "converter-execucao", HUMANO, contrato);
  assert.equal((await acao(id, "converter-execucao", HUMANO, contrato)).status, 409);
});

test("humano cria direto na Execução; fica registrado que a Exploração foi pulada", async () => {
  const r = await req("POST", "/tarefas", HUMANO, { title: "D", phase: "Execução", ...contrato });
  assert.equal(r.status, 201);
  const id = (await r.json()).id as string;
  const t = await tarefa(id);
  assert.deepEqual([t.phase, t.state], ["Execução", "Na fila"]);
  const ev = await eventos(id);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].autor, "humano");
  assert.match(ev[0].motivo, /pulou a exploração/i);
  const plano = await (await req("GET", `/tarefas/${id}/execucao`, HUMANO)).json();
  assert.equal(plano.repositorioPrincipal, "org/repo");
});

test("criação direta na Execução sem contrato é recusada (400)", async () => {
  const r = await req("POST", "/tarefas", HUMANO, { title: "D", phase: "Execução", objetivo: "x" });
  assert.equal(r.status, 400);
  assert.deepEqual(await (await req("GET", "/tarefas", HUMANO)).json(), []);
});

test("agente não cria Tarefa na Execução (403) e nada é criado", async () => {
  const r = await req("POST", "/tarefas", AGENTE, { title: "D", phase: "Execução", ...contrato });
  assert.equal(r.status, 403);
  assert.deepEqual(await (await req("GET", "/tarefas", HUMANO)).json(), []);
});

test("estados de execução são movidos manualmente pelo humano; agente recebe 403", async () => {
  const id = await nova();
  await acao(id, "converter-execucao", HUMANO, contrato);
  for (const a of ["iniciar-execucao", "validar-execucao", "concluir-execucao"])
    assert.equal((await acao(id, a, AGENTE)).status, 403, a);
  assert.equal((await tarefa(id)).state, "Na fila");
  const passos: [string, string][] = [
    ["iniciar-execucao", "Em execução"],
    ["aguardar-humano-execucao", "Aguardando humano"],
    ["retomar-execucao", "Em execução"],
    ["validar-execucao", "Em validação"],
    ["concluir-execucao", "Concluído"],
  ];
  for (const [a, esperado] of passos) {
    const r = await acao(id, a);
    assert.equal(r.status, 200, a);
    assert.equal((await tarefa(id)).state, esperado);
  }
  assert.equal((await acao(id, "iniciar-execucao")).status, 409);
});

test("transição de execução inválida é 409; ações da Exploração não valem na Execução", async () => {
  const id = await nova();
  await acao(id, "converter-execucao", HUMANO, contrato);
  assert.equal((await acao(id, "concluir-execucao")).status, 409);
  assert.equal((await acao(id, "retomar", AGENTE)).status, 409);
  await acao(id, "iniciar-execucao");
  await acao(id, "aguardar-humano-execucao");
  assert.equal((await acao(id, "retomar", AGENTE)).status, 409);
  assert.equal((await tarefa(id)).state, "Aguardando humano");
});

test("cada campo-chave editado em plano aprovado devolve à Aprovação", async () => {
  for (const [campo, valor] of [
    ["repositorioPrincipal", "org/outro"],
    ["criterios", ["novo critério"]],
    ["entregaveis", ["PR"]],
    ["permissoes", ["rede"]],
  ] as const) {
    const id = await aprovada();
    const r = await req("PATCH", `/tarefas/${id}/execucao`, HUMANO, { [campo]: valor });
    assert.equal(r.status, 200, campo);
    assert.equal((await tarefa(id)).state, "Plano pronto para aprovação", campo);
  }
});

test("mudança material em plano aprovado exige nova Aprovação", async () => {
  const id = await aprovada();
  assert.equal((await req("PATCH", `/tarefas/${id}/execucao`, AGENTE, { ...contrato })).status, 200);
  assert.equal((await tarefa(id)).state, "Plano pronto para aprovação");
  assert.equal((await acao(id, "aprovar")).status, 200);
  const r = await req("PATCH", `/tarefas/${id}/execucao`, AGENTE, { criterios: ["outro"] });
  assert.equal(r.status, 200);
  assert.equal((await tarefa(id)).state, "Plano pronto para aprovação");
  const ev = await eventos(id);
  assert.equal(ev.at(-1)!.tipo, "mudanca-material");
  assert.equal(ev.at(-1)!.de, "Aprovado");
});

test("edição sem mudança de valor ou de campo não-chave não devolve à Aprovação", async () => {
  const id = await aprovada();
  await req("PATCH", `/tarefas/${id}/execucao`, HUMANO, contrato);
  assert.equal((await acao(id, "aprovar")).status, 200);
  assert.equal((await tarefa(id)).state, "Aprovado");
  await req("PATCH", `/tarefas/${id}/execucao`, HUMANO, { criterios: contrato.criterios });
  await req("PATCH", `/tarefas/${id}/execucao`, HUMANO, { objetivo: "texto novo" });
  assert.equal((await tarefa(id)).state, "Aprovado");
});

test("editar campo-chave na Execução devolve a Tarefa à Aprovação (só humano)", async () => {
  const id = await nova();
  await acao(id, "converter-execucao", HUMANO, contrato);
  assert.equal((await req("PATCH", `/tarefas/${id}/execucao`, AGENTE, { criterios: ["x"] })).status, 403);
  assert.equal((await req("PATCH", `/tarefas/${id}/execucao`, HUMANO, { criterios: ["x"] })).status, 200);
  const t = await tarefa(id);
  assert.deepEqual([t.phase, t.state], ["Exploração", "Plano pronto para aprovação"]);
  assert.equal((await eventos(id)).at(-1)!.tipo, "mudanca-material");
});
