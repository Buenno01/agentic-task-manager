import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/api/server.ts";
import { destravar } from "../src/workspace/workspace.ts";
import type { EntradaRodada, Executor } from "../src/executor/executor.ts";
import { CRED, HUMANO, AGENTE, comToken } from "./helpers.ts";

let daemon: Daemon;
let dir: string;

const GH = "ghp_SEGREDO_PLANTADO_github_0123456789";
const PROVEDOR = "sk-prov-SEGREDO_PLANTADO_abcdef0123456789";
const PLANTADOS = [GH, PROVEDOR, CRED.humano, CRED.agentes.orquestrador!, CRED.agentes["agente-a"]!].filter((s) => s.length >= 8);

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

/** Executor que vaza todos os segredos conhecidos em eventos, erro e saída grande, e registra o que recebeu. */
function executorVazador(vistas: { entrada: EntradaRodada; remotes: string }[], falhar = false): Executor {
  return {
    async executar(e) {
      vistas.push({ entrada: e, remotes: git(e.workspace, "remote", "-v") });
      const todos = PLANTADOS.join(" ");
      e.emitir({ tipo: "segmento", dados: { modelo: "m", provedor: "p" } });
      e.emitir({ tipo: "comando", dados: { comando: `curl -H "Authorization: ${"B"}earer ${GH}" ${todos}`, arquivos: [] } });
      e.emitir({ tipo: "saida", dados: { texto: `inicio ${PROVEDOR}\n${"linha de log\n".repeat(2000)}fim ${GH}` } });
      if (falhar) throw new Error(`falhou com ${todos}`);
    },
  };
}

