import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/api/server.ts";
import { destravar } from "../src/workspace/workspace.ts";
import type { Executor, EntradaRodada } from "../src/executor/executor.ts";
import { CRED, HUMANO, AGENTE, comToken } from "./helpers.ts";

let daemon: Daemon;
let dir: string;
let entradas: EntradaRodada[];
/** Ação do "agente" dentro do Workspace de cada Rodada (adaptador injetado, sem modelo). */
let acaoAgente: (e: EntradaRodada) => void;

const executor: Executor = {
  async executar(e) {
    entradas.push(e);
    acaoAgente(e);
  },
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

/** Repositório de origem temporário, acessado por file://. */
function origem(nome: string, arquivos: Record<string, string>) {
  const d = join(dir, "origens", nome);
  mkdirSync(d, { recursive: true });
  git(d, "init", "-q", "-b", "main");
  for (const [a, c] of Object.entries(arquivos)) writeFileSync(join(d, a), c);
  git(d, "add", ".");
  git(d, "commit", "-q", "-m", "inicial");
  return { url: `file://${d}`, dir: d };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "atm-ws-"));
  entradas = [];
  acaoAgente = () => {};
  daemon = await startDaemon({
    dbPath: join(dir, "atm.db"),
    port: 0,
    credenciais: CRED,
    workspacesDir: join(dir, "ws"),
    reposDir: join(dir, "repos"),
    executor,
  });
});
afterEach(async () => {
  await daemon?.close();
  destravar(dir); // worktrees de Exploração são somente leitura
  rmSync(dir, { recursive: true, force: true });
});

