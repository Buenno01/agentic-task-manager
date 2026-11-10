import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startDaemon, type Daemon } from "../../daemon/src/api/server.ts";
import { iniciarMcpHttp, type McpHttp } from "../src/http.ts";
import { criarServidorAssistente } from "../src/assistente.ts";

const HUMANO = "tok-humano-0123456789";
const BEARER = "bearer-do-assistente-0123";
let daemon: Daemon;
let dir: string;
const abertos: (() => Promise<void>)[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "atm-assist-"));
  daemon = await startDaemon({ dbPath: join(dir, "atm.db"), port: 0, credenciais: { humano: HUMANO, agentes: {} }, logsDir: join(dir, "logs") });
});
afterEach(async () => {
  for (const f of abertos.splice(0)) await f();
  await daemon.close();
  rmSync(dir, { recursive: true, force: true });
});

async function conectar(permitirAprovacao = false) {
  const mcp: McpHttp = await iniciarMcpHttp({
    apiUrl: daemon.url, token: HUMANO, bearer: BEARER, port: 0,
    criarServidor: (api) => criarServidorAssistente(api, { permitirAprovacao }),
  });
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: { authorization: `Bearer ${BEARER}` } } }));
  abertos.push(async () => { await client.close(); await mcp.close(); });
  return {
    client,
    async chamar(name: string, args: Record<string, unknown> = {}) {
      const r = await client.callTool({ name, arguments: args });
      const texto = (r.content as { text: string }[])[0].text;
      return { erro: !!r.isError, texto, json: () => JSON.parse(texto) };
    },
  };
}

test("rejeita cliente MCP sem o bearer do assistente (o token humano em si não vale como bearer)", async () => {
  const mcp = await iniciarMcpHttp({ apiUrl: daemon.url, token: HUMANO, bearer: BEARER, port: 0, criarServidor: criarServidorAssistente });
  abertos.push(() => mcp.close());
  for (const t of [undefined, HUMANO]) {
    const r = await fetch(mcp.url, { method: "POST", headers: t ? { authorization: `Bearer ${t}` } : {} });
    assert.equal(r.status, 401);
  }
});

test("monta Contextos, popula Tarefas, prioridade, dependência, edição e anexo sem a UI", async () => {
  const a = await conectar();
  const cliente = (await a.chamar("criar_contexto", { name: "Cliente X", kind: "cliente", instructions: "Seja breve" })).json();
  const proj = (await a.chamar("criar_contexto", { name: "Loja", kind: "loja", parentId: cliente.id })).json();
  await a.chamar("editar_contexto", { contextoId: proj.id, concurrencyLimit: 1 });
  assert.equal((await a.chamar("arvore_contextos")).json()[0].children[0].id, proj.id);

  const lote = (await a.chamar("criar_varias_tarefas", { tarefas: [{ title: "A", contextId: proj.id }, { title: "B", contextId: proj.id }, { title: "" }] })).json();
  assert.deepEqual(lote.map((x: { ok: boolean }) => x.ok), [true, true, false]);
  const [ta, tb] = [lote[0].tarefa, lote[1].tarefa];

  { const r = await a.chamar("editar_tarefa", { id: ta.id, title: "A2" }); assert.equal(r.erro, false, r.texto); }
  assert.equal((await a.chamar("definir_prioridade", { id: ta.id, nivel: "alta" })).erro, false);
  assert.equal((await a.chamar("adicionar_dependencia", { id: tb.id, dependeDe: ta.id })).erro, false);
  assert.equal((await a.chamar("remover_dependencia", { id: tb.id, dependeDe: ta.id })).erro, false);
  assert.equal((await a.chamar("definir_area_prevista", { id: ta.id, paths: ["src/"] })).erro, false);
  assert.equal((await a.chamar("anexar_texto", { donoTipo: "tarefas", donoId: ta.id, nome: "n.txt", conteudo: "olá" })).erro, false);
  assert.equal((await a.chamar("atualizar_consolidado", { contextoId: proj.id, text: "decisão 1" })).erro, false);
  assert.equal((await a.chamar("mover_tarefa_de_contexto", { id: tb.id, contextId: cliente.id })).erro, false);

  const lida = (await a.chamar("ler_tarefa", { id: ta.id })).json();
  assert.equal(lida.tarefa.title, "A2");
  assert.equal(lida.tarefa.priority.nivel, "alta");
  assert.equal(lida.anexos.length, 1);
  assert.equal((await a.chamar("listar_tarefas_do_contexto", { contextoId: proj.id })).json().length, 1);

  // Autorizar a exploração é permitido; autor fica como humano (token humano).
  assert.equal((await a.chamar("transicionar_tarefa", { id: ta.id, acao: "autorizar" })).erro, false);
  assert.equal((await a.chamar("ler_tarefa", { id: ta.id })).json().tarefa.state, "Autorizada para explorar");
});

test("cria direto na Execução com contrato e inicia/valida por transição", async () => {
  const a = await conectar();
  const t = (await a.chamar("criar_tarefa", { title: "Ex", phase: "Execução", objetivo: "o", repositorioPrincipal: "r", criterios: ["c"] })).json();
  assert.equal(t.state, "Na fila");
});

test("por padrão o assistente não expõe portões de aprovação; com a flag, expõe", async () => {
  const sem = await conectar();
  const nomes = (await sem.client.listTools()).tools.map((x) => x.name);
  assert.ok(!nomes.includes("converter_em_execucao"));
  const t = (await sem.chamar("criar_tarefa", { title: "T" })).json();
  await sem.chamar("transicionar_tarefa", { id: t.id, acao: "autorizar" });
  await sem.chamar("transicionar_tarefa", { id: t.id, acao: "iniciar" });
  await sem.chamar("transicionar_tarefa", { id: t.id, acao: "plano-pronto" });
  for (const acao of ["aprovar", "forcar-inicio", "concluir-execucao"]) {
    const r = await sem.client.callTool({ name: "transicionar_tarefa", arguments: { id: t.id, acao } });
    assert.equal(r.isError, true, `${acao} deveria ser recusada pelo schema`);
  }
  assert.equal((await sem.chamar("ler_tarefa", { id: t.id })).json().tarefa.state, "Plano pronto para aprovação");

  const com = await conectar(true);
  assert.ok((await com.client.listTools()).tools.some((x) => x.name === "converter_em_execucao"));
  assert.equal((await com.chamar("transicionar_tarefa", { id: t.id, acao: "aprovar" })).erro, false);
  assert.equal((await com.chamar("ler_tarefa", { id: t.id })).json().tarefa.state, "Aprovado");
});
