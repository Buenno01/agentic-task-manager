import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon, type OpcoesDaemon } from "../src/api/server.ts";
import type { Executor } from "../src/executor/executor.ts";
import { CRED, HUMANO, AGENTE, comToken } from "./helpers.ts";

let daemon: Daemon;
let dir: string;

/** Executor que só termina quando o teste libera a Tarefa (ou a Rodada é cancelada). */
function executorControlavel() {
  const iniciadas: string[] = [];
  const portas = new Map<string, () => void>();
  const executor: Executor = {
    executar: (e) =>
      new Promise<void>((ok, falha) => {
        iniciadas.push(e.tarefaId);
        portas.set(e.tarefaId, ok);
        e.sinal.addEventListener("abort", () => falha(new Error("cancelada")));
      }),
  };
  return { executor, iniciadas, liberar: (id: string) => portas.get(id)!() };
}

/** Sobe o daemon real; a varredura é manual (sem timer) e sem gatilho por mudança, salvo `reativo`. */
async function subir(executor: Executor, orq: { maxRodadas?: number; reativo?: boolean } = {}) {
  const opts: OpcoesDaemon = {
    dbPath: join(dir, "atm.db"),
    port: 0,
    credenciais: CRED,
    workspacesDir: join(dir, "ws"),
    executor,
    orquestrador: {
      maxRodadas: orq.maxRodadas,
      aoMudarEstado: orq.reativo ?? false,
      agendar: () => () => {},
    },
  };
  daemon = await startDaemon(opts);
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atm-orq-"));
});
afterEach(async () => {
  await daemon?.close();
  rmSync(dir, { recursive: true, force: true });
});

