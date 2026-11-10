import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/api/server.ts";
import { AGENTE, CRED, HUMANO, comToken } from "./helpers.ts";

let dir: string;
let run: string;
let daemon: Daemon | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atm-atualizacao-"));
  run = join(dir, "run");
});
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const subir = async (extra: { runDir?: string | null; versao?: string } = {}) => {
  daemon = await startDaemon({
    dbPath: join(dir, "atm.db"),
    port: 0,
    credenciais: CRED,
    runDir: extra.runDir === null ? undefined : (extra.runDir ?? run),
    versao: extra.versao,
  });
};
const chamar = (method: string, path: string, token: string | undefined = HUMANO) =>
  fetch(daemon!.url + path, { method, headers: token ? comToken(token) : {} });
const configurar = () => {
  // Fixture do host: o instalador (ticket 07) grava o marcador no mesmo diretório.
  rmSync(run, { recursive: true, force: true });
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, "configurada"), "");
};
test("sem marcador do host: estado diz indisponível, com a versão em execução", async () => {
  mkdirSync(run);
  await subir({ versao: "v1.2.0" });
  const r = await chamar("GET", "/atualizacao");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { versao: "v1.2.0", configurada: false, estado: "indisponivel", pedidoPendente: false, ultima: null });
});

test("com marcador e arquivo de estado do script: estado devolve a última atualização", async () => {
  configurar();
  const ultima = { resultado: "rollback", tag_de: "v1.1.0", tag_para: "v1.2.0", motivo: "saúde", em: "2026-11-10T10:00:00Z", versao_rodando: "v1.1.0", backup: "b.db" };
  writeFileSync(join(run, "ultima-atualizacao.json"), JSON.stringify(ultima));
  await subir({ versao: "v1.1.0" });
  const corpo = await (await chamar("GET", "/atualizacao")).json();
  assert.deepEqual(corpo, { versao: "v1.1.0", configurada: true, estado: "disponivel", pedidoPendente: false, ultima });
});

test("arquivo de estado ilegível não derruba a consulta", async () => {
  configurar();
  writeFileSync(join(run, "ultima-atualizacao.json"), "{quebrado");
  await subir();
  const corpo = await (await chamar("GET", "/atualizacao")).json();
  assert.equal(corpo.ultima, null);
  assert.equal(corpo.versao, null);
});

test("pedido do humano com atualização configurada grava o arquivo de pedido e responde aceito", async () => {
  configurar();
  await subir();
  const r = await chamar("POST", "/atualizacao/pedido");
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { aceito: true, jaPendente: false });
  assert.ok(existsSync(join(run, "pedido-atualizacao")));
  assert.equal((await (await chamar("GET", "/atualizacao")).json()).pedidoPendente, true);
  // não deixa temporários para trás (a unit .path vigia o diretório)
  assert.deepEqual(readdirSync(run).sort(), ["configurada", "pedido-atualizacao"]);
});

test("pedido repetido enquanto pendente é idempotente", async () => {
  configurar();
  await subir();
  await chamar("POST", "/atualizacao/pedido");
  const r = await chamar("POST", "/atualizacao/pedido");
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { aceito: true, jaPendente: true });
  assert.deepEqual(readdirSync(run).sort(), ["configurada", "pedido-atualizacao"]);
});

test("token de agente: 403 no pedido e na consulta, sem gravar arquivo", async () => {
  configurar();
  await subir();
  assert.equal((await chamar("POST", "/atualizacao/pedido", AGENTE)).status, 403);
  assert.equal((await chamar("GET", "/atualizacao", AGENTE)).status, 403);
  assert.ok(!existsSync(join(run, "pedido-atualizacao")));
});

test("sem credencial: 401", async () => {
  await subir();
  assert.equal((await chamar("POST", "/atualizacao/pedido", "")).status, 401);
});

test("sem marcador: pedido recusado com mensagem clara e nenhum arquivo gravado", async () => {
  mkdirSync(run);
  await subir();
  const r = await chamar("POST", "/atualizacao/pedido");
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /não está configurada/);
  assert.deepEqual(readdirSync(run), []);
});

test("sem diretório run (headless): sobe, consulta diz indisponível e o pedido é recusado", async () => {
  await subir({ runDir: null });
  const e = await (await chamar("GET", "/atualizacao")).json();
  assert.equal(e.configurada, false);
  assert.equal(e.estado, "indisponivel");
  assert.equal((await chamar("POST", "/atualizacao/pedido")).status, 409);
  await daemon!.close();
  await subir({ runDir: join(dir, "nao-existe") });
  assert.equal((await chamar("POST", "/atualizacao/pedido")).status, 409);
  assert.ok(!existsSync(join(dir, "nao-existe")));
});