const req = (method: string, path: string, token: string, body?: unknown) =>
  fetch(daemon.url + path, {
    method,
    headers: { "content-type": "application/json", ...comToken(token) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (r: Response) => (await r.json()) as any;
const contexto = async (body: Record<string, unknown>) => (await json(await req("POST", "/contextos", HUMANO, body))).id as string;

const contrato = { objetivo: "Entregar X", repositorioPrincipal: "org/repo", criterios: ["testes passam"] };
async function tarefaExploracao(contextId: string | null) {
  const id = (await json(await req("POST", "/tarefas", AGENTE, { title: "T", contextId }))).id as string;
  await req("POST", `/tarefas/${id}/autorizar`, HUMANO);
  await req("POST", `/tarefas/${id}/iniciar`, AGENTE);
  return id;
}
async function tarefaExecucao(contextId: string | null) {
  const r = await req("POST", "/tarefas", HUMANO, { title: "E", phase: "Execução", contextId, ...contrato });
  assert.equal(r.status, 201);
  return (await json(r)).id as string;
}
async function rodar(id: string) {
  const antes = entradas.length;
  const r = await req("POST", `/tarefas/${id}/rodadas`, HUMANO);
  const corpo = await json(r);
  if (r.status !== 202) return { status: r.status, corpo, rodada: undefined };
  for (let i = 0; i < 200; i++) {
    const rs = (await json(await req("GET", `/tarefas/${id}/rodadas`, HUMANO))) as any[];
    if (rs.every((x) => x.estado !== "em andamento") && entradas.length > antes) return { status: 202, corpo, rodada: rs[rs.length - 1] };
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error("Rodada não terminou");
}
const falha = (f: () => void) => {
  try {
    f();
    return false;
  } catch {
    return true;
  }
};

test("Exploração recebe worktree do clone em atm-repos, com o conteúdo do repositório e somente leitura", async () => {
  const o = origem("loja", { "a.txt": "original\n", "src.ts": "x" });
  const ctx = await contexto({ name: "Loja", kind: "repositorio", repository: o.url });
  const id = await tarefaExploracao(ctx);
  let resultado: Record<string, boolean> = {};
  acaoAgente = (e) => {
    resultado = {
      novo: falha(() => writeFileSync(join(e.workspace, "novo.txt"), "x")),
      editar: falha(() => writeFileSync(join(e.workspace, "a.txt"), "alterado")),
      apagar: falha(() => rmSync(join(e.workspace, "a.txt"))),
      git: falha(() => {
        writeFileSync(join(e.workspace, "a.txt"), "z");
        git(e.workspace, "commit", "-qam", "x");
      }),
    };
  };
  const { rodada } = await rodar(id);
  assert.equal(rodada.estado, "concluída");
  assert.deepEqual(resultado, { novo: true, editar: true, apagar: true, git: true });
  assert.equal(readFileSync(join(rodada.workspace, "a.txt"), "utf8"), "original\n");
  // O clone fica no volume de repositórios e o origem não foi tocado.
  assert.ok(existsSync(join(dir, "repos")));
  assert.ok(rodada.workspace.startsWith(join(dir, "ws")));
  assert.equal(git(o.dir, "status", "--porcelain"), "");
});

test("Execução trabalha na branch atm/<tarefa-id>, gravável; a branch sobrevive à remoção do worktree", async () => {
  const o = origem("loja", { "a.txt": "original\n" });
  const ctx = await contexto({ name: "Loja", kind: "repositorio", repository: o.url });
  const id = await tarefaExecucao(ctx);
  acaoAgente = (e) => {
    writeFileSync(join(e.workspace, "feito.txt"), "ok");
    git(e.workspace, "add", ".");
    git(e.workspace, "commit", "-qm", "feat: feito");
  };
  const { rodada } = await rodar(id);
  assert.equal(rodada.estado, "concluída");
  assert.equal(rodada.tipo, "Execução");
  assert.equal(git(rodada.workspace, "rev-parse", "--abbrev-ref", "HEAD"), `atm/${id}`);
  assert.equal(git(rodada.workspace, "log", "-1", "--format=%s"), "feat: feito");
  assert.equal(readFileSync(join(rodada.workspace, "a.txt"), "utf8"), "original\n");
});

test("duas Tarefas do mesmo repositório têm Workspaces isolados", async () => {
  const o = origem("loja", { "a.txt": "original\n" });
  const ctx = await contexto({ name: "Loja", kind: "repositorio", repository: o.url });
  const t1 = await tarefaExecucao(ctx);
  const t2 = await tarefaExecucao(ctx);
  acaoAgente = (e) => {
    writeFileSync(join(e.workspace, `de-${e.tarefaId}.txt`), "x");
    git(e.workspace, "add", ".");
    git(e.workspace, "commit", "-qm", `feat: ${e.tarefaId}`);
  };
  const [r1, r2] = [(await rodar(t1)).rodada, (await rodar(t2)).rodada];
  assert.notEqual(r1.workspace, r2.workspace);
  assert.equal(git(r1.workspace, "rev-parse", "--abbrev-ref", "HEAD"), `atm/${t1}`);
  assert.equal(git(r2.workspace, "rev-parse", "--abbrev-ref", "HEAD"), `atm/${t2}`);
  assert.ok(existsSync(join(r1.workspace, `de-${t1}.txt`)));
  assert.ok(!existsSync(join(r1.workspace, `de-${t2}.txt`)));
  assert.ok(existsSync(join(r2.workspace, `de-${t2}.txt`)));
  assert.ok(!existsSync(join(r2.workspace, `de-${t1}.txt`)));
  // Mesmo clone, um só.
  assert.equal(git(r1.workspace, "rev-parse", "--git-common-dir"), git(r2.workspace, "rev-parse", "--git-common-dir"));
});

test("Execução repetida reaproveita o Workspace e a branch da Tarefa; Exploração e Execução não se misturam", async () => {
  const o = origem("loja", { "a.txt": "original\n" });
  const ctx = await contexto({ name: "Loja", kind: "repositorio", repository: o.url });
  const id = await tarefaExecucao(ctx);
  let n = 0;
  acaoAgente = (e) => {
    n++;
    writeFileSync(join(e.workspace, `p${n}.txt`), "x");
    git(e.workspace, "add", ".");
    git(e.workspace, "commit", "-qm", `p${n}`);
  };
  const a = (await rodar(id)).rodada;
  const b = (await rodar(id)).rodada;
  assert.equal(a.workspace, b.workspace);
  assert.ok(existsSync(join(b.workspace, "p1.txt")) && existsSync(join(b.workspace, "p2.txt")));
});

test("repositórios de consulta entram somente leitura; mudanças novas no remoto aparecem na Rodada seguinte", async () => {
  const o = origem("loja", { "a.txt": "1" });
  const ref = origem("docs", { "guia.md": "# guia" });
  const ctx = await contexto({ name: "Loja", kind: "repositorio", repository: o.url, referenceRepositories: [ref.url] });
  const id = await tarefaExploracao(ctx);
  let consultaEscrita = true;
  acaoAgente = (e) => {
    consultaEscrita = !falha(() => writeFileSync(join(e.workspace, "..", "consulta", "docs", "guia.md"), "hack"));
  };
  const r = (await rodar(id)).rodada;
  assert.equal(consultaEscrita, false);
  assert.equal(readFileSync(join(r.workspace, "..", "consulta", "docs", "guia.md"), "utf8"), "# guia");

  writeFileSync(join(o.dir, "b.txt"), "2");
  git(o.dir, "add", ".");
  git(o.dir, "commit", "-qm", "novo");
  const r2 = (await rodar(id)).rodada;
  assert.equal(readFileSync(join(r2.workspace, "b.txt"), "utf8"), "2");
});

test("repositório herdado do Contexto pai; sem repositório a Rodada recebe um repositório git vazio gravável", async () => {
  const o = origem("loja", { "a.txt": "1" });
  const pai = await contexto({ name: "Loja", kind: "loja", repository: o.url });
  const filho = await contexto({ name: "Checkout", kind: "projeto", parentId: pai });
  const id = await tarefaExecucao(filho);
  const r = (await rodar(id)).rodada;
  assert.equal(readFileSync(join(r.workspace, "a.txt"), "utf8"), "1");

  const sem = await tarefaExecucao(null);
  acaoAgente = (e) => writeFileSync(join(e.workspace, "x.txt"), "ok");
  const r2 = (await rodar(sem)).rodada;
  assert.equal(r2.estado, "concluída");
  assert.equal(git(r2.workspace, "rev-parse", "--is-inside-work-tree"), "true");
});

test("repositório inacessível recusa a Rodada com 400 e não cria Rodada", async () => {
  const ctx = await contexto({ name: "Quebrado", kind: "repositorio", repository: `file://${join(dir, "nao-existe")}` });
  const id = await tarefaExecucao(ctx);
  const r = await req("POST", `/tarefas/${id}/rodadas`, HUMANO);
  assert.equal(r.status, 400);
  assert.match((await json(r)).error, /clonar/);
  assert.deepEqual(await json(await req("GET", `/tarefas/${id}/rodadas`, HUMANO)), []);
});

test("referenceRepositories é validado e herdado pelo Contexto resolvido", async () => {
  const pai = await contexto({ name: "P", kind: "loja", referenceRepositories: ["file:///a"] });
  const filho = await contexto({ name: "F", kind: "projeto", parentId: pai });
  const res = await json(await req("GET", `/contextos/${filho}/resolvido`, HUMANO));
  assert.deepEqual(res.referenceRepositories, ["file:///a"]);
  const ruim = await req("POST", "/contextos", HUMANO, { name: "X", kind: "loja", referenceRepositories: "nao-lista" });
  assert.equal(ruim.status, 400);
});
