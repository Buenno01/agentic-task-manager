import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/api/server.ts";
import { destravar } from "../src/workspace/workspace.ts";
import { criarExecutorFalso, type Roteiro } from "../src/executor/falso.ts";
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

async function subir(roteiro: Roteiro) {
  daemon = await startDaemon({
    dbPath: join(dir, "atm.db"),
    port: 0,
    credenciais: CRED,
    workspacesDir: join(dir, "ws"),
    reposDir: join(dir, "repos"),
    executor: criarExecutorFalso(roteiro),
    orquestrador: false,
  });
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atm-tok-"));
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
const acao = (id: string, a: string, token = HUMANO, body?: unknown) => req("POST", `/tarefas/${id}/${a}`, token, body);
const rodadas = async (id: string) => (await json(await req("GET", `/tarefas/${id}/rodadas`, HUMANO))) as any[];
const eventos = async (id: string) => (await json(await req("GET", `/tarefas/${id}/eventos`, HUMANO))) as any[];
async function esperarFim(id: string) {
  for (let i = 0; i < 300; i++) {
    const r = await rodadas(id);
    if (r.length && r.every((x) => x.estado !== "em andamento")) return r;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error("Rodada não terminou");
}
const contexto = async (repository: string) =>
  (await json(await req("POST", "/contextos", HUMANO, { name: "Loja", kind: "repositorio", repository }))).id as string;
const naFila = async (contextId: string, title = "T") =>
  (await json(await req("POST", "/tarefas", HUMANO, { title, phase: "Execução", objetivo: "o", repositorioPrincipal: "file:///x", criterios: ["c"], contextId }))).id as string;
async function executar(id: string) {
  assert.equal((await acao(id, "iniciar-execucao")).status, 200);
  assert.equal((await acao(id, "rodadas")).status, 202);
}

test("uso por Segmento, com troca de modelo abrindo novo Segmento e totais por Rodada e Tarefa", async () => {
  await subir([
    { segmento: { modelo: "m1", provedor: "p" } },
    { tokens: { entrada: 100, saida: 10, chamadas: 2, custo: 0.5 } },
    { tokens: { entrada: 50, saida: 5, chamadas: 1, custo: 0.25 } },
    { segmento: { modelo: "m2", provedor: "q" } },
    { tokens: { entrada: 7, saida: 3, chamadas: 1 } },
  ]);
  const id = await naFila(await contexto(origem("loja")));
  await executar(id);
  const [rod] = await esperarFim(id);
  assert.equal(rod.estado, "concluída");
  assert.equal(rod.segmentos.length, 2);
  const [s1, s2] = rod.segmentos;
  assert.deepEqual([s1.modelo, s1.provedor, s1.tokensEntrada, s1.tokensSaida, s1.chamadas, s1.custoEstimado, s1.usoDesconhecido], ["m1", "p", 150, 15, 3, 0.75, false]);
  assert.deepEqual([s2.modelo, s2.provedor, s2.tokensEntrada, s2.tokensSaida, s2.chamadas, s2.custoEstimado, s2.usoDesconhecido], ["m2", "q", 7, 3, 1, null, false]);
  assert.deepEqual(rod.totais, { tokensEntrada: 157, tokensSaida: 18, chamadas: 4, custoEstimado: 0.75, usoDesconhecido: false });

  const uso = await json(await req("GET", `/tarefas/${id}/uso`, HUMANO));
  assert.deepEqual(uso.totais, rod.totais);
  assert.equal(uso.rodadas.length, 1);
  assert.equal(uso.rodadas[0].id, rod.id);
  assert.equal(uso.rodadas[0].segmentos.length, 2);
  assert.deepEqual(uso.rodadas[0].totais, rod.totais);
  assert.equal((await req("GET", "/tarefas/nao-existe/uso", HUMANO)).status, 404);
});

test("uso ausente vira \"uso desconhecido\" (campos nulos) e a Rodada continua e conclui", async () => {
  await subir([
    { segmento: { modelo: "m1", provedor: "p" } },
    { segmento: { modelo: "m2", provedor: "p" } },
    { tokens: { entrada: 9, saida: 1 } },
    { commit: { arquivo: "x.txt", conteudo: "feito\n", mensagem: "feat: x" } },
    { entrega: "ok" },
  ]);
  const id = await naFila(await contexto(origem("loja")));
  await executar(id);
  const [rod] = await esperarFim(id);
  assert.equal(rod.estado, "concluída");
  const [s1, s2] = rod.segmentos;
  assert.deepEqual([s1.tokensEntrada, s1.tokensSaida, s1.chamadas, s1.custoEstimado, s1.usoDesconhecido], [null, null, null, null, true]);
  assert.equal(s2.usoDesconhecido, false);
  assert.equal(rod.totais.tokensEntrada, 9);
  assert.equal(rod.totais.usoDesconhecido, true);
  assert.equal((await json(await req("GET", `/tarefas/${id}/uso`, HUMANO))).totais.usoDesconhecido, true);
});

test("interseção real de arquivos com outra Tarefa aberta do mesmo repositório gera aviso e não bloqueia", async () => {
  await subir([
    { segmento: { modelo: "m", provedor: "p" } },
    { commit: { arquivo: "src/checkout/pagar.ts", conteudo: "x\n", mensagem: "feat: pagar" } },
    { entrega: "pronto" },
  ]);
  const url = origem("loja");
  const ctx = await contexto(url);
  const outra = await naFila(ctx, "Outra");
  assert.equal((await req("PUT", `/tarefas/${outra}/area-prevista`, HUMANO, { paths: ["src/checkout"] })).status, 200);
  const longe = await naFila(ctx, "Longe");
  await req("PUT", `/tarefas/${longe}/area-prevista`, HUMANO, { paths: ["docs"] });
  const outroRepo = await naFila(await contexto(origem("outro")), "OutroRepo");
  await req("PUT", `/tarefas/${outroRepo}/area-prevista`, HUMANO, { paths: ["src"] });

  const id = await naFila(ctx, "Minha");
  await executar(id);
  const [rod] = await esperarFim(id);

  assert.equal(rod.estado, "concluída", "o aviso nunca bloqueia");
  assert.equal((await json(await req("GET", `/tarefas/${id}`, HUMANO))).state, "Em validação");
  const avisos = rod.eventos.filter((e: any) => e.tipo === "aviso-sobreposicao");
  assert.equal(avisos.length, 1, "um aviso por interseção, sem repetir");
  assert.equal(avisos[0].dados.tarefaId, outra);
  assert.deepEqual(avisos[0].dados.sobreposicoes, [{ arquivo: "src/checkout/pagar.ts", area: "src/checkout" }]);
  const hist = (await eventos(id)).filter((e) => e.tipo === "aviso-sobreposicao");
  assert.equal(hist.length, 1);
  assert.match(hist[0].motivo, /Outra/);
});

test("sem interseção real, sem aviso", async () => {
  await subir([
    { segmento: { modelo: "m", provedor: "p" } },
    { commit: { arquivo: "src/novo.ts", conteudo: "x\n", mensagem: "feat: novo" } },
    { entrega: "pronto" },
  ]);
  const ctx = await contexto(origem("loja"));
  const outra = await naFila(ctx, "Outra");
  await req("PUT", `/tarefas/${outra}/area-prevista`, HUMANO, { paths: ["docs"] });
  const id = await naFila(ctx, "Minha");
  await executar(id);
  const [rod] = await esperarFim(id);
  assert.equal(rod.estado, "concluída");
  assert.equal(rod.eventos.filter((e: any) => e.tipo === "aviso-sobreposicao").length, 0);
});
