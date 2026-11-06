import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/api/server.ts";
import { abrirBanco } from "../src/db/index.ts";
import { abrirComentarios } from "../src/db/comentarios.ts";
import { novaTarefa } from "../src/domain/tarefa.ts";

const HUMANO = "tok-humano";
const AGENTE = "tok-agente";
const CRED = { humano: HUMANO, agentes: { "agente-a": AGENTE } };
let daemon: Daemon;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "atm-busca-"));
  daemon = await startDaemon({ dbPath: join(dir, "atm.db"), port: 0, anexosDir: join(dir, "anexos"), credenciais: CRED });
});
afterEach(async () => {
  await daemon.close();
  rmSync(dir, { recursive: true, force: true });
});

const req = (method: string, path: string, token: string | null, body?: unknown, tipo = "application/json") =>
  fetch(daemon.url + path, {
    method,
    headers: { "content-type": tipo, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
const json = async (method: string, path: string, body?: unknown, token = HUMANO) =>
  (await req(method, path, token, body)).json() as Promise<any>;
const contexto = async (name: string, parentId: string | null = null) =>
  (await json("POST", "/contextos", { name, kind: "projeto", parentId })).id as string;
const tarefa = async (title: string, contextId: string | null = null, description = "") =>
  (await json("POST", "/tarefas", { title, description, contextId })).id as string;
const busca = (q: string, extra = "") => json("GET", `/busca?q=${encodeURIComponent(q)}${extra}`);
const tipos = (rs: any[]) => rs.map((r) => r.tipo).sort();

test("exige autenticação e a consulta", async () => {
  assert.equal((await req("GET", "/busca?q=x", null)).status, 401);
  assert.equal((await req("GET", "/busca?q=x", "errado")).status, 401);
  assert.equal((await req("GET", "/busca", HUMANO)).status, 400);
  assert.equal((await req("GET", "/busca?q=%20%20", HUMANO)).status, 400);
  assert.equal((await req("GET", "/busca?q=x", AGENTE)).status, 200);
});

test("encontra Tarefa por título ou descrição, com snippet e ids", async () => {
  const c = await contexto("Loja");
  const t = await tarefa("Migrar checkout", c, "usar gateway Stripe no pagamento");
  await tarefa("Outra coisa");
  const porTitulo = await busca("checkout");
  assert.equal(porTitulo.length, 1);
  assert.equal(porTitulo[0].tipo, "tarefa");
  assert.equal(porTitulo[0].id, t);
  assert.equal(porTitulo[0].taskId, t);
  assert.equal(porTitulo[0].contextId, c);
  assert.match(porTitulo[0].snippet, /\[checkout\]/);
  const porDescricao = await busca("stripe");
  assert.deepEqual(porDescricao.map((r: any) => r.id), [t]);
});

test("encontra comentários, apontando a Tarefa e o Contexto", async () => {
  const c = await contexto("Loja");
  const t = await tarefa("Qualquer", c);
  const com = await json("POST", `/tarefas/${t}/comentarios`, { texto: "O webhook falha em produção" }, AGENTE);
  const rs = await busca("webhook");
  assert.equal(rs.length, 1);
  assert.equal(rs[0].tipo, "comentario");
  assert.equal(rs[0].id, com.id);
  assert.equal(rs[0].taskId, t);
  assert.equal(rs[0].contextId, c);
  assert.match(rs[0].snippet, /\[webhook\]/);
});

test("encontra Contexto consolidado (qualquer versão) e anexos", async () => {
  const c = await contexto("Loja");
  const t = await tarefa("Qualquer", c);
  await json("PUT", `/contextos/${c}/consolidado`, { text: "Regra: nunca fazer deploy na sexta" });
  await json("PUT", `/contextos/${c}/consolidado`, { text: "Regra: usar Tailwind" });
  const cons = await busca("deploy");
  assert.equal(cons.length, 1);
  assert.equal(cons[0].tipo, "consolidado");
  assert.equal(cons[0].contextId, c);
  assert.equal(cons[0].version, 1);
  assert.equal(cons[0].taskId, null);
  assert.match(cons[0].snippet, /\[deploy\]/);

  const up = await req("POST", `/tarefas/${t}/anexos?nome=notas.txt`, HUMANO, "reunião sobre a migração do inventário", "text/plain");
  const anexo = await up.json();
  const rs = await busca("inventario");
  assert.equal(rs.length, 1);
  assert.equal(rs[0].tipo, "anexo");
  assert.equal(rs[0].id, anexo.id);
  assert.equal(rs[0].taskId, t);
  assert.equal(rs[0].contextId, c);
  assert.match(rs[0].snippet, /\[inventário\]/);

  const upCtx = await (await req("POST", `/contextos/${c}/anexos?nome=guia.txt`, HUMANO, "guia de onboarding", "text/plain")).json();
  const rc = await busca("onboarding");
  assert.equal(rc[0].id, upCtx.id);
  assert.equal(rc[0].taskId, null);
  assert.equal(rc[0].contextId, c);
});

test("retorna os quatro tipos numa única busca", async () => {
  const c = await contexto("Loja");
  const t = await tarefa("Revisar frete", c);
  await json("POST", `/tarefas/${t}/comentarios`, { texto: "frete grátis acima de 200" });
  await json("PUT", `/contextos/${c}/consolidado`, { text: "Frete é calculado pelos Correios" });
  await req("POST", `/tarefas/${t}/anexos?nome=f.txt`, HUMANO, "tabela de frete", "text/plain");
  assert.deepEqual(tipos(await busca("frete")), ["anexo", "comentario", "consolidado", "tarefa"]);
});

test("ignora acentos e caixa, nos dois sentidos", async () => {
  const t = await tarefa("Configuração do Câmbio");
  assert.deepEqual((await busca("configuracao cambio")).map((r: any) => r.id), [t]);
  assert.deepEqual((await busca("CONFIGURAÇÃO")).map((r: any) => r.id), [t]);
  const t2 = await tarefa("cafe com acucar");
  assert.deepEqual((await busca("café")).map((r: any) => r.id), [t2]);
});

test("consulta com sintaxe FTS vira texto literal, sem erro", async () => {
  const t = await tarefa("alpha beta");
  for (const q of ['"', "alpha OR", "alpha*", "NEAR(", "title:alpha", "a AND (b", "'; DROP TABLE tarefas; --", "***"]) {
    const res = await req("GET", `/busca?q=${encodeURIComponent(q)}`, HUMANO);
    assert.ok(res.status === 200 || res.status === 400, `${q} -> ${res.status}`);
  }
  assert.deepEqual((await busca("alpha OR")).map((r: any) => r.id), []); // AND literal: "or" não existe
  assert.deepEqual((await busca("alpha beta")).map((r: any) => r.id), [t]);
  assert.equal((await req("GET", `/busca?q=${encodeURIComponent("***")}`, HUMANO)).status, 400);
});

test("filtra por Contexto; sem subarvore exclui descendentes, com subarvore=1 inclui", async () => {
  const pai = await contexto("Pai");
  const filho = await contexto("Filho", pai);
  const outro = await contexto("Outro");
  const tPai = await tarefa("pagamento no pai", pai);
  const tFilho = await tarefa("pagamento no filho", filho);
  const tOutro = await tarefa("pagamento em outro", outro);
  const tSolta = await tarefa("pagamento sem contexto");
  const ids = (rs: any[]) => rs.map((r) => r.id).sort();

  assert.deepEqual(ids(await busca("pagamento")), [tPai, tFilho, tOutro, tSolta].sort());
  assert.deepEqual(ids(await busca("pagamento", `&contexto=${pai}`)), [tPai]);
  assert.deepEqual(ids(await busca("pagamento", `&contexto=${pai}&subarvore=1`)), [tPai, tFilho].sort());
  assert.deepEqual(ids(await busca("pagamento", `&contexto=${filho}&subarvore=1`)), [tFilho]);
  assert.equal((await req("GET", `/busca?q=x&contexto=nao-existe`, HUMANO)).status, 400);
  assert.ok(tOutro);
});

test("o filtro de Contexto vale para comentários, consolidado e anexos", async () => {
  const a = await contexto("A");
  const b = await contexto("B");
  const ta = await tarefa("ta", a);
  const tb = await tarefa("tb", b);
  await json("POST", `/tarefas/${ta}/comentarios`, { texto: "migração urgente" });
  await json("POST", `/tarefas/${tb}/comentarios`, { texto: "migração tranquila" });
  await json("PUT", `/contextos/${a}/consolidado`, { text: "migração decidida" });
  await req("POST", `/tarefas/${tb}/anexos?nome=m.txt`, HUMANO, "plano de migração", "text/plain");
  assert.equal((await busca("migracao")).length, 4);
  assert.deepEqual(tipos(await busca("migracao", `&contexto=${a}`)), ["comentario", "consolidado"]);
  assert.deepEqual(tipos(await busca("migracao", `&contexto=${b}`)), ["anexo", "comentario"]);
});

test("índice acompanha mudanças: Tarefa movida de Contexto e persiste após reiniciar", async () => {
  const a = await contexto("A");
  const b = await contexto("B");
  const t = await tarefa("relatório mensal", a);
  await req("PUT", `/tarefas/${t}/contexto`, HUMANO, { contextId: b });
  assert.deepEqual((await busca("relatorio", `&contexto=${a}`)), []);
  assert.equal((await busca("relatorio", `&contexto=${b}`)).length, 1);
  await daemon.close();
  daemon = await startDaemon({ dbPath: join(dir, "atm.db"), port: 0, anexosDir: join(dir, "anexos"), credenciais: CRED });
  assert.equal((await busca("relatorio")).length, 1);
});

test("dados criados antes da busca existir são indexados ao subir o daemon", async () => {
  await daemon.close();
  const caminho = join(dir, "legado.db");
  const repo = abrirBanco(caminho);
  const t = novaTarefa({ title: "Tarefa legada de inventário" });
  repo.inserirTarefa(t);
  repo.close();
  const com = abrirComentarios(caminho);
  const c = com.inserir({ tarefaId: t.id, autor: "humano", tipo: "comentario", texto: "comentário legado sobre auditoria" });
  com.close();
  daemon = await startDaemon({ dbPath: caminho, port: 0, anexosDir: join(dir, "anexos"), credenciais: CRED });
  assert.deepEqual((await busca("inventario")).map((r: any) => r.id), [t.id]);
  assert.deepEqual((await busca("auditoria")).map((r: any) => r.id), [c.id]);
});
