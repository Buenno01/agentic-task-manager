import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/api/server.ts";
import { criarExecutorFalso, type Roteiro } from "../src/executor/falso.ts";
import { CRED, HUMANO, AGENTE, ORQUESTRADOR, comToken } from "./helpers.ts";

let daemon: Daemon;
let dir: string;

/** Sobe o daemon real com o Executor falso movido por `roteiro`. */
async function subir(roteiro: Roteiro) {
  daemon = await startDaemon({
    dbPath: join(dir, "atm.db"),
    port: 0,
    credenciais: CRED,
    workspacesDir: join(dir, "ws"),
    executor: criarExecutorFalso(roteiro),
  });
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atm-rod-"));
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

async function explorando() {
  const id = (await json(await req("POST", "/tarefas", AGENTE, { title: "T" }))).id as string;
  await acao(id, "autorizar");
  await acao(id, "iniciar", AGENTE);
  return id;
}
const rodadas = async (id: string) => (await json(await req("GET", `/tarefas/${id}/rodadas`, HUMANO))) as any[];
async function esperarFim(id: string) {
  for (let i = 0; i < 200; i++) {
    const r = await rodadas(id);
    if (r.length && r.every((x) => x.estado !== "em andamento")) return r;
    await new Promise((ok) => setTimeout(ok, 25));
  }
  throw new Error("Rodada não terminou");
}

test("Rodada com o falso grava Rodada, Segmento e eventos, visíveis pela API e no histórico", async () => {
  await subir([
    { passo: "lendo o repositório" },
    { segmento: { modelo: "modelo-a", provedor: "prov" } },
    { commit: { arquivo: "a.txt", conteudo: "oi", mensagem: "feat: a" } },
    { tokens: { entrada: 100, saida: 20, chamadas: 2 } },
    { pergunta: "Qual o escopo?" },
    { entrega: "plano pronto" },
  ]);
  const id = await explorando();
  const r = await req("POST", `/tarefas/${id}/rodadas`, HUMANO);
  assert.equal(r.status, 202);
  const [rod] = await esperarFim(id);
  assert.equal(rod.estado, "concluída");
  assert.equal(rod.tipo, "Exploração");
  assert.equal(rod.segmentos.length, 1);
  assert.deepEqual(
    { m: rod.segmentos[0].modelo, p: rod.segmentos[0].provedor, e: rod.segmentos[0].tokensEntrada, s: rod.segmentos[0].tokensSaida, c: rod.segmentos[0].chamadas },
    { m: "modelo-a", p: "prov", e: 100, s: 20, c: 2 },
  );
  const tipos = rod.eventos.map((e: any) => e.tipo);
  for (const t of ["passo", "comando", "tokens", "pergunta", "entrega"]) assert.ok(tipos.includes(t), t);
  assert.ok(existsSync(join(rod.workspace, "a.txt")), "commit no worktree");

  // Rodada individual pela API.
  const um = await json(await req("GET", `/rodadas/${rod.id}`, HUMANO));
  assert.equal(um.id, rod.id);

  // Chamadas à API com o token do orquestrador: pergunta virou comentário e entrega mudou o estado.
  const hist = await json(await req("GET", `/tarefas/${id}/eventos`, HUMANO));
  const pergunta = hist.find((e: any) => e.tipo === "pergunta");
  assert.equal(pergunta.autor, "agente:orquestrador");
  assert.equal(pergunta.texto, "Qual o escopo?");
  const tipoHist = hist.map((e: any) => e.tipo);
  assert.ok(tipoHist.includes("rodada-iniciada"));
  assert.ok(tipoHist.includes("rodada-concluida"));
  assert.ok(tipoHist.includes("entregar"));
});

test("roteiro do falso chama a API real com o token de agente; aprovar é recusado (403)", async () => {
  await subir([
    { api: { metodo: "POST", caminho: "/tarefas/{tarefa}/aprovar" } },
    { api: { metodo: "POST", caminho: "/tarefas/{tarefa}/autorizar" } },
    { api: { metodo: "GET", caminho: "/tarefas/{tarefa}" } },
  ]);
  const id = await explorando();
  await req("POST", `/tarefas/${id}/rodadas`, HUMANO);
  const [rod] = await esperarFim(id);
  const chamadas = rod.eventos.filter((e: any) => e.tipo === "api").map((e: any) => e.dados.status);
  assert.deepEqual(chamadas, [403, 403, 200]);
  assert.equal((await json(await req("GET", `/tarefas/${id}`, HUMANO))).state, "Explorando");
  const aud = await json(await req("GET", "/auditoria", HUMANO));
  assert.ok(aud.some((a: any) => a.autor === "agente:orquestrador" && a.caminho.endsWith("/aprovar") && a.status === 403));
});

test("falha e morte de processo ficam registradas; só o humano dispara Rodadas", async () => {
  await subir([{ passo: "x" }, { falha: "deu ruim" }]);
  const id = await explorando();
  assert.equal((await req("POST", `/tarefas/${id}/rodadas`, AGENTE)).status, 403);
  assert.equal((await req("POST", `/tarefas/${id}/rodadas`, ORQUESTRADOR)).status, 403);
  assert.equal((await req("POST", `/tarefas/nao-existe/rodadas`, HUMANO)).status, 404);
  await req("POST", `/tarefas/${id}/rodadas`, HUMANO);
  const [rod] = await esperarFim(id);
  assert.equal(rod.estado, "falhou");
  assert.match(rod.erro, /deu ruim/);
  await daemon.close();

  await subir([{ passo: "x" }, { morrer: true }, { passo: "nunca" }]);
  const id2 = await explorando();
  await req("POST", `/tarefas/${id2}/rodadas`, HUMANO);
  const [rod2] = await esperarFim(id2);
  assert.equal(rod2.estado, "falhou");
  assert.match(rod2.erro, /processo/i);
  assert.ok(!rod2.eventos.some((e: any) => e.tipo === "passo" && e.dados.texto === "nunca"));
});

test("checkpoint, perguntar e entregar: agente repassa pela API, sem poder de aprovar", async () => {
  await subir([]);
  const id = await explorando();
  // Sem Rodada em andamento, checkpoint é recusado.
  assert.equal((await req("POST", `/tarefas/${id}/checkpoint`, ORQUESTRADOR, { progresso: "p" })).status, 409);
  await daemon.close();

  await subir([
    { api: { metodo: "POST", caminho: "/tarefas/{tarefa}/checkpoint", corpo: { progresso: "metade", decisoes: ["d1"], arquivosTocados: ["a.ts"], proximosPassos: ["testar"] } } },
    { api: { metodo: "POST", caminho: "/tarefas/{tarefa}/checkpoint", corpo: { decisoes: "errado" } } },
    { api: { metodo: "POST", caminho: "/tarefas/{tarefa}/perguntar", corpo: { texto: "Posso?" } } },
  ]);
  const id2 = await explorando();
  await req("POST", `/tarefas/${id2}/rodadas`, HUMANO);
  const [rod] = await esperarFim(id2);
  assert.deepEqual(rod.eventos.filter((e: any) => e.tipo === "api").map((e: any) => e.dados.status), [201, 400, 201]);
  const cp = rod.eventos.find((e: any) => e.tipo === "checkpoint");
  assert.deepEqual(cp.dados, { progresso: "metade", decisoes: ["d1"], arquivosTocados: ["a.ts"], proximosPassos: ["testar"] });
  assert.equal((await json(await req("GET", `/tarefas/${id2}`, HUMANO))).state, "Aguardando humano");
});

test("entregar leva a Exploração a 'Plano pronto para aprovação'; fora de Explorando é 409; agente continua sem aprovar", async () => {
  await subir([]);
  const id = await explorando();
  assert.equal((await req("POST", `/tarefas/${id}/entregar`, ORQUESTRADOR, { resumo: "ok" })).status, 200);
  assert.equal((await json(await req("GET", `/tarefas/${id}`, HUMANO))).state, "Plano pronto para aprovação");
  assert.equal((await req("POST", `/tarefas/${id}/entregar`, ORQUESTRADOR, { resumo: "ok" })).status, 409);
  assert.equal((await acao(id, "aprovar", ORQUESTRADOR)).status, 403);
  assert.equal((await req("POST", `/tarefas/${id}/entregar`, ORQUESTRADOR, {})).status, 409);
});