let ambienteAnterior: string | undefined;
async function subir(executor: Executor, extra: { reativo?: boolean } = {}) {
  ambienteAnterior = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = PROVEDOR;
  daemon = await startDaemon({
    dbPath: join(dir, "atm.db"),
    port: 0,
    credenciais: CRED,
    workspacesDir: join(dir, "ws"),
    reposDir: join(dir, "repos"),
    logsDir: join(dir, "logs"),
    githubToken: GH,
    executor,
    orquestrador: extra.reativo ? { aoMudarEstado: false, agendar: () => () => {} } : false,
  });
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atm-seg-"));
});
afterEach(async () => {
  await daemon?.close();
  if (ambienteAnterior === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ambienteAnterior;
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

async function esperarFim(id: string) {
  for (let i = 0; i < 300; i++) {
    const r = await rodadas(id);
    if (r.length && r.every((x) => x.estado !== "em andamento")) return r;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error("Rodada não terminou");
}
async function contexto(repository: string) {
  return (await json(await req("POST", "/contextos", HUMANO, { name: "Loja", kind: "repositorio", repository }))).id as string;
}
async function execucao(contextId: string) {
  const id = (await json(await req("POST", "/tarefas", HUMANO, { title: "Implementar X", phase: "Execução", objetivo: "o", repositorioPrincipal: "file:///x", criterios: ["c"], contextId }))).id as string;
  assert.equal((await acao(id, "iniciar-execucao")).status, 200);
  assert.equal((await acao(id, "rodadas")).status, 202);
  return id;
}
async function exploracao(contextId: string) {
  const id = (await json(await req("POST", "/tarefas", AGENTE, { title: "T", contextId }))).id as string;
  await acao(id, "autorizar");
  await daemon.varrer();
  return id;
}

/** Todos os arquivos (recursivo) sob um diretório. */
function arquivos(raiz: string): string[] {
  if (!existsSync(raiz)) return [];
  return readdirSync(raiz, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? arquivos(join(raiz, d.name)) : [join(raiz, d.name)]));
}

test("segredo plantado não aparece em eventos, logs, histórico nem nos bytes do banco", async () => {
  const o = origem("loja");
  const vistas: { entrada: EntradaRodada; remotes: string }[] = [];
  await subir(executorVazador(vistas, true));
  const id = await execucao(await contexto(o.url));
  const [rod] = await esperarFim(id);
  assert.equal(rod.estado, "falhou");

  const api = JSON.stringify([await rodadas(id), await json(await req("GET", `/tarefas/${id}/eventos`, HUMANO)), await json(await req("GET", `/tarefas/${id}`, HUMANO))]);
  const logs = arquivos(join(dir, "logs")).map((f) => readFileSync(f, "utf8")).join("\n");
  await daemon.close(); // checkpoint do WAL no arquivo principal
  daemon = undefined as unknown as Daemon;
  const banco = ["atm.db", "atm.db-wal"].filter((f) => existsSync(join(dir, f))).map((f) => readFileSync(join(dir, f)).toString("latin1")).join("\n");
  for (const s of PLANTADOS) {
    assert.ok(!api.includes(s), `API contém ${s.slice(0, 8)}…`);
    assert.ok(!logs.includes(s), `logs contêm ${s.slice(0, 8)}…`);
    assert.ok(!banco.includes(s), `banco contém ${s.slice(0, 8)}…`);
    assert.ok(!banco.includes(Buffer.from(s).toString("base64")));
  }
  assert.match(api, /\[mascarado\]/);
  assert.match(logs, /\[mascarado\]/);
});

test("saída grande vai para <logsDir>/<rodada>/ e o evento guarda só caminho e resumo", async () => {
  const o = origem("loja");
  await subir(executorVazador([]));
  const id = await execucao(await contexto(o.url));
  const [rod] = await esperarFim(id);

  const ev = rod.eventos.find((e: any) => e.tipo === "saida");
  assert.ok(ev.dados.logs?.length === 1, "evento referencia o arquivo");
  const { caminho, bytes } = ev.dados.logs[0];
  assert.ok(caminho.startsWith(join(dir, "logs", rod.id)), "arquivo sob <logsDir>/<rodada>/");
  const conteudo = readFileSync(caminho, "utf8");
  assert.equal(Buffer.byteLength(conteudo), bytes);
  assert.ok(conteudo.startsWith("inicio [mascarado]") && conteudo.endsWith("fim [mascarado]"));
  assert.ok(ev.dados.texto.length < 400, "o evento guarda só um resumo");
  assert.ok(existsSync(join(dir, "logs", rod.id, "eventos.log")), "trilha completa da Rodada existe");
});

test("Execução: GIT_ASKPASS entrega o token; remote do Workspace sem token; ambiente sem token humano", async () => {
  const o = origem("loja");
  const vistas: { entrada: EntradaRodada; remotes: string }[] = [];
  await subir(executorVazador(vistas));
  const id = await execucao(await contexto(o.url));
  const [rod] = await esperarFim(id);

  const { entrada, remotes } = vistas[0];
  assert.equal(entrada.tipo, "Execução");
  assert.ok(entrada.ambiente.GIT_ASKPASS && entrada.ambiente.ATM_GIT_TOKEN === GH);
  assert.ok(!remotes.includes(GH), "git remote -v sem token");
  assert.ok(!git(entrada.workspace, "config", "--get-regexp", "^remote\\.").includes(GH));
  assert.ok(!readFileSync(join(entrada.workspace, ".git")).toString().includes(GH));
  const valores = Object.values(entrada.ambiente);
  assert.ok(!valores.includes(HUMANO), "sem token humano");
  assert.equal(entrada.ambiente.ATM_AGENT_TOKEN, CRED.agentes.orquestrador);
  assert.deepEqual(Object.keys(entrada.ambiente).sort(), ["ATM_AGENT_TOKEN", "ATM_API_URL", "ATM_GIT_TOKEN", "ATM_MCP_URL", "GIT_ASKPASS", "GIT_TERMINAL_PROMPT"]);
  assert.ok(!existsSync(entrada.ambiente.GIT_ASKPASS!), "script de askpass removido ao fim da Rodada");
  assert.equal(rod.estado, "concluída");
});

test("Exploração não recebe o token do GitHub nem o humano", async () => {
  const o = origem("loja");
  const vistas: { entrada: EntradaRodada; remotes: string }[] = [];
  await subir(executorVazador(vistas), { reativo: true });
  const id = await exploracao(await contexto(o.url));
  await esperarFim(id);

  const { entrada, remotes } = vistas[0];
  assert.equal(entrada.tipo, "Exploração");
  assert.deepEqual(Object.keys(entrada.ambiente).sort(), ["ATM_AGENT_TOKEN", "ATM_API_URL", "ATM_MCP_URL"]);
  assert.ok(!JSON.stringify(entrada.ambiente).includes(GH));
  assert.ok(!JSON.stringify(entrada.ambiente).includes(HUMANO));
  assert.ok(!remotes.includes(GH));
});
