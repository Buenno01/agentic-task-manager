import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/api/server.ts";
import { criarExecutorFalso, type Roteiro } from "../src/executor/falso.ts";
import { CRED, HUMANO, AGENTE, ORQUESTRADOR, comToken } from "./helpers.ts";

let daemon: Daemon;
let dir: string;
let falso: ReturnType<typeof criarExecutorFalso>;

/** Sobe o daemon real (mesmo banco e Workspaces entre subidas) com o falso movido por `roteiro`. */
async function subir(roteiro: Roteiro) {
  await daemon?.close();
  falso = criarExecutorFalso(roteiro);
  daemon = await startDaemon({
    dbPath: join(dir, "atm.db"),
    port: 0,
    credenciais: CRED,
    workspacesDir: join(dir, "ws"),
    executor: falso,
    orquestrador: false,
  });
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atm-cp-"));
});
afterEach(async () => {
  await daemon?.close();
  daemon = undefined as unknown as Daemon;
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

async function explorando(contextId?: string) {
  const id = (await json(await req("POST", "/tarefas", AGENTE, { title: "Migrar pagamentos", description: "Trocar o gateway", contextId }))).id as string;
  await acao(id, "autorizar");
  await acao(id, "iniciar", AGENTE);
  return id;
}
const rodadas = async (id: string) => (await json(await req("GET", `/tarefas/${id}/rodadas`, HUMANO))) as any[];
async function rodar(id: string, nEsperadas: number) {
  assert.equal((await req("POST", `/tarefas/${id}/rodadas`, HUMANO)).status, 202);
  for (let i = 0; i < 200; i++) {
    const r = await rodadas(id);
    if (r.length === nEsperadas && r.every((x) => x.estado !== "em andamento")) return r;
    await new Promise((ok) => setTimeout(ok, 25));
  }
  throw new Error("Rodada não terminou");
}
const checkpoints = async (id: string) => (await json(await req("GET", `/tarefas/${id}/checkpoints`, HUMANO))) as any[];
const head = (ws: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: ws, encoding: "utf8" }).trim();

const CP = { progresso: "gateway lido", decisoes: ["usar SDK novo"], arquivosTocados: ["a.txt"], proximosPassos: ["migrar webhooks"] };

test("Checkpoint do agente e automático aparecem no histórico, com SHA do Workspace", async () => {
  await subir([
    { segmento: { modelo: "m", provedor: "p" } },
    { commit: { arquivo: "a.txt", conteudo: "1", mensagem: "feat: a" } },
    { api: { metodo: "POST", caminho: "/tarefas/{tarefa}/checkpoint", corpo: CP } },
    { commit: { arquivo: "b.txt", conteudo: "2", mensagem: "feat: b" } },
    { falha: "caiu" },
  ]);
  const id = await explorando();
  const [rod] = await rodar(id, 1);
  assert.equal(rod.estado, "falhou");

  const cps = await checkpoints(id);
  assert.deepEqual(cps.map((c) => c.origem), ["agente", "automático"]);
  const [agente, auto] = cps;
  assert.match(agente.sha, /^[0-9a-f]{40}$/);
  assert.notEqual(agente.sha, auto.sha);
  assert.equal(auto.sha, head(rod.workspace));
  assert.deepEqual(
    { p: agente.progresso, d: agente.decisoes, a: agente.arquivosTocados, n: agente.proximosPassos },
    { p: "gateway lido", d: ["usar SDK novo"], a: ["a.txt"], n: ["migrar webhooks"] },
  );
  assert.deepEqual(auto.arquivosTocados, ["b.txt"]); // alterados desde o Checkpoint anterior

  const hist = await json(await req("GET", `/tarefas/${id}/eventos`, HUMANO));
  const noHist = hist.filter((e: any) => e.tipo === "checkpoint");
  assert.equal(noHist.length, 2);
  assert.match(noHist[0].motivo, new RegExp(agente.sha));
  assert.match(noHist[1].motivo, new RegExp(auto.sha));
  assert.ok(rod.eventos.some((e: any) => e.tipo === "checkpoint" && e.dados.sha === agente.sha));
  assert.equal((await req("GET", `/tarefas/nao-existe/checkpoints`, HUMANO)).status, 404);
});

test("a Rodada seguinte recebe último Checkpoint, diff desde o SHA e Contexto consolidado", async () => {
  await subir([]);
  const ctx = (await json(await req("POST", "/contextos", HUMANO, { name: "Loja", kind: "loja" }))).id as string;
  await subir([
    { segmento: { modelo: "m", provedor: "p" } },
    { commit: { arquivo: "a.txt", conteudo: "primeiro", mensagem: "feat: a" } },
    { api: { metodo: "POST", caminho: "/tarefas/{tarefa}/checkpoint", corpo: CP } },
    { commit: { arquivo: "b.txt", conteudo: "segundo-arquivo", mensagem: "feat: b" } },
    { falha: "caiu no meio" },
  ]);
  await req("PUT", `/contextos/${ctx}/consolidado`, AGENTE, { text: "A loja usa o gateway Zeta." });
  const id = await explorando(ctx);
  const [r1] = await rodar(id, 1);
  const shaAgente = (await checkpoints(id))[0].sha;
  assert.ok(!falso.prompts[0].includes("Retomada"), "primeira Rodada não é retomada");
  assert.match(falso.prompts[0], /Migrar pagamentos/);
  assert.match(falso.prompts[0], /gateway Zeta/);

  await subir([{ passo: "retomando" }]);
  await rodar(id, 2);
  const p = falso.prompts[0];
  assert.match(p, /Retomada a partir do último Checkpoint/);
  assert.match(p, /gateway lido/);
  assert.match(p, /usar SDK novo/);
  assert.match(p, /migrar webhooks/);
  assert.ok(p.includes(shaAgente), "SHA do Checkpoint");
  assert.match(p, /\+\+\+ b\/b\.txt/);
  assert.match(p, /\+segundo-arquivo/);
  assert.ok(!/\+\+\+ b\/a\.txt/.test(p), "diff é só desde o SHA");
  assert.match(p, /gateway Zeta/);
  // O prompt também fica registrado como evento da Rodada.
  const [, r2] = await rodadas(id);
  assert.equal(r2.eventos.find((e: any) => e.tipo === "prompt").dados.texto, p);
  assert.equal(r2.workspace, r1.workspace);
});

test("sem Checkpoint, a Rodada recomeça do zero com o Workspace preservado", async () => {
  await subir([{ commit: { arquivo: "x.txt", conteudo: "trabalho", mensagem: "feat: x" } }, { falha: "morreu cedo" }]);
  const id = await explorando();
  const [r1] = await rodar(id, 1);
  assert.deepEqual(await checkpoints(id), []);

  await subir([{ passo: "de novo" }]);
  await rodar(id, 2);
  const p = falso.prompts[0];
  assert.doesNotMatch(p, /último Checkpoint/);
  assert.match(p, /recomece do zero/);
  assert.match(p, /Workspace foi preservado/);
  assert.match(p, /- x\.txt/);
  assert.ok(existsSync(join(r1.workspace, "x.txt")), "Workspace preservado");
  // Sem Segmento aberto, a Rodada concluída também não gerou Checkpoint automático.
  assert.deepEqual(await checkpoints(id), []);
});

test("Checkpoint automático ao fim de cada Segmento; agente continua sem poder de aprovar", async () => {
  await subir([
    { segmento: { modelo: "m1", provedor: "p" } },
    { commit: { arquivo: "a.txt", conteudo: "1", mensagem: "feat: a" } },
    { segmento: { modelo: "m2", provedor: "p" } },
    { commit: { arquivo: "b.txt", conteudo: "2", mensagem: "feat: b" } },
    { api: { metodo: "POST", caminho: "/tarefas/{tarefa}/aprovar" } },
  ]);
  const id = await explorando();
  const [rod] = await rodar(id, 1);
  assert.equal(rod.estado, "concluída");
  const cps = await checkpoints(id);
  assert.deepEqual(cps.map((c) => c.origem), ["automático", "automático"]); // fim do 1º e do 2º Segmento
  assert.equal(cps[1].sha, head(rod.workspace));
  assert.ok(cps[0].arquivosTocados.includes("a.txt"));
  assert.ok(cps[1].arquivosTocados.includes("b.txt") || cps[0].arquivosTocados.includes("b.txt")); // o corte do 1º é assíncrono
  assert.equal((await req("POST", `/tarefas/${id}/checkpoint`, ORQUESTRADOR, { progresso: "x" })).status, 409); // sem Rodada ativa
  assert.equal((await req("POST", `/tarefas/${id}/checkpoint`, AGENTE, { progresso: "x" })).status, 409);
});
