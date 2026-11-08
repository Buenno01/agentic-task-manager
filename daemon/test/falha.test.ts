import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/api/server.ts";
import type { EntradaRodada, Executor } from "../src/executor/executor.ts";
import { CRED, HUMANO, AGENTE, ORQUESTRADOR, comToken } from "./helpers.ts";

let daemon: Daemon | undefined;
let dir: string;
let agora: number;
const MIN = 60_000;

type Comportamento = (e: EntradaRodada) => Promise<void>;
const travada: Comportamento = (e) => new Promise((_, falha) => e.sinal.addEventListener("abort", () => falha(new Error("cancelada"))));
const falha = (msg: string): Comportamento => async () => {
  throw new Error(msg);
};

/** Executor que usa um comportamento por Rodada (o último se repete) e guarda os prompts. */
function executor(...lista: Comportamento[]) {
  const prompts: string[] = [];
  const e: Executor = {
    executar: (entrada) => {
      prompts.push(entrada.prompt);
      return lista[Math.min(prompts.length - 1, lista.length - 1)](entrada);
    },
  };
  return { executor: e, prompts };
}

async function subir(ex: Executor, extra: { temporizador?: (fn: () => void, ms: number) => () => void; matarProcesso?: (pid: number) => boolean } = {}) {
  await daemon?.close();
  daemon = await startDaemon({
    dbPath: join(dir, "atm.db"),
    port: 0,
    credenciais: CRED,
    workspacesDir: join(dir, "ws"),
    executor: ex,
    orquestrador: { aoMudarEstado: false, agendar: () => () => {}, relogio: () => agora },
    ...extra,
  });
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atm-falha-"));
  agora = 1_000_000;
});
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const req = (method: string, path: string, token: string, body?: unknown) =>
  fetch(daemon!.url + path, {
    method,
    headers: { "content-type": "application/json", ...comToken(token) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (r: Response) => (await r.json()) as any;
const acao = (id: string, a: string, body?: unknown) => req("POST", `/tarefas/${id}/${a}`, HUMANO, body);
const tarefa = async (id: string) => json(await req("GET", `/tarefas/${id}`, HUMANO));
const rodadas = async (id: string) => (await json(await req("GET", `/tarefas/${id}/rodadas`, HUMANO))) as any[];
const eventos = async (id: string) => (await json(await req("GET", `/tarefas/${id}/eventos`, HUMANO))) as any[];
const checkpoints = async (id: string) => (await json(await req("GET", `/tarefas/${id}/checkpoints`, HUMANO))) as any[];

async function esperar(cond: () => Promise<boolean>) {
  for (let i = 0; i < 300; i++) {
    if (await cond()) return;
    await new Promise((ok) => setTimeout(ok, 10));
  }
  throw new Error("Condição não atingida");
}
const terminou = (id: string, n: number) => esperar(async () => {
  const r = await rodadas(id);
  return r.length === n && r.every((x) => x.estado !== "em andamento");
});
/** Varre e espera a Rodada nº n (se criada) terminar. */
const varrerEEsperar = async (id: string, n: number) => {
  await daemon!.varrer();
  await terminou(id, n);
};

async function autorizada() {
  const id = (await json(await req("POST", "/tarefas", AGENTE, { title: "T", description: "d" }))).id as string;
  await acao(id, "autorizar");
  return id;
}
const contrato = { objetivo: "o", repositorioPrincipal: "", criterios: ["c"] };
async function naFila() {
  return (await json(await req("POST", "/tarefas", HUMANO, { title: "E", phase: "Execução", ...contrato, repositorioPrincipal: "file:///x" }))).id as string;
}

test("3 falhas seguidas levam a Aguardando humano com o motivo, com backoff de 1 e 5 min no relógio injetado", async () => {
  const { executor: ex } = executor(falha("boom 1"), falha("boom 2"), falha("boom 3"));
  await subir(ex);
  const id = await autorizada();

  await varrerEEsperar(id, 1);
  assert.equal((await tarefa(id)).state, "Explorando");
  await daemon!.varrer();
  assert.equal((await rodadas(id)).length, 1, "dentro do backoff de 1 min não abre Rodada");

  agora += 1 * MIN - 1;
  await daemon!.varrer();
  assert.equal((await rodadas(id)).length, 1, "faltando 1 ms ainda segura");
  agora += 1;
  await varrerEEsperar(id, 2);

  agora += 5 * MIN - 1;
  await daemon!.varrer();
  assert.equal((await rodadas(id)).length, 2, "2ª falha espera 5 min");
  agora += 1;
  await varrerEEsperar(id, 3);

  const t = await tarefa(id);
  assert.equal(t.state, "Aguardando humano");
  const ev = (await eventos(id)).filter((e) => e.para === "Aguardando humano").pop();
  assert.match(ev.motivo, /3 falhas seguidas.*boom 3/);
  agora += 60 * MIN;
  await daemon!.varrer();
  assert.equal((await rodadas(id)).length, 3, "depois do limite não há nova Rodada");
  assert.deepEqual((await rodadas(id)).map((r) => r.estado), ["falhou", "falhou", "falhou"]);
});

test("a retomada depois de falha parte do Checkpoint da Rodada anterior", async () => {
  const comCommit: Comportamento = async (e) => {
    e.emitir({ tipo: "segmento", dados: { modelo: "m", provedor: "p" } });
    throw new Error("caiu");
  };
  const { executor: ex, prompts } = executor(comCommit, travada);
  await subir(ex);
  const id = await autorizada();
  await varrerEEsperar(id, 1);
  assert.equal((await checkpoints(id)).length, 1);
  agora += MIN;
  await daemon!.varrer();
  await esperar(async () => prompts.length === 2);
  assert.match(prompts[1], /Retomada a partir do último Checkpoint/);
});

test("401/403 vão direto a Aguardando humano, sem retentativa", async () => {
  const { executor: ex } = executor(falha("Hermes respondeu HTTP 401 Unauthorized"), travada);
  await subir(ex);
  const id = await autorizada();
  await varrerEEsperar(id, 1);
  assert.equal((await tarefa(id)).state, "Aguardando humano");
  const ev = (await eventos(id)).filter((e) => e.para === "Aguardando humano").pop();
  assert.match(ev.motivo, /401\/403/);
  agora += 60 * MIN;
  await daemon!.varrer();
  assert.equal((await rodadas(id)).length, 1);
});

test("depois de Aguardando humano por falhas, o humano retoma e a contagem recomeça", async () => {
  const { executor: ex } = executor(falha("403 Forbidden"), travada);
  await subir(ex);
  const id = await autorizada();
  await varrerEEsperar(id, 1);
  assert.equal((await tarefa(id)).state, "Aguardando humano");
  assert.equal((await acao(id, "retomar")).status, 200);
  await daemon!.varrer();
  await esperar(async () => (await rodadas(id)).length === 2);
  assert.equal((await rodadas(id))[1].estado, "em andamento");
});

test("reinício: Rodada em andamento vira interrompida, órfãos morrem, não conta como falha e a retomada é imediata a partir do Checkpoint", async () => {
  const anuncia: Comportamento = async (e) => {
    e.emitir({ tipo: "segmento", dados: { modelo: "m", provedor: "p" } });
    e.emitir({ tipo: "processo", dados: { pid: 424242 } });
    return travada(e);
  };
  const a = executor(anuncia);
  await subir(a.executor);
  const id = await autorizada();
  await daemon!.varrer();
  await esperar(async () => (await rodadas(id)).length === 1);
  await esperar(async () => (await rodadas(id))[0].eventos.some((e: any) => e.tipo === "processo"));
  await daemon!.close();
  daemon = undefined;

  // Simula o crash: o daemon morreu sem fechar a Rodada.
  const db = new DatabaseSync(join(dir, "atm.db"));
  db.exec("UPDATE rodadas SET estado = 'em andamento', terminada_em = NULL, erro = NULL");
  db.close();

  const mortos: number[] = [];
  const b = executor(travada);
  await subir(b.executor, { matarProcesso: (pid) => (mortos.push(pid), true) });
  assert.deepEqual(mortos, [424242]);
  const [r1] = await rodadas(id);
  assert.equal(r1.estado, "interrompida");
  assert.ok((await checkpoints(id)).length >= 1);

  // Sem esperar backoff e sem contar como falha: a próxima Rodada sai na varredura seguinte.
  await daemon!.varrer();
  await esperar(async () => b.prompts.length === 1);
  assert.match(b.prompts[0], /Retomada a partir do último Checkpoint/);
  assert.equal((await rodadas(id)).length, 2);
  assert.equal((await tarefa(id)).state, "Explorando");
});

test("fechar o daemon interrompe a Rodada sem contar como falha", async () => {
  const a = executor(travada);
  await subir(a.executor);
  const id = await autorizada();
  await daemon!.varrer();
  await esperar(async () => (await rodadas(id)).length === 1);
  await daemon!.close();
  daemon = undefined;
  await subir(executor(travada).executor);
  assert.equal((await rodadas(id))[0].estado, "interrompida");
  assert.ok(!(await eventos(id)).some((e) => e.tipo === "rodada-falhou"));
});

test("pausar (Aguardando humano) cancela a Rodada com Checkpoint, preserva o Workspace e a retomada abre nova Rodada", async () => {
  const { executor: ex, prompts } = executor(travada);
  await subir(ex);
  const id = await naFila();
  await daemon!.varrer();
  await esperar(async () => (await rodadas(id)).length === 1);
  const ws = (await rodadas(id))[0].workspace as string;
  assert.ok(existsSync(ws));

  assert.equal((await acao(id, "aguardar-humano-execucao", { motivo: "pausa" })).status, 200);
  await terminou(id, 1);
  const [r] = await rodadas(id);
  assert.equal(r.estado, "cancelada");
  assert.ok(existsSync(ws), "Workspace preservado");
  assert.ok((await checkpoints(id)).some((c) => c.origem === "automático"));
  assert.ok(!(await eventos(id)).some((e) => e.tipo === "rodada-falhou"));

  await daemon!.varrer();
  assert.equal((await rodadas(id)).length, 1, "pausada: nenhuma nova Rodada");

  assert.equal((await acao(id, "retomar-execucao")).status, 200);
  await daemon!.varrer();
  await esperar(async () => prompts.length === 2);
  assert.match(prompts[1], /Retomada a partir do último Checkpoint/);
});

test("editar campo-chave cancela a Rodada e exige nova Aprovação para retomar", async () => {
  const { executor: ex, prompts } = executor(travada);
  await subir(ex);
  const id = await naFila();
  await daemon!.varrer();
  await esperar(async () => (await rodadas(id)).length === 1);

  const r = await req("PATCH", `/tarefas/${id}/execucao`, HUMANO, { criterios: ["critério novo"] });
  assert.equal(r.status, 200);
  await terminou(id, 1);
  assert.equal((await rodadas(id))[0].estado, "cancelada");
  assert.equal((await tarefa(id)).state, "Plano pronto para aprovação");

  await daemon!.varrer();
  assert.equal((await rodadas(id)).length, 1, "sem Aprovação não retoma");

  await acao(id, "aprovar");
  await acao(id, "converter-execucao", { ...contrato, repositorioPrincipal: "file:///x", criterios: ["critério novo"] });
  await daemon!.varrer();
  await esperar(async () => prompts.length === 2);
  assert.match(prompts[1], /Retomada a partir do último Checkpoint/);
});

test("editar campo não-chave e mudar prioridade não cancelam", async () => {
  const { executor: ex } = executor(travada);
  await subir(ex);
  const id = await naFila();
  await daemon!.varrer();
  await esperar(async () => (await rodadas(id)).length === 1);
  assert.equal((await req("PATCH", `/tarefas/${id}/execucao`, HUMANO, { objetivo: "outro texto" })).status, 200);
  assert.equal((await req("PUT", `/tarefas/${id}/prioridade`, HUMANO, { nivel: "baixa" })).status, 200);
  await new Promise((ok) => setTimeout(ok, 50));
  assert.equal((await rodadas(id))[0].estado, "em andamento");
});

test("rejeitar um plano entregue cancela a Rodada que ainda corria", async () => {
  const entrega: Comportamento = async (e) => {
    await fetch(`${e.ambiente.ATM_API_URL}/tarefas/${e.tarefaId}/entregar`, {
      method: "POST",
      headers: { authorization: `Bearer ${e.ambiente.ATM_AGENT_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ resumo: "plano" }),
    });
    return travada(e);
  };
  const { executor: ex } = executor(entrega);
  await subir(ex);
  const id = await autorizada();
  await daemon!.varrer();
  await esperar(async () => (await tarefa(id)).state === "Plano pronto para aprovação");
  assert.equal((await acao(id, "rejeitar", { motivo: "não" })).status, 200);
  await terminou(id, 1);
  assert.equal((await rodadas(id))[0].estado, "cancelada");
  await daemon!.varrer();
  assert.equal((await rodadas(id)).length, 1);
});

test("SIGKILL só chega 10 s depois do SIGTERM, pelo temporizador injetado", async () => {
  const agendados: { fn: () => void; ms: number }[] = [];
  let sinalTerm = false;
  const teimosa: Comportamento = (e) =>
    new Promise((_, falha) => {
      e.sinal.addEventListener("abort", () => (sinalTerm = true));
      e.sinalForcado.addEventListener("abort", () => falha(new Error("SIGKILL")));
    });
  const { executor: ex } = executor(teimosa);
  await subir(ex, { temporizador: (fn, ms) => (agendados.push({ fn, ms }), () => {}) });
  const id = await naFila();
  await daemon!.varrer();
  await esperar(async () => (await rodadas(id)).length === 1);

  await acao(id, "aguardar-humano-execucao");
  await esperar(async () => sinalTerm);
  assert.equal((await rodadas(id))[0].estado, "em andamento", "ainda não morreu");
  assert.equal(agendados.at(-1)!.ms, 10_000);
  agendados.at(-1)!.fn();
  await terminou(id, 1);
  assert.equal((await rodadas(id))[0].estado, "cancelada");
});
