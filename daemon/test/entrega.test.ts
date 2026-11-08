import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/api/server.ts";
import { destravar } from "../src/workspace/workspace.ts";
import { criarExecutorFalso, type Roteiro } from "../src/executor/falso.ts";
import type { EntradaRodada, Executor } from "../src/executor/executor.ts";
import type { CriarPr, PedidoPr } from "../src/rodada/entrega.ts";
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

async function subir(executor: Executor, extra: { criarPr?: CriarPr } = {}) {
  daemon = await startDaemon({
    dbPath: join(dir, "atm.db"),
    port: 0,
    credenciais: CRED,
    workspacesDir: join(dir, "ws"),
    reposDir: join(dir, "repos"),
    executor,
    orquestrador: false,
    ...extra,
  });
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atm-ent-"));
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
const eventos = async (id: string) => (await json(await req("GET", `/tarefas/${id}/eventos`, HUMANO))) as any[];

async function esperar(cond: () => Promise<boolean>) {
  for (let i = 0; i < 300; i++) {
    if (await cond()) return;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error("Condição não atingida");
}
const esperarFim = (id: string) => esperar(async () => {
  const r = await rodadas(id);
  return r.length > 0 && r.every((x) => x.estado !== "em andamento");
});

async function contexto(repository: string, deliveryMode?: string) {
  const r = await json(await req("POST", "/contextos", HUMANO, { name: "Loja", kind: "repositorio", repository, ...(deliveryMode ? { deliveryMode } : {}) }));
  return r.id as string;
}
/** Tarefa "Na fila" (criada direto na Execução) ligada ao Contexto. */
async function naFila(contextId: string) {
  const r = await req("POST", "/tarefas", HUMANO, { title: "Implementar X", phase: "Execução", objetivo: "o", repositorioPrincipal: "file:///x", criterios: ["c"], contextId });
  return (await json(r)).id as string;
}
async function executar(id: string) {
  assert.equal((await acao(id, "iniciar-execucao")).status, 200);
  assert.equal((await acao(id, "rodadas")).status, 202);
}
/** Clone mantido em atm-repos (onde a branch atm/<id> sobrevive ao Workspace). */
const clones = () => readdirSync(join(dir, "repos")).map((n) => join(dir, "repos", n));
const temBranch = (ramo: string) => clones().some((c) => git(c, "branch", "--list", ramo) !== "");

const roteiroFeliz: Roteiro = [
  { segmento: { modelo: "m", provedor: "p" } },
  { commit: { arquivo: "x.txt", conteudo: "feito\n", mensagem: "feat: x" } },
  { entrega: "X pronto" },
];

test("fluxo completo: Na fila → Em execução → Em validação → Concluído, com a branch atm/<id> no clone", async () => {
  const o = origem("loja");
  await subir(criarExecutorFalso(roteiroFeliz));
  const id = await naFila(await contexto(o.url));
  await executar(id);
  await esperarFim(id);

  const t = await tarefa(id);
  assert.equal(t.state, "Em validação");
  const [rod] = await rodadas(id);
  assert.equal(rod.estado, "concluída");
  assert.equal(rod.tipo, "Execução");
  assert.ok(temBranch(`atm/${id}`), "branch atm/<id> presente no clone");

  const ev = rod.eventos.filter((e: any) => e.tipo === "entrega" && e.dados.modo).at(-1);
  assert.equal(ev.dados.branch, `atm/${id}`);
  assert.equal(ev.dados.modo, "branch-local");
  assert.equal(ev.dados.prUrl, null);
  const clone = clones().find((c) => git(c, "branch", "--list", `atm/${id}`) !== "")!;
  assert.equal(git(clone, "rev-parse", `atm/${id}`), ev.dados.sha);
  assert.equal(git(clone, "show", `atm/${id}:x.txt`), "feito");
  const entregou = (await eventos(id)).find((e) => e.tipo === "entregar");
  assert.match(entregou.motivo, new RegExp(`branch atm/${id}.*SHA ${ev.dados.sha}`));

  assert.equal((await acao(id, "concluir-execucao")).status, 200);
  assert.equal((await tarefa(id)).state, "Concluído");
  assert.equal(git(o.dir, "branch", "--list", `atm/${id}`), "", "o agente nunca publicou nem fez merge na origem");
});

test("o aceite é só do humano: token de agente é recusado em Em validação", async () => {
  const o = origem("loja");
  await subir(criarExecutorFalso(roteiroFeliz));
  const id = await naFila(await contexto(o.url));
  await executar(id);
  await esperarFim(id);

  assert.equal((await acao(id, "concluir-execucao", AGENTE)).status, 403);
  assert.equal((await tarefa(id)).state, "Em validação");
  assert.equal((await acao(id, "concluir-execucao", CRED.agentes.orquestrador!)).status, 403);
  assert.equal((await acao(id, "concluir-execucao")).status, 200);
});

test("mudanças pendentes no Workspace são commitadas na entrega", async () => {
  const o = origem("loja");
  const sujo: Executor = {
    async executar(e) {
      writeFileSync(join(e.workspace, "novo.txt"), "sem commit\n");
      await (await fetch(`${e.ambiente.ATM_API_URL}/tarefas/${e.tarefaId}/entregar`, {
        method: "POST",
        headers: { "content-type": "application/json", ...comToken(e.ambiente.ATM_AGENT_TOKEN) },
        body: JSON.stringify({ resumo: "feito" }),
      })).arrayBuffer();
    },
  };
  await subir(sujo);
  const id = await naFila(await contexto(o.url));
  await executar(id);
  await esperarFim(id);
  assert.equal((await tarefa(id)).state, "Em validação");
  const clone = clones().find((c) => git(c, "branch", "--list", `atm/${id}`) !== "")!;
  assert.equal(git(clone, "show", `atm/${id}:novo.txt`), "sem commit");
});

test("mudança material durante a Rodada devolve a Tarefa à Aprovação e cancela a Rodada", async () => {
  const o = origem("loja");
  const travada: Executor = {
    executar: (e: EntradaRodada) => new Promise((_, falha) => e.sinal.addEventListener("abort", () => falha(new Error("cancelada")))),
  };
  await subir(travada);
  const id = await naFila(await contexto(o.url));
  await executar(id);

  // Agente não altera o contrato na Execução; o humano sim.
  assert.equal((await req("PATCH", `/tarefas/${id}/execucao`, AGENTE, { criterios: ["outro"] })).status, 403);
  assert.equal((await req("PATCH", `/tarefas/${id}/execucao`, HUMANO, { criterios: ["critério novo"] })).status, 200);
  await esperarFim(id);
  assert.equal((await rodadas(id))[0].estado, "cancelada");
  const t = await tarefa(id);
  assert.deepEqual([t.phase, t.state], ["Exploração", "Plano pronto para aprovação"]);
  assert.ok((await eventos(id)).some((e) => e.tipo === "mudanca-material"));
});

test("pergunta de negócio interrompe só a parte afetada: Tarefa aguarda, a Rodada segue e retoma com a resposta", async () => {
  const o = origem("loja");
  const marcas: string[] = [];
  const agente = (e: EntradaRodada) => (metodo: string, caminho: string, corpo?: unknown) =>
    fetch(e.ambiente.ATM_API_URL + caminho, {
      method: metodo,
      headers: { "content-type": "application/json", ...comToken(e.ambiente.ATM_AGENT_TOKEN) },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    }).then((r) => r.json() as Promise<any>);
  const pausa = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
  const duasPartes: Executor = {
    async executar(e) {
      const api = agente(e);
      // Parte B segue trabalhando enquanto a parte A espera a resposta.
      const parteB = (async () => {
        writeFileSync(join(e.workspace, "b.txt"), "parte B\n");
        git(e.workspace, "add", "b.txt");
        git(e.workspace, "commit", "-q", "-m", "feat: parte B");
        marcas.push("B commitou");
      })();
      const p = await api("POST", `/tarefas/${e.tarefaId}/perguntar`, { texto: "Aplicar desconto a atacado?" });
      marcas.push("A perguntou");
      let resposta: any = null;
      while (!resposta) {
        await pausa(20);
        resposta = (await api("GET", `/tarefas/${e.tarefaId}/perguntas/${p.id}`)).resposta;
      }
      await parteB;
      writeFileSync(join(e.workspace, "a.txt"), `A com resposta: ${resposta.texto}\n`);
      git(e.workspace, "add", "a.txt");
      git(e.workspace, "commit", "-q", "-m", "feat: parte A");
      marcas.push("A terminou");
      await api("POST", `/tarefas/${e.tarefaId}/entregar`, { resumo: "A e B" });
    },
  };
  await subir(duasPartes);
  const id = await naFila(await contexto(o.url));
  await executar(id);

  await esperar(async () => (await tarefa(id)).state === "Aguardando humano");
  assert.ok((await eventos(id)).some((e) => e.tipo === "aguardar-humano-execucao" && e.para === "Aguardando humano"));
  assert.ok(!(await eventos(id)).some((e) => e.tipo === "pedir-humano"), "Execução não usa o evento da Exploração");
  assert.equal((await rodadas(id))[0].estado, "em andamento", "a Rodada não foi cancelada");
  assert.ok(marcas.includes("B commitou"), "a parte não afetada avançou");
  assert.ok(!marcas.includes("A terminou"));

  const hist = await eventos(id);
  const pergunta = hist.find((e) => e.tipo === "pergunta");
  assert.equal((await json(await req("POST", `/tarefas/${id}/comentarios`, HUMANO, { tipo: "resposta", texto: "sim, só acima de 10", respondeA: pergunta.id }))).tipo, "resposta");

  await esperarFim(id);
  const eventosFinal = await eventos(id);
  assert.ok(eventosFinal.some((e) => e.tipo === "retomar-execucao"), "retoma com retomar-execucao");
  assert.ok(!eventosFinal.some((e) => e.tipo === "retomar"));
  assert.equal((await tarefa(id)).state, "Em validação");
  assert.equal((await rodadas(id)).length, 1, "uma única Rodada do começo ao fim");
  const clone = clones().find((c) => git(c, "branch", "--list", `atm/${id}`) !== "")!;
  assert.equal(git(clone, "show", `atm/${id}:a.txt`), "A com resposta: sim, só acima de 10");
  assert.equal(git(clone, "show", `atm/${id}:b.txt`), "parte B");
});

test("modo pr: usa a função injetável, registra a URL e nunca recebe o token na URL do remoto", async () => {
  const o = origem("loja");
  const pedidos: PedidoPr[] = [];
  const criarPr: CriarPr = async (p) => {
    pedidos.push(p);
    return { url: "https://github.com/acme/loja/pull/7" };
  };
  process.env.ATM_GITHUB_TOKEN = "ghp_minimo_de_teste";
  try {
    await subir(criarExecutorFalso(roteiroFeliz), { criarPr });
    const id = await naFila(await contexto(o.url, "pr"));
    await executar(id);
    await esperarFim(id);

    assert.equal((await tarefa(id)).state, "Em validação");
    assert.equal(pedidos.length, 1);
    assert.equal(pedidos[0].branch, `atm/${id}`);
    assert.equal(pedidos[0].base, "main");
    assert.equal(pedidos[0].token, "ghp_minimo_de_teste");
    assert.equal(pedidos[0].repositorio, o.url);
    assert.ok(!pedidos[0].repositorio.includes("ghp_"));
    const ev = (await rodadas(id))[0].eventos.filter((e: any) => e.tipo === "entrega" && e.dados.modo).at(-1);
    assert.equal(ev.dados.prUrl, "https://github.com/acme/loja/pull/7");
    assert.match((await eventos(id)).find((e) => e.tipo === "entregar").motivo, /PR https:\/\/github\.com\/acme\/loja\/pull\/7/);
  } finally {
    delete process.env.ATM_GITHUB_TOKEN;
  }
});

test("modo pr sem ATM_GITHUB_TOKEN: a entrega é recusada (409) e a Tarefa não vai a Em validação", async () => {
  const o = origem("loja");
  delete process.env.ATM_GITHUB_TOKEN;
  let chamou = false;
  const resultados: number[] = [];
  const ex: Executor = {
    async executar(e) {
      const r = await fetch(`${e.ambiente.ATM_API_URL}/tarefas/${e.tarefaId}/entregar`, {
        method: "POST",
        headers: { "content-type": "application/json", ...comToken(e.ambiente.ATM_AGENT_TOKEN) },
        body: JSON.stringify({ resumo: "x" }),
      });
      resultados.push(r.status);
      await r.arrayBuffer();
    },
  };
  await subir(ex, { criarPr: async () => ((chamou = true), { url: "x" }) });
  const id = await naFila(await contexto(o.url, "pr"));
  await executar(id);
  await esperarFim(id);
  assert.deepEqual(resultados, [409]);
  assert.equal(chamou, false);
  assert.equal((await tarefa(id)).state, "Em execução");
});

test("deliveryMode inválido é recusado e o modo é herdado do Contexto pai", async () => {
  await subir(criarExecutorFalso([]));
  assert.equal((await req("POST", "/contextos", HUMANO, { name: "x", kind: "repositorio", deliveryMode: "merge" })).status, 400);
  const pai = await contexto("file:///x", "pr");
  const filho = await json(await req("POST", "/contextos", HUMANO, { name: "filho", kind: "repositorio", parentId: pai }));
  const r = await json(await req("GET", `/contextos/${filho.id}`, HUMANO));
  assert.ok(r.id);
});
