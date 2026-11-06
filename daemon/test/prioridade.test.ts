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
const nova = async (title = "T") => (await (await req("POST", "/tarefas", HUMANO, { title })).json()).id as string;
const fila = async () => (await (await req("GET", "/tarefas", HUMANO)).json()) as any[];
const just = { impacto: "alto", urgencia: "prazo na sexta", esforco: "pequeno" };
const definir = (id: string, nivel: string, token = HUMANO, extra: object = just) =>
  req("PUT", `/tarefas/${id}/prioridade`, token, { nivel, ...extra });

test("Tarefa sem prioridade definida aparece como média, origem padrão", async () => {
  await nova();
  const [t] = await fila();
  assert.equal(t.priority.nivel, "média");
  assert.equal(t.priority.origem, "padrão");
});

test("agente sugere com justificativa; a Tarefa guarda nível, justificativa e autor", async () => {
  const id = await nova();
  const r = await definir(id, "alta", AGENTE);
  assert.equal(r.status, 200);
  const [t] = await fila();
  assert.equal(t.priority.nivel, "alta");
  assert.equal(t.priority.origem, "agente");
  assert.equal(t.priority.autor, "agente:agente-a");
  assert.deepEqual(t.priority.justificativa, just);
});

test("sugestão do agente exige impacto, urgência e esforço", async () => {
  const id = await nova();
  const r = await definir(id, "alta", AGENTE, { impacto: "alto" });
  assert.equal(r.status, 400);
  assert.equal((await fila())[0].priority.origem, "padrão");
});

test("nível inválido é recusado", async () => {
  const id = await nova();
  assert.equal((await definir(id, "crítica")).status, 400);
});

test("Tarefa inexistente → 404", async () => {
  assert.equal((await definir("nao-existe", "alta")).status, 404);
});

test("humano altera a sugestão do agente e o autor passa a ser humano", async () => {
  const id = await nova();
  await definir(id, "alta", AGENTE);
  assert.equal((await definir(id, "baixa", HUMANO, {})).status, 200);
  const [t] = await fila();
  assert.equal(t.priority.nivel, "baixa");
  assert.equal(t.priority.origem, "humano");
  assert.equal(t.priority.autor, "humano");
});

test("sugestão do agente não sobrescreve valor definido pelo humano", async () => {
  const id = await nova();
  await definir(id, "urgente", HUMANO);
  const r = await definir(id, "baixa", AGENTE);
  assert.equal(r.status, 409);
  const [t] = await fila();
  assert.equal(t.priority.nivel, "urgente");
  assert.equal(t.priority.autor, "humano");
});

test("agente pode refinar a própria sugestão anterior", async () => {
  const id = await nova();
  await definir(id, "baixa", AGENTE);
  assert.equal((await definir(id, "alta", AGENTE)).status, 200);
  assert.equal((await fila())[0].priority.nivel, "alta");
});

test("fila ordena por prioridade e, em empate, por chegada", async () => {
  const a = await nova("a-baixa");
  const b = await nova("b-urgente");
  const c = await nova("c-media-padrao");
  const d = await nova("d-urgente");
  const e = await nova("e-alta");
  const f = await nova("f-media-padrao");
  await definir(a, "baixa");
  await definir(b, "urgente");
  await definir(d, "urgente");
  await definir(e, "alta", AGENTE);
  assert.deepEqual(
    (await fila()).map((t) => t.title),
    ["b-urgente", "d-urgente", "e-alta", "c-media-padrao", "f-media-padrao", "a-baixa"],
  );
  void c;
  void f;
});
