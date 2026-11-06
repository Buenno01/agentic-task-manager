import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startDaemon, type Daemon } from "../src/api/server.ts";
import { carregarCredenciais } from "../src/auth/credenciais.ts";

const HUMANO = "tok-humano-segredo-123";
const AGENTE = "tok-agente-segredo-456";
const credenciais = { humano: HUMANO, agentes: { "agente-a": AGENTE } };

let daemon: Daemon;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "atm-"));
  daemon = await startDaemon({ dbPath: join(dir, "atm.db"), port: 0, credenciais });
});
afterEach(async () => {
  await daemon.close();
  rmSync(dir, { recursive: true, force: true });
});

const req = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(daemon.url + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test("token de agente é recusado (403) na rota de aprovação; o humano passa pela guarda", async () => {
  const t = await (await req("POST", "/tarefas", HUMANO, { title: "X" })).json();
  const agente = await req("POST", `/tarefas/${t.id}/aprovar`, AGENTE);
  assert.equal(agente.status, 403);
  const humano = await req("POST", `/tarefas/${t.id}/aprovar`, HUMANO);
  assert.notEqual(humano.status, 403);
  assert.notEqual(humano.status, 401);
});

test("sem token ou com token inválido a API responde 401", async () => {
  assert.equal((await req("GET", "/tarefas")).status, 401);
  assert.equal((await req("GET", "/tarefas", "errado")).status, 401);
  assert.equal((await req("GET", "/tarefas", AGENTE)).status, 200);
});

test("toda ação registra o autor (humano ou qual agente)", async () => {
  await req("POST", "/tarefas", HUMANO, { title: "A" });
  await req("POST", "/tarefas", AGENTE, { title: "B" });
  const t = await (await req("POST", "/tarefas", HUMANO, { title: "C" })).json();
  await req("POST", `/tarefas/${t.id}/aprovar`, AGENTE);
  const log = await (await req("GET", "/auditoria", HUMANO)).json();
  const resumo = log.map((l: { autor: string; metodo: string; caminho: string; status: number }) =>
    [l.autor, l.metodo, l.caminho.replace(t.id, ":id"), l.status].join(" "),
  );
  assert.deepEqual(resumo.slice(0, 4), [
    "humano POST /tarefas 201",
    "agente:agente-a POST /tarefas 201",
    "humano POST /tarefas 201",
    "agente:agente-a POST /tarefas/:id/aprovar 403",
  ]);
});

test("segredos não aparecem em texto aberto no banco", async () => {
  await req("POST", "/tarefas", AGENTE, { title: "B" });
  await daemon.close();
  const db = new DatabaseSync(join(dir, "atm.db"));
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  for (const f of readdirSync(dir)) {
    const bytes = readFileSync(join(dir, f)).toString("latin1");
    assert.ok(!bytes.includes(HUMANO) && !bytes.includes(AGENTE), `segredo em ${f}`);
  }
  daemon = await startDaemon({ dbPath: join(dir, "atm.db"), port: 0, credenciais });
});

test("credenciais vêm de variáveis de ambiente ou .env", () => {
  const env = { ATM_HUMAN_TOKEN: "h", ATM_AGENT_TOKENS: "a1:t1,a2:t2" };
  assert.deepEqual(carregarCredenciais(env, join(dir, "naoexiste.env")), {
    humano: "h",
    agentes: { a1: "t1", a2: "t2" },
  });
  const arq = join(dir, ".env");
  writeFileSync(arq, '# c\nATM_HUMAN_TOKEN="hh"\nATM_AGENT_TOKENS=x:y\n');
  assert.deepEqual(carregarCredenciais({}, arq), { humano: "hh", agentes: { x: "y" } });
  // ambiente tem precedência sobre o arquivo
  assert.equal(carregarCredenciais({ ATM_HUMAN_TOKEN: "env" }, arq)?.humano, "env");
  assert.equal(carregarCredenciais({}, join(dir, "naoexiste.env")), undefined);
});

test("o daemon não escreve tokens nos logs", async () => {
  const linhas: string[] = [];
  const orig = [console.log, console.error, console.warn];
  console.log = console.error = console.warn = (...a: unknown[]) => void linhas.push(a.join(" "));
  try {
    await req("POST", "/tarefas", AGENTE, { title: "B" });
    await req("GET", "/tarefas", "errado");
  } finally {
    [console.log, console.error, console.warn] = orig;
  }
  assert.ok(!linhas.join("\n").match(/segredo/));
});
