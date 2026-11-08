import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/api/server.ts";
import { destravar } from "../src/workspace/workspace.ts";
import type { Executor } from "../src/executor/executor.ts";
import { CRED, HUMANO, AGENTE, comToken } from "./helpers.ts";

let daemon: Daemon;
let dir: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

function origem(nome: string) {
  const d = join(dir, "origens", nome);
  mkdirSync(d, { recursive: true });
  git(d, "init", "-q", "-b", "main");
  writeFileSync(join(d, "a.txt"), "original\n");
  git(d, "add", ".");
  git(d, "commit", "-q", "-m", "inicial");
  return `file://${d}`;
}

const prompts: string[] = [];
/** Agente que, ao fim, entrega informando o novo Contexto consolidado (texto vem de `textos`, na ordem das Rodadas). */
function agente(textos: (string | undefined)[]): Executor {
  let n = 0;
  return {
    async executar(e) {
      prompts.push(e.prompt);
      const texto = textos[n++];
      const r = await fetch(`${e.ambiente.ATM_API_URL}/tarefas/${e.tarefaId}/entregar`, {
        method: "POST",
        headers: { "content-type": "application/json", ...comToken(e.ambiente.ATM_AGENT_TOKEN) },
        body: JSON.stringify({ resumo: "feito", ...(texto !== undefined ? { consolidado: texto } : {}) }),
      });
      await r.arrayBuffer();
    },
  };
}

async function subir(executor: Executor) {
  daemon = await startDaemon({
    dbPath: join(dir, "atm.db"),
    port: 0,
    credenciais: CRED,
    workspacesDir: join(dir, "ws"),
    reposDir: join(dir, "repos"),
    executor,
    orquestrador: false,
  });
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atm-cexec-"));
  prompts.length = 0;
});
afterEach(async () => {
  await daemon?.close();
  destravar(dir);
  rmSync(dir, { recursive: true, force: true });
});

