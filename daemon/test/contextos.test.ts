import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/api/server.ts";

let daemon: Daemon;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "atm-ctx-"));
  daemon = await startDaemon({ dbPath: join(dir, "atm.db"), port: 0 });
});
afterEach(async () => {
  await daemon.close();
  rmSync(dir, { recursive: true, force: true });
});

const send = (method: string, path: string, body?: unknown) =>
  fetch(daemon.url + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const criar = async (body: Record<string, unknown>) => {
  const res = await send("POST", "/contextos", body);
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  return res.json();
};
const resolvido = async (id: string) => (await send("GET", `/contextos/${id}/resolvido`)).json();

test("cria Contexto raiz e filho, navegáveis pela árvore", async () => {
  const cliente = await criar({ name: "Vinícolas Sul", kind: "cliente" });
  const loja = await criar({ name: "Loja Wine", kind: "loja", parentId: cliente.id });
  const repo = await criar({ name: "tema", kind: "repositorio", parentId: loja.id });
  assert.equal(repo.parentId, loja.id);
  assert.equal(cliente.parentId, null);

  const arvore = await (await send("GET", "/contextos/arvore")).json();
  assert.equal(arvore.length, 1);
  assert.equal(arvore[0].name, "Vinícolas Sul");
  assert.equal(arvore[0].children[0].name, "Loja Wine");
  assert.equal(arvore[0].children[0].children[0].name, "tema");

  const lista = await (await send("GET", "/contextos")).json();
  assert.equal(lista.length, 3);
  assert.equal((await (await send("GET", `/contextos/${loja.id}`)).json()).name, "Loja Wine");
});

test("valida nome, tipo e pai", async () => {
  assert.equal((await send("POST", "/contextos", { name: " ", kind: "cliente" })).status, 400);
  assert.equal((await send("POST", "/contextos", { name: "x", kind: "galáxia" })).status, 400);
  assert.equal((await send("POST", "/contextos", { name: "x", kind: "loja", parentId: "nao-existe" })).status, 400);
  assert.equal((await send("GET", "/contextos/nao-existe")).status, 404);
});

test("metadados: repositório, comandos de teste e limite de concorrência", async () => {
  const c = await criar({
    name: "tema",
    kind: "repositorio",
    repository: "git@github.com:acme/tema.git",
    testCommands: ["npm test", "npm run lint"],
    concurrencyLimit: 2,
    instructions: "Usar Tailwind",
  });
  assert.equal(c.repository, "git@github.com:acme/tema.git");
  assert.deepEqual(c.testCommands, ["npm test", "npm run lint"]);
  assert.equal(c.concurrencyLimit, 2);
  const up = await (await send("PATCH", `/contextos/${c.id}`, { concurrencyLimit: 4 })).json();
  assert.equal(up.concurrencyLimit, 4);
  assert.equal(up.repository, "git@github.com:acme/tema.git");
  assert.equal((await send("PATCH", `/contextos/${c.id}`, { concurrencyLimit: 0 })).status, 400);
  assert.equal((await send("PATCH", `/contextos/${c.id}`, { testCommands: "npm test" })).status, 400);
});

test("configuração estruturada: filho sobrescreve, ausente herda", async () => {
  const cliente = await criar({
    name: "Cliente",
    kind: "cliente",
    repository: "repo-cliente",
    testCommands: ["make test"],
    concurrencyLimit: 3,
  });
  const projeto = await criar({ name: "Projeto", kind: "projeto", parentId: cliente.id, concurrencyLimit: 1 });
  const repo = await criar({
    name: "Repo",
    kind: "repositorio",
    parentId: projeto.id,
    repository: "repo-filho",
  });
  const r = await resolvido(repo.id);
  assert.equal(r.repository, "repo-filho"); // sobrescrito pelo filho
  assert.equal(r.concurrencyLimit, 1); // herdado do projeto (que sobrescreveu o cliente)
  assert.deepEqual(r.testCommands, ["make test"]); // herdado do cliente
  assert.equal((await resolvido(cliente.id)).concurrencyLimit, 3);
});

test("instruções em texto se somam do geral ao específico", async () => {
  const cliente = await criar({ name: "Cliente", kind: "cliente", instructions: "Responder em português." });
  const loja = await criar({ name: "Loja", kind: "loja", parentId: cliente.id });
  const amb = await criar({
    name: "Produção",
    kind: "ambiente",
    parentId: loja.id,
    instructions: "Responder em inglês.",
  });
  const r = await resolvido(amb.id);
  assert.deepEqual(
    r.instructions.map((i: { contextId: string; text: string }) => [i.contextId, i.text]),
    [
      [cliente.id, "Responder em português."],
      [amb.id, "Responder em inglês."],
    ],
  );
  // o mais específico vem por último e vence em conflito
  assert.equal(r.instructions.at(-1).text, "Responder em inglês.");
  assert.equal(r.instructionsText, "Responder em português.\n\nResponder em inglês.");
  assert.deepEqual(r.path.map((p: { name: string }) => p.name), ["Cliente", "Loja", "Produção"]);
});

test("Tarefa associável a qualquer nível, na criação ou depois", async () => {
  const cliente = await criar({ name: "Cliente", kind: "cliente" });
  const loja = await criar({ name: "Loja", kind: "loja", parentId: cliente.id });

  const t1 = await (await send("POST", "/tarefas", { title: "No cliente", contextId: cliente.id })).json();
  assert.equal(t1.contextId, cliente.id);
  const t2 = await (await send("POST", "/tarefas", { title: "Solta" })).json();
  assert.equal(t2.contextId, null);
  const mov = await send("PUT", `/tarefas/${t2.id}/contexto`, { contextId: loja.id });
  assert.equal((await mov.json()).contextId, loja.id);

  const lista = await (await send("GET", "/tarefas")).json();
  assert.deepEqual(
    Object.fromEntries(lista.map((t: { title: string; contextId: string | null }) => [t.title, t.contextId])),
    { "No cliente": cliente.id, Solta: loja.id },
  );
  const doCliente = await (await send("GET", `/contextos/${cliente.id}/tarefas`)).json();
  assert.deepEqual(doCliente.map((t: { title: string }) => t.title), ["No cliente"]);
  const subarvore = await (await send("GET", `/contextos/${cliente.id}/tarefas?subarvore=1`)).json();
  assert.equal(subarvore.length, 2);

  assert.equal((await send("POST", "/tarefas", { title: "x", contextId: "nao-existe" })).status, 400);
  assert.equal((await send("PUT", `/tarefas/${t2.id}/contexto`, { contextId: null })).status, 200);
  assert.equal((await send("PUT", `/tarefas/nao-existe/contexto`, { contextId: null })).status, 404);
});

test("Contextos persistem após reiniciar o daemon", async () => {
  const c = await criar({ name: "Persistente", kind: "projeto", testCommands: ["t"] });
  await daemon.close();
  daemon = await startDaemon({ dbPath: join(dir, "atm.db"), port: 0 });
  const got = await (await send("GET", `/contextos/${c.id}`)).json();
  assert.deepEqual(got.testCommands, ["t"]);
});
