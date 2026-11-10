import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/api/server.ts";
import { destravar } from "../src/workspace/workspace.ts";
import { criarExecutorFalso, type Roteiro } from "../src/executor/falso.ts";
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
  return { url: `file://${d}`, dir: d };
}

const subir = (roteiro: Roteiro) => subirExecutor(criarExecutorFalso(roteiro));
async function subirExecutor(executor: Executor) {
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
  dir = mkdtempSync(join(tmpdir(), "atm-limp-"));
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
const tarefa = async (id: string) => json(await req("GET", `/tarefas/${id}`, HUMANO));
const rodadas = async (id: string) => (await json(await req("GET", `/tarefas/${id}/rodadas`, HUMANO))) as any[];
const workspaces = async () => json(await req("GET", "/workspaces", HUMANO));

async function esperar(cond: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 300; i++) {
    if (await cond()) return;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error("Condição não atingida");
}
const esperarFim = (id: string) =>
  esperar(async () => {
    const r = await rodadas(id);
    return r.length > 0 && r.every((x) => x.estado !== "em andamento");
  });

async function contexto(repository: string) {
  return (await json(await req("POST", "/contextos", HUMANO, { name: "Loja", kind: "repositorio", repository }))).id as string;
}
async function naFila(contextId: string) {
  const r = await req("POST", "/tarefas", HUMANO, { title: "X", phase: "Execução", objetivo: "o", repositorioPrincipal: "file:///x", criterios: ["c"], contextId });
  return (await json(r)).id as string;
}
async function executar(id: string) {
  assert.equal((await acao(id, "iniciar-execucao")).status, 200);
  assert.equal((await acao(id, "rodadas")).status, 202);
}
const clones = () => readdirSync(join(dir, "repos")).map((n) => join(dir, "repos", n));
const temBranch = (ramo: string) => clones().some((c) => git(c, "branch", "--list", ramo) !== "");
const wsDir = (id: string) => join(dir, "ws", id);

const entregaFeliz: Roteiro = [
  { segmento: { modelo: "m", provedor: "p" } },
  { commit: { arquivo: "x.txt", conteudo: "feito\n", mensagem: "feat: x" } },
  { entrega: "X pronto" },
];

test("concluir remove o worktree e mantém a branch; em Em validação o Workspace fica", async () => {
  const o = origem("loja");
  await subir(entregaFeliz);
  const id = await naFila(await contexto(o.url));
  await executar(id);
  await esperarFim(id);
  assert.equal((await tarefa(id)).state, "Em validação");
  assert.ok(existsSync(wsDir(id)), "Em validação mantém o Workspace");
  assert.ok((await workspaces()).workspaces.some((w: any) => w.tarefaId === id));

  assert.equal((await acao(id, "concluir-execucao")).status, 200);
  await esperar(() => !existsSync(wsDir(id)));
  assert.ok(temBranch(`atm/${id}`), "branch atm/<id> preservada");
  assert.equal(git(clones()[0], "worktree", "list", "--porcelain").includes(id), false, "worktree desregistrado do clone");
});

test("Aguardando humano mantém o Workspace", async () => {
  const o = origem("loja");
  await subirExecutor({
    executar: (e) => new Promise((_, falha) => e.sinal.addEventListener("abort", () => falha(new Error("cancelada")))),
  });
  const id = await naFila(await contexto(o.url));
  await executar(id);
  assert.equal((await acao(id, "aguardar-humano-execucao", HUMANO, { motivo: "pausa" })).status, 200);
  await esperarFim(id);
  assert.ok(existsSync(wsDir(id)));
  assert.ok((await workspaces()).workspaces.some((w: any) => w.tarefaId === id && w.estado === "Aguardando humano" && !w.orfao));
});

test("rejeitar a Tarefa remove o worktree da Exploração e preserva o clone", async () => {
  const o = origem("loja");
  await subir([
    { segmento: { modelo: "m", provedor: "p" } },
    { api: { metodo: "POST", caminho: "/tarefas/{tarefa}/entregar", corpo: { resumo: "plano", plano: "1. A" } } },
  ]);
  const ctxId = await contexto(o.url);
  const id = (await json(await req("POST", "/tarefas", AGENTE, { title: "T", contextId: ctxId }))).id as string;
  await acao(id, "autorizar");
  await acao(id, "iniciar");
  assert.equal((await acao(id, "rodadas")).status, 202);
  await esperarFim(id);
  assert.equal((await tarefa(id)).state, "Plano pronto para aprovação");
  assert.ok(existsSync(wsDir(id)));

  assert.equal((await acao(id, "rejeitar")).status, 200);
  await esperar(() => !existsSync(wsDir(id)));
  assert.equal(clones().length, 1);
});

test("GET /workspaces mostra bytes por Workspace e o total", async () => {
  const o = origem("loja");
  await subir(entregaFeliz);
  const id = await naFila(await contexto(o.url));
  await executar(id);
  await esperarFim(id);
  writeFileSync(join(wsDir(id), "execucao", "grande.bin"), Buffer.alloc(200_000, 1));

  const r = await workspaces();
  const w = r.workspaces.find((x: any) => x.tarefaId === id);
  assert.ok(w.bytes >= 200_000);
  assert.equal(w.orfao, false);
  assert.equal(r.totalBytes, r.workspaces.reduce((s: number, x: any) => s + x.bytes, 0));
  assert.equal((await req("GET", "/workspaces", AGENTE)).status, 200, "agente pode ler");
  assert.equal((await fetch(daemon.url + "/workspaces")).status, 401);
});

test("POST /workspaces/limpar: agente leva 403; remove só órfãos (Tarefa inexistente ou terminal sem Rodada) e poupa os vivos", async () => {
  // Órfão = diretório em workspacesDir cuja Tarefa não existe, ou está Concluída/Rejeitada, sem Rodada em andamento.
  const o = origem("loja");
  await subir(entregaFeliz);
  const ctxId = await contexto(o.url);
  const vivo = await naFila(ctxId); // Em validação: vivo
  await executar(vivo);
  await esperarFim(vivo);

  const concluida = await naFila(ctxId);
  await executar(concluida);
  await esperarFim(concluida);
  await acao(concluida, "concluir-execucao");
  await esperar(() => !existsSync(wsDir(concluida)));
  mkdirSync(join(wsDir(concluida), "execucao"), { recursive: true }); // sobra de uma Tarefa terminal
  writeFileSync(join(wsDir(concluida), "execucao", "lixo.txt"), "x");

  mkdirSync(join(wsDir("fantasma"), "execucao"), { recursive: true }); // Tarefa inexistente
  writeFileSync(join(wsDir("fantasma"), "execucao", "lixo.txt"), "x");

  const antes = await workspaces();
  const orfaos = antes.workspaces.filter((w: any) => w.orfao).map((w: any) => w.tarefaId).sort();
  assert.deepEqual(orfaos, [concluida, "fantasma"].sort());

  assert.equal((await req("POST", "/workspaces/limpar", AGENTE)).status, 403);
  assert.equal((await req("POST", "/workspaces/limpar", CRED.agentes.orquestrador!)).status, 403);
  assert.ok(existsSync(wsDir("fantasma")), "agente não limpa nada");

  const r = await req("POST", "/workspaces/limpar", HUMANO);
  assert.equal(r.status, 200);
  const corpo = await json(r);
  assert.deepEqual(corpo.removidos.map((x: any) => x.tarefaId).sort(), [concluida, "fantasma"].sort());
  assert.ok(corpo.bytesLiberados > 0);
  assert.ok(!existsSync(wsDir("fantasma")));
  assert.ok(!existsSync(wsDir(concluida)));
  assert.ok(existsSync(wsDir(vivo)), "Workspace em Em validação permanece");
  assert.ok(temBranch(`atm/${vivo}`) && temBranch(`atm/${concluida}`));
  assert.deepEqual((await workspaces()).workspaces.map((w: any) => w.tarefaId), [vivo]);
});

test("sem expurgo automático por idade: Workspace antigo de Tarefa viva continua", async () => {
  const o = origem("loja");
  await subir(entregaFeliz);
  const id = await naFila(await contexto(o.url));
  await executar(id);
  await esperarFim(id);
  const antigo = new Date(Date.now() - 365 * 24 * 3600 * 1000);
  execFileSync("touch", ["-d", antigo.toISOString(), wsDir(id)]);
  await req("POST", "/workspaces/limpar", HUMANO);
  assert.ok(existsSync(wsDir(id)));
});