const req = (method: string, path: string, token: string, body?: unknown) =>
  fetch(daemon.url + path, {
    method,
    headers: { "content-type": "application/json", ...comToken(token) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (r: Response) => (await r.json()) as any;
const acao = (id: string, a: string, token = HUMANO) => req("POST", `/tarefas/${id}/${a}`, token);
const tarefa = async (id: string) => json(await req("GET", `/tarefas/${id}`, HUMANO));
const rodadas = async (id: string) => (await json(await req("GET", `/tarefas/${id}/rodadas`, HUMANO))) as any[];
async function esperarFim(id: string) {
  for (let i = 0; i < 300; i++) {
    const r = await rodadas(id);
    if (r.length > 0 && r.every((x) => x.estado !== "em andamento")) return;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error("Rodada não terminou");
}
async function contexto() {
  return (await json(await req("POST", "/contextos", HUMANO, { name: "Loja", kind: "repositorio", repository: origem("loja") }))).id as string;
}
async function naFila(contextId: string, title = "Implementar X") {
  const r = await req("POST", "/tarefas", HUMANO, { title, phase: "Execução", objetivo: "o", repositorioPrincipal: "file:///x", criterios: ["c"], contextId });
  return (await json(r)).id as string;
}
async function executar(id: string) {
  assert.equal((await acao(id, "iniciar-execucao")).status, 200);
  assert.equal((await acao(id, "rodadas")).status, 202);
  await esperarFim(id);
}
const versoes = async (ctx: string) => (await json(await req("GET", `/contextos/${ctx}/consolidado/versoes`, HUMANO))) as any[];

/**
 * Ponto escolhido: o agente atualiza o consolidado ao ENTREGAR (`entregar` com `consolidado`), isto é,
 * quando o trabalho da Tarefa termina e ainda antes da validação humana. A entrega é recusada se o
 * consolidado não puder ser gravado, então a Tarefa nunca chega a "Em validação" com o consolidado perdido.
 */
test("ao entregar, o agente grava nova versão do consolidado com origem na Rodada; humano reverte sem apagar histórico; a próxima Rodada recebe a versão atual", async () => {
  await subir(agente(["Usar Tailwind.", "Usar Tailwind. Deploy às sextas é proibido."]));
  const ctx = await contexto();
  const t1 = await naFila(ctx, "Primeira");
  await executar(t1);

  assert.equal((await tarefa(t1)).state, "Em validação");
  const [rod1] = await rodadas(t1);
  let vs = await versoes(ctx);
  assert.equal(vs.length, 1);
  assert.equal(vs[0].text, "Usar Tailwind.");
  assert.equal(vs[0].rodadaId, rod1.id);
  assert.equal(vs[0].taskId, t1);
  assert.equal(vs[0].author, "agente:orquestrador");
  assert.match(prompts[0], /\(vazio\)/);

  // A Rodada seguinte (outra Tarefa do Contexto) recebe a versão atual no pacote inicial.
  const t2 = await naFila(ctx, "Segunda");
  await executar(t2);
  assert.match(prompts[1], /## Contexto consolidado\nUsar Tailwind\./);
  const [rod2] = await rodadas(t2);
  vs = await versoes(ctx);
  assert.equal(vs.length, 2);
  assert.equal(vs[1].rodadaId, rod2.id);

  // Reverter: nova versão com o texto da anterior; nada é apagado.
  const rev = await req("POST", `/contextos/${ctx}/consolidado/reverter`, HUMANO, {});
  assert.equal(rev.status, 201);
  vs = await versoes(ctx);
  assert.equal(vs.length, 3);
  assert.equal(vs[2].text, "Usar Tailwind.");
  assert.equal(vs[2].revertedFrom, 1);
  assert.equal(vs[1].text, "Usar Tailwind. Deploy às sextas é proibido.", "o histórico permanece");
  assert.equal((await json(await req("GET", `/contextos/${ctx}/consolidado`, HUMANO))).text, "Usar Tailwind.");

  // A Rodada que vem depois da reversão recebe a versão restaurada.
  const t3 = await naFila(ctx, "Terceira");
  await executar(t3);
  assert.match(prompts[2], /## Contexto consolidado\nUsar Tailwind\.(\n|$)/);
  assert.doesNotMatch(prompts[2], /sextas/);
  assert.equal((await versoes(ctx)).length, 3, "sem `consolidado` na entrega, nada novo");
});

test("sem `consolidado` na entrega, nada é gravado; o token de agente não aprova nada", async () => {
  await subir(agente([undefined]));
  const ctx = await contexto();
  const t = await naFila(ctx);
  await executar(t);
  assert.equal((await tarefa(t)).state, "Em validação");
  assert.deepEqual(await versoes(ctx), []);
  assert.equal((await acao(t, "concluir-execucao", CRED.agentes.orquestrador!)).status, 403);
  assert.equal((await acao(t, "concluir-execucao", AGENTE)).status, 403);
});

test("consolidado inválido na entrega é recusado e a Tarefa não vai a Em validação", async () => {
  const statuses: number[] = [];
  const ex: Executor = {
    async executar(e) {
      const r = await fetch(`${e.ambiente.ATM_API_URL}/tarefas/${e.tarefaId}/entregar`, {
        method: "POST",
        headers: { "content-type": "application/json", ...comToken(e.ambiente.ATM_AGENT_TOKEN) },
        body: JSON.stringify({ resumo: "x", consolidado: 42 }),
      });
      statuses.push(r.status);
      await r.arrayBuffer();
    },
  };
  await subir(ex);
  const ctx = await contexto();
  const t = await naFila(ctx);
  await executar(t);
  assert.deepEqual(statuses, [400]);
  assert.equal((await tarefa(t)).state, "Em execução");
  assert.deepEqual(await versoes(ctx), []);
});

test("PUT do consolidado aceita rodadaId (inexistente é 400) e o agente não ganha poder de aprovação", async () => {
  await subir(agente([]));
  const ctx = await contexto();
  const t = await naFila(ctx);
  await executar(t);
  const orq = CRED.agentes.orquestrador!;
  const ruim = await req("PUT", `/contextos/${ctx}/consolidado`, orq, { text: "x", rodadaId: "nao-existe" });
  assert.equal(ruim.status, 400);
  const [rod] = await rodadas(t);
  const ok = await req("PUT", `/contextos/${ctx}/consolidado`, orq, { text: "x", rodadaId: rod.id });
  assert.equal(ok.status, 201);
  const v = await json(ok);
  assert.equal(v.rodadaId, rod.id);
  assert.equal(v.taskId, t, "a Tarefa de origem é deduzida da Rodada");
});
