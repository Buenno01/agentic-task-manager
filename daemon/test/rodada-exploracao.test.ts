import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/api/server.ts";
import { destravar } from "../src/workspace/workspace.ts";
import { criarExecutorFalso, type Roteiro } from "../src/executor/falso.ts";
import { CRED, HUMANO, AGENTE, ORQUESTRADOR, comToken } from "./helpers.ts";

let daemon: Daemon;
let dir: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

/** Repositório de origem temporário, acessado por file://. */
function origem(nome: string) {
  const d = join(dir, "origens", nome);
  mkdirSync(d, { recursive: true });
  git(d, "init", "-q", "-b", "main");
  writeFileSync(join(d, "a.txt"), "original\n");
  git(d, "add", ".");
  git(d, "commit", "-q", "-m", "inicial");
  return { url: `file://${d}`, dir: d };
}

/** Sobe o daemon real com o falso; `reativo` liga o orquestrador (varredura manual, sem timer). */
async function subir(roteiro: Roteiro, reativo = false) {
  const executor = criarExecutorFalso(roteiro);
  daemon = await startDaemon({
    dbPath: join(dir, "atm.db"),
    port: 0,
    credenciais: CRED,
    workspacesDir: join(dir, "ws"),
    reposDir: join(dir, "repos"),
    executor,
    orquestrador: reativo ? { aoMudarEstado: false, agendar: () => () => {} } : false,
  });
  return executor;
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atm-expl-"));
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
const contexto = async (repository: string) => (await json(await req("POST", "/contextos", HUMANO, { name: "Loja", kind: "repositorio", repository }))).id as string;
async function autorizada(contextId: string | null = null, title = "T") {
  const id = (await json(await req("POST", "/tarefas", AGENTE, { title, contextId }))).id as string;
  await acao(id, "autorizar");
  return id;
}
async function esperarFim(id: string) {
  for (let i = 0; i < 300; i++) {
    const r = (await json(await req("GET", `/tarefas/${id}/rodadas`, HUMANO))) as any[];
    if (r.length && r.every((x) => x.estado !== "em andamento")) return r;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error("Rodada não terminou");
}
const statusApi = (rod: any) => rod.eventos.filter((e: any) => e.tipo === "api").map((e: any) => e.dados.status);

test("fluxo com o falso: Autorizada → Explorando → Plano pronto, com plano, Subtarefa e Área prevista", async () => {
  const o = origem("loja");
  await subir(
    [
      { segmento: { modelo: "m", provedor: "p" } },
      { api: { metodo: "GET", caminho: "/busca?q=algo" } },
      { api: { metodo: "POST", caminho: "/tarefas/{tarefa}/comentarios", corpo: { texto: "achei o módulo" } } },
      { api: { metodo: "POST", caminho: "/tarefas", corpo: { title: "Subtarefa X", parentId: "{tarefa}" } } },
      { api: { metodo: "POST", caminho: "/tarefas/{tarefa}/entregar", corpo: { resumo: "plano", plano: "1. fazer A\n2. fazer B", areaPrevista: ["src/api", "./docs/"] } } },
    ],
    true,
  );
  const id = await autorizada(await contexto(o.url));
  await daemon.varrer();
  const [rod] = await esperarFim(id);
  assert.equal(rod.tipo, "Exploração");
  assert.equal(rod.estado, "concluída");
  assert.deepEqual(statusApi(rod).slice(0, 3), [200, 201, 201].slice(0, 3));
  const t = await tarefa(id);
  assert.equal(t.state, "Plano pronto para aprovação");
  assert.deepEqual(t.intendedArea, ["src/api", "docs"]);
  const hist = await json(await req("GET", `/tarefas/${id}/eventos`, HUMANO));
  const plano = hist.find((e: any) => e.tipo === "plano");
  assert.equal(plano.texto, "1. fazer A\n2. fazer B");
  assert.equal(plano.autor, "agente:orquestrador");
  assert.ok(hist.some((e: any) => e.tipo === "comentario" && e.texto === "achei o módulo"));
  // Aprovação continua humana.
  assert.equal((await acao(id, "aprovar", ORQUESTRADOR)).status, 403);
  assert.equal((await acao(id, "aprovar")).status, 200);
});

test("Exploração não escreve no repositório: commit no Workspace falha e a origem fica intacta", async () => {
  const o = origem("loja");
  await subir([{ commit: { arquivo: "a.txt", conteudo: "alterado", mensagem: "x" } }, { entrega: "nunca" }]);
  const id = await autorizada(await contexto(o.url));
  await acao(id, "iniciar", AGENTE);
  await req("POST", `/tarefas/${id}/rodadas`, HUMANO);
  const [rod] = await esperarFim(id);
  assert.equal(rod.estado, "falhou");
  assert.equal(git(o.dir, "status", "--porcelain"), "");
  assert.equal(git(rod.workspace, "log", "--oneline").split("\n").length, 1);
  assert.equal((await tarefa(id)).state, "Explorando");
});

test("perguntar → Aguardando humano; a resposta do humano devolve à Exploração e chega ao agente", async () => {
  await subir([{ pergunta: "Qual o escopo?" }]);
  const id = await autorizada();
  await acao(id, "iniciar", AGENTE);
  await req("POST", `/tarefas/${id}/rodadas`, HUMANO);
  await esperarFim(id);
  assert.equal((await tarefa(id)).state, "Aguardando humano");
  const hist = await json(await req("GET", `/tarefas/${id}/eventos`, HUMANO));
  const pergunta = hist.find((e: any) => e.tipo === "pergunta");
  assert.equal(pergunta.autor, "agente:orquestrador");

  // Sem resposta ainda.
  const antes = await json(await req("GET", `/tarefas/${id}/perguntas/${pergunta.id}`, ORQUESTRADOR));
  assert.deepEqual({ t: antes.texto, r: antes.resposta }, { t: "Qual o escopo?", r: null });
  assert.equal((await req("GET", `/tarefas/${id}/perguntas/nao-existe`, ORQUESTRADOR)).status, 404);

  // O humano responde: a Tarefa volta a Explorando e o agente lê a resposta.
  const r = await req("POST", `/tarefas/${id}/comentarios`, HUMANO, { tipo: "resposta", respondeA: pergunta.id, texto: "Só o módulo de API" });
  assert.equal(r.status, 201);
  assert.equal((await tarefa(id)).state, "Explorando");
  const depois = await json(await req("GET", `/tarefas/${id}/perguntas/${pergunta.id}`, ORQUESTRADOR));
  assert.equal(depois.resposta.texto, "Só o módulo de API");
  assert.equal(depois.resposta.autor, "humano");
  // Segue sendo possível entregar.
  assert.equal((await req("POST", `/tarefas/${id}/entregar`, ORQUESTRADOR, { resumo: "ok" })).status, 200);
});

test("entregar com pergunta sem resposta é 409; depois de respondida, entrega", async () => {
  await subir([{ pergunta: "Qual o escopo?" }]);
  const id = await autorizada();
  await acao(id, "iniciar", AGENTE);
  await req("POST", `/tarefas/${id}/rodadas`, HUMANO);
  await esperarFim(id);
  assert.equal((await tarefa(id)).state, "Aguardando humano");
  const pergunta = (await json(await req("GET", `/tarefas/${id}/eventos`, HUMANO))).find((e: any) => e.tipo === "pergunta");
  const bloqueada = await req("POST", `/tarefas/${id}/entregar`, ORQUESTRADOR, { resumo: "ok" });
  assert.equal(bloqueada.status, 409);
  assert.match((await json(bloqueada)).error, /pergunta sem resposta/);
  assert.equal((await tarefa(id)).state, "Aguardando humano");
  await req("POST", `/tarefas/${id}/comentarios`, HUMANO, { tipo: "resposta", respondeA: pergunta.id, texto: "ok" });
  assert.equal((await req("POST", `/tarefas/${id}/entregar`, ORQUESTRADOR, { resumo: "ok" })).status, 200);
});

test("perguntar duas vezes só volta a Explorando quando todas forem respondidas", async () => {
  await subir([{ pergunta: "A?" }, { pergunta: "B?" }]);
  const id = await autorizada();
  await acao(id, "iniciar", AGENTE);
  await req("POST", `/tarefas/${id}/rodadas`, HUMANO);
  await esperarFim(id);
  const [pa, pb] = (await json(await req("GET", `/tarefas/${id}/eventos`, HUMANO))).filter((e: any) => e.tipo === "pergunta");
  await req("POST", `/tarefas/${id}/comentarios`, HUMANO, { tipo: "resposta", respondeA: pa.id, texto: "a" });
  assert.equal((await tarefa(id)).state, "Aguardando humano");
  await req("POST", `/tarefas/${id}/comentarios`, HUMANO, { tipo: "resposta", respondeA: pb.id, texto: "b" });
  assert.equal((await tarefa(id)).state, "Explorando");
});

test("aviso de sobreposição da Área prevista aparece antes da Aprovação", async () => {
  const o = origem("loja");
  await subir([]);
  const ctx = await contexto(o.url);
  const a = await autorizada(ctx, "A");
  const b = await autorizada(ctx, "B");
  for (const id of [a, b]) await acao(id, "iniciar", AGENTE);
  const ea = await req("POST", `/tarefas/${a}/entregar`, ORQUESTRADOR, { resumo: "ok", areaPrevista: ["src/api"] });
  assert.equal((await json(ea)).overlapWarnings.length, 0);
  const eb = await json(await req("POST", `/tarefas/${b}/entregar`, ORQUESTRADOR, { resumo: "ok", areaPrevista: ["src/api/server.ts"] }));
  assert.equal(eb.state, "Plano pronto para aprovação");
  assert.equal(eb.overlapWarnings.length, 1);
  assert.equal(eb.overlapWarnings[0].taskId, a);
  assert.deepEqual((await tarefa(b)).overlapWarnings.map((w: any) => w.taskId), [a]);
  const aprovar = await acao(b, "aprovar");
  assert.equal(aprovar.status, 200);
});

test("entregar valida plano e Área prevista sem mudar o estado", async () => {
  await subir([]);
  const id = await autorizada();
  await acao(id, "iniciar", AGENTE);
  assert.equal((await req("POST", `/tarefas/${id}/entregar`, ORQUESTRADOR, { areaPrevista: "src" })).status, 400);
  assert.equal((await req("POST", `/tarefas/${id}/entregar`, ORQUESTRADOR, { plano: 3 })).status, 400);
  assert.equal((await tarefa(id)).state, "Explorando");
});

test("o agente nunca aprova, rejeita nem autoriza o próprio plano (403)", async () => {
  await subir([{ entrega: "plano" }, { api: { metodo: "POST", caminho: "/tarefas/{tarefa}/aprovar" } }]);
  const id = await autorizada();
  await acao(id, "iniciar", AGENTE);
  await req("POST", `/tarefas/${id}/rodadas`, HUMANO);
  const [rod] = await esperarFim(id);
  assert.deepEqual(statusApi(rod), [200, 403]);
  assert.equal((await tarefa(id)).state, "Plano pronto para aprovação");
  for (const t of [AGENTE, ORQUESTRADOR]) for (const a of ["aprovar", "rejeitar"]) assert.equal((await acao(id, a, t)).status, 403);
  assert.equal((await tarefa(id)).state, "Plano pronto para aprovação");
});
