import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/api/server.ts";
import { abrirAnexos } from "../src/db/anexos.ts";
import { docx, pdf } from "./fixtures.ts";

let daemon: Daemon;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "atm-anx-"));
  daemon = await startDaemon({
    dbPath: join(dir, "atm.db"),
    port: 0,
    anexosDir: join(dir, "anexos"),
    anexoMaxBytes: 1000,
  });
});
afterEach(async () => {
  await daemon.close();
  rmSync(dir, { recursive: true, force: true });
});

const json = (method: string, path: string, body?: unknown) =>
  fetch(daemon.url + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const subir = (base: string, nome: string, dados: Buffer | string, tipo = "application/octet-stream") =>
  fetch(`${daemon.url}${base}/anexos?nome=${encodeURIComponent(nome)}`, {
    method: "POST",
    headers: { "content-type": tipo },
    body: typeof dados === "string" ? dados : new Uint8Array(dados),
  });
const tarefa = async () => (await (await json("POST", "/tarefas", { title: "T" })).json()).id as string;
const contexto = async () =>
  (await (await json("POST", "/contextos", { name: "C", kind: "cliente" })).json()).id as string;

test("anexa a uma Tarefa e baixa os mesmos bytes", async () => {
  const id = await tarefa();
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
  const res = await subir(`/tarefas/${id}`, "foto.png", bytes, "image/png");
  assert.equal(res.status, 201);
  const meta = await res.json();
  assert.equal(meta.name, "foto.png");
  assert.equal(meta.size, 8);
  assert.equal(meta.mimeType, "image/png");
  assert.equal(meta.hasText, false);

  const down = await fetch(`${daemon.url}/anexos/${meta.id}`);
  assert.equal(down.status, 200);
  assert.equal(down.headers.get("content-type"), "image/png");
  assert.match(down.headers.get("content-disposition")!, /attachment/);
  assert.deepEqual(Buffer.from(await down.arrayBuffer()), bytes);

  const lista = await (await json("GET", `/tarefas/${id}/anexos`)).json();
  assert.deepEqual(lista.map((a: { id: string }) => a.id), [meta.id]);
});

test("anexa a um Contexto; listas são independentes por dono", async () => {
  const c = await contexto();
  const t = await tarefa();
  assert.equal((await subir(`/contextos/${c}`, "briefing.txt", "olá")).status, 201);
  assert.equal((await json("GET", `/contextos/${c}/anexos`).then((r) => r.json())).length, 1);
  assert.equal((await json("GET", `/tarefas/${t}/anexos`).then((r) => r.json())).length, 0);
});

test("dono inexistente: 404; sem nome: 400", async () => {
  assert.equal((await subir("/tarefas/nao-existe", "a.txt", "x")).status, 404);
  assert.equal((await subir("/contextos/nao-existe", "a.txt", "x")).status, 404);
  const id = await tarefa();
  const res = await fetch(`${daemon.url}/tarefas/${id}/anexos`, { method: "POST", body: "x" });
  assert.equal(res.status, 400);
  assert.equal((await json("GET", "/anexos/nao-existe")).status, 404);
});

test("limite de tamanho: 413 e nada fica salvo", async () => {
  const id = await tarefa();
  const res = await subir(`/tarefas/${id}`, "grande.bin", Buffer.alloc(1001));
  assert.equal(res.status, 413);
  assert.equal((await json("GET", `/tarefas/${id}/anexos`).then((r) => r.json())).length, 0);
  const pasta = join(dir, "anexos");
  assert.deepEqual(existsSync(pasta) ? readdirSync(pasta) : [], []);
});

test("nome de arquivo é sanitizado e o arquivo fica sob id gerado", async () => {
  const id = await tarefa();
  const meta = await (await subir(`/tarefas/${id}`, "../../etc/passwd", "x")).json();
  assert.equal(meta.name, "passwd");
  const meta2 = await (await subir(`/tarefas/${id}`, "..\\..\\segredo.txt", "x")).json();
  assert.equal(meta2.name, "segredo.txt");
  const pasta = join(dir, "anexos");
  const arquivos = readdirSync(pasta);
  assert.equal(arquivos.length, 2);
  assert.ok(arquivos.includes(meta.id) && arquivos.includes(meta2.id));
  assert.ok(!existsSync(join(dir, "etc")));
  const down = await fetch(`${daemon.url}/anexos/${meta.id}`);
  assert.doesNotMatch(down.headers.get("content-disposition")!, /\.\.|\//);
});

test("texto de PDF, docx e txt é extraído; imagem e planilha não", async () => {
  const id = await tarefa();
  const base = `/tarefas/${id}`;
  const p = await (await subir(base, "r.pdf", pdf(["Relatório de vendas"]))).json();
  const d = await (await subir(base, "s.docx", docx(["Cláusula de rescisão"]))).json();
  const t = await (await subir(base, "n.md", "# anotações")).json();
  const i = await (await subir(base, "f.jpg", Buffer.from([0xff, 0xd8]))).json();
  const x = await (await subir(base, "p.xlsx", Buffer.from("PK"))).json();
  assert.deepEqual([p, d, t, i, x].map((a) => a.hasText), [true, true, true, false, false]);

  const texto = await (await fetch(`${daemon.url}/anexos/${p.id}/texto`)).json();
  assert.match(texto.text, /Relatório de vendas/);
  assert.equal((await fetch(`${daemon.url}/anexos/${i.id}/texto`)).status, 404);
});

test("texto extraído fica indexado e pesquisável (insumo do ticket 13)", async () => {
  const id = await tarefa();
  const c = await contexto();
  const p = await (await subir(`/tarefas/${id}`, "r.pdf", pdf(["Relatório de vendas"]))).json();
  await (await subir(`/contextos/${c}`, "n.txt", "lista de preços")).json();
  const anexos = abrirAnexos(join(dir, "atm.db"), join(dir, "anexos"));
  try {
    assert.equal(anexos.temFts(), true); // node:sqlite tem FTS5
    const achados = anexos.buscar("vendas");
    assert.deepEqual(achados.map((a) => [a.id, a.ownerType, a.ownerId]), [[p.id, "tarefa", id]]);
    assert.equal(anexos.buscar("preços")[0].ownerType, "contexto");
    assert.equal(anexos.buscar("inexistente").length, 0);
    assert.equal(anexos.buscar('"').length, 0); // consulta inválida não lança
  } finally {
    anexos.close();
  }
});