const req = (method: string, path: string, token: string, body?: unknown) =>
  fetch(daemon.url + path, {
    method,
    headers: { "content-type": "application/json", ...comToken(token) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (r: Response) => (await r.json()) as any;
const acao = (id: string, a: string, token = HUMANO, body?: unknown) => req("POST", `/tarefas/${id}/${a}`, token, body);
const estado = async (id: string) => (await json(await req("GET", `/tarefas/${id}`, HUMANO))).state as string;

/** Tarefa "Autorizada para explorar", opcionalmente com prioridade e Contexto. */
async function autorizada(title: string, o: { nivel?: string; contextId?: string } = {}) {
  const id = (await json(await req("POST", "/tarefas", AGENTE, { title, contextId: o.contextId }))).id as string;
  if (o.nivel) await req("PUT", `/tarefas/${id}/prioridade`, HUMANO, { nivel: o.nivel });
  await acao(id, "autorizar");
  return id;
}
const contrato = { objetivo: "o", repositorioPrincipal: "file:///x", criterios: ["c"] };
async function naFila(title: string, nivel?: string) {
  const id = (await json(await req("POST", "/tarefas", HUMANO, { title, phase: "Execução", ...contrato }))).id as string;
  if (nivel) await req("PUT", `/tarefas/${id}/prioridade`, HUMANO, { nivel });
  return id;
}
const contexto = async (body: Record<string, unknown>) => (await json(await req("POST", "/contextos", HUMANO, body))).id as string;

async function esperar(cond: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await cond()) return;
    await new Promise((ok) => setTimeout(ok, 10));
  }
  throw new Error("Condição não atingida");
}
const rodadasDe = async (id: string) => (await json(await req("GET", `/tarefas/${id}/rodadas`, HUMANO))) as any[];

test("inicia por prioridade e depois por chegada, respeitando o teto global (Exploração e Execução contam igual)", async () => {
  const c = executorControlavel();
  await subir(c.executor, { maxRodadas: 2 });
  const media1 = await autorizada("média 1");
  const media2 = await autorizada("média 2");
  const urgente = await naFila("urgente na fila", "urgente");
  const alta = await autorizada("alta", { nivel: "alta" });

  await daemon.varrer();
  assert.deepEqual(c.iniciadas, [urgente, alta]);
  assert.equal(await estado(urgente), "Em execução");
  assert.equal(await estado(alta), "Explorando");
  assert.equal(await estado(media1), "Autorizada para explorar");

  // Teto cheio: nova varredura não inicia nada.
  await daemon.varrer();
  assert.equal(c.iniciadas.length, 2);

  // Libera uma vaga: entra a mais antiga das médias.
  c.liberar(alta);
  await esperar(async () => (await rodadasDe(alta))[0].estado === "concluída");
  await daemon.varrer();
  assert.deepEqual(c.iniciadas, [urgente, alta, media1]);
  assert.equal(await estado(media2), "Autorizada para explorar");
});

test("limite de concorrência do Contexto é herdado e contado na subárvore", async () => {
  const c = executorControlavel();
  await subir(c.executor, { maxRodadas: 5 });
  const cliente = await contexto({ name: "Cliente", kind: "cliente", concurrencyLimit: 1 });
  const p1 = await contexto({ name: "P1", kind: "projeto", parentId: cliente });
  const p2 = await contexto({ name: "P2", kind: "projeto", parentId: cliente });
  const livre = await contexto({ name: "Outro", kind: "cliente" });
  const a = await autorizada("a", { contextId: p1 });
  const b = await autorizada("b", { contextId: p2 });
  const x = await autorizada("x", { contextId: livre });

  await daemon.varrer();
  // a e b disputam o limite 1 do cliente (irmãos na subárvore); x é de outro Contexto.
  assert.deepEqual(c.iniciadas, [a, x]);
  assert.equal(await estado(b), "Autorizada para explorar");

  c.liberar(a);
  await esperar(async () => (await rodadasDe(a))[0].estado === "concluída");
  await daemon.varrer();
  assert.deepEqual(c.iniciadas, [a, x, b]);
});

test("dependência pendente segura a Tarefa sem gastar tokens; Forçar início libera e fica registrado", async () => {
  const c = executorControlavel();
  await subir(c.executor, { maxRodadas: 5 });
  const base = await autorizada("base");
  const dependente = await autorizada("dependente");
  await req("POST", `/tarefas/${dependente}/dependencias`, HUMANO, { dependeDe: base });
  const base2 = await autorizada("base 2");
  await req("POST", `/tarefas/${dependente}/dependencias`, HUMANO, { dependeDe: base2 });

  await daemon.varrer();
  assert.ok(c.iniciadas.includes(base));
  assert.ok(!c.iniciadas.includes(dependente), "dependente segurada");
  assert.deepEqual(await rodadasDe(dependente), []);

  assert.equal((await acao(dependente, "forcar-inicio")).status, 200);
  await daemon.varrer();
  assert.ok(c.iniciadas.includes(dependente), "Forçar início libera");
  const hist = await json(await req("GET", `/tarefas/${dependente}/eventos`, HUMANO));
  assert.ok(JSON.stringify(hist).includes("forcar-inicio"), "forçar início registrado no histórico");
});

test("mudar a prioridade não cancela a Rodada em curso", async () => {
  const c = executorControlavel();
  await subir(c.executor, { maxRodadas: 1 });
  const a = await autorizada("a");
  await daemon.varrer();
  assert.deepEqual(c.iniciadas, [a]);

  assert.equal((await req("PUT", `/tarefas/${a}/prioridade`, HUMANO, { nivel: "baixa" })).status, 200);
  await daemon.varrer();
  const [r] = await rodadasDe(a);
  assert.equal(r.estado, "em andamento");
  assert.equal(await estado(a), "Explorando");
});

test("com gatilho por mudança de estado, autorizar já inicia a Rodada sem varredura manual", async () => {
  const c = executorControlavel();
  await subir(c.executor, { maxRodadas: 2, reativo: true });
  const a = await autorizada("a");
  await esperar(async () => c.iniciadas.includes(a));
  assert.equal(await estado(a), "Explorando");
  const [r] = await rodadasDe(a);
  assert.equal(r.tipo, "Exploração");
});

test("a Rodada iniciada pelo orquestrador registra o autor agente:orquestrador no histórico", async () => {
  const c = executorControlavel();
  await subir(c.executor);
  const a = await autorizada("a");
  await daemon.varrer();
  const eventos = await json(await req("GET", `/tarefas/${a}/eventos`, HUMANO));
  assert.ok(JSON.stringify(eventos).includes("agente:orquestrador"));
});
