import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/api/server.ts";
import { areasSobrepoem } from "../src/domain/area.ts";

const HUMANO = "tok-humano";
const AGENTE = "tok-agente";
let daemon: Daemon;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "atm-area-"));
  daemon = await startDaemon({
    dbPath: join(dir, "atm.db"),
    port: 0,
    credenciais: { humano: HUMANO, agentes: { "agente-a": AGENTE } },
  });
});
afterEach(async () => {
  await daemon.close();
  rmSync(dir, { recursive: true, force: true });
});

const req = (method: string, path: string, token: string, body?: unknown) =>
  fetch(daemon.url + path, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (r: Response) => r.json() as Promise<any>;
const contexto = async (body: Record<string, unknown>) => (await json(await req("POST", "/contextos", HUMANO, body))).id as string;
const tarefa = async (contextId: string | null, title = "T") =>
  (await json(await req("POST", "/tarefas", AGENTE, { title, contextId }))).id as string;
const area = (id: string, paths: string[], token = AGENTE) => req("PUT", `/tarefas/${id}/area-prevista`, token, { paths });
const ate = async (id: string, passos: string[]) => {
  for (const p of passos) assert.equal((await req("POST", `/tarefas/${id}/${p}`, p === "autorizar" ? HUMANO : AGENTE)).status, 200, p);
};
const planoPronto = (id: string) => ate(id, ["autorizar", "iniciar", "plano-pronto"]);
const obter = async (id: string) =>
  ((await json(await req("GET", "/tarefas", HUMANO))) as any[]).find((t) => t.id === id);

test("sobreposição de caminhos: prefixo de diretório e glob", () => {
  assert.equal(areasSobrepoem("src/api", "src/api/server.ts"), true);
  assert.equal(areasSobrepoem("src/api/", "./src/api"), true);
  assert.equal(areasSobrepoem("src/api", "src/apix/a.ts"), false);
  assert.equal(areasSobrepoem("src/a.ts", "src/b.ts"), false);
  assert.equal(areasSobrepoem("src/**", "src/api/x.ts"), true);
  assert.equal(areasSobrepoem("src/*.ts", "src/main.ts"), true);
  assert.equal(areasSobrepoem("src/*.ts", "src/main.js"), false);
  assert.equal(areasSobrepoem("src/*.ts", "ui/main.ts"), false);
  assert.equal(areasSobrepoem("src/a*", "src/b*"), false);
  assert.equal(areasSobrepoem("**/*.css", "theme/x.css"), true);
});

test("o plano registra a Área prevista e ela volta na Tarefa", async () => {
  const id = await tarefa(null);
  assert.deepEqual((await obter(id)).intendedArea, []);
  const r = await area(id, ["src/api", " ui/app.js ", "src/api"]);
  assert.equal(r.status, 200);
  assert.deepEqual((await json(r)).intendedArea, ["src/api", "ui/app.js"]);
  assert.deepEqual((await obter(id)).intendedArea, ["src/api", "ui/app.js"]);
});

test("valida a Área prevista e a existência da Tarefa", async () => {
  const id = await tarefa(null);
  assert.equal((await req("PUT", `/tarefas/${id}/area-prevista`, AGENTE, { paths: "src" })).status, 400);
  assert.equal((await area(id, [""])).status, 400);
  assert.equal((await area(id, [42 as unknown as string])).status, 400);
  assert.equal((await area("nao-existe", ["src"])).status, 404);
});

test("aviso de sobreposição com outra Tarefa aberta do mesmo repositório (herdado do Contexto)", async () => {
  const loja = await contexto({ name: "Loja", kind: "loja", repository: "git@x:wine/tema.git" });
  const filho = await contexto({ name: "Checkout", kind: "projeto", parentId: loja });
  const a = await tarefa(loja, "A");
  const b = await tarefa(filho, "B"); // herda o repositório
  await area(a, ["src/checkout"]);
  await area(b, ["src/checkout/cart.ts", "docs"]);
  await planoPronto(b);

  const tb = await obter(b);
  assert.equal(tb.overlapWarnings.length, 1);
  assert.equal(tb.overlapWarnings[0].taskId, a);
  assert.equal(tb.overlapWarnings[0].title, "A");
  assert.deepEqual(tb.overlapWarnings[0].overlaps, [{ mine: "src/checkout/cart.ts", theirs: "src/checkout" }]);
  assert.equal((await obter(a)).overlapWarnings[0].taskId, b); // simétrico
});

test("sem aviso: repositório diferente, sem repositório, sem sobreposição ou Tarefa fechada", async () => {
  const r1 = await contexto({ name: "R1", kind: "repositorio", repository: "repo-1" });
  const r2 = await contexto({ name: "R2", kind: "repositorio", repository: "repo-2" });
  const semRepo = await contexto({ name: "Sem", kind: "projeto" });
  const a = await tarefa(r1, "A");
  const b = await tarefa(r2, "B");
  const c = await tarefa(r1, "C");
  const d = await tarefa(semRepo, "D");
  const e = await tarefa(semRepo, "E");
  const f = await tarefa(r1, "F");
  for (const id of [a, b, c, d, e]) await area(id, id === c ? ["ui"] : ["src"]);
  await area(f, ["src"]);
  assert.deepEqual((await obter(a)).overlapWarnings.map((w: any) => w.taskId), [f]); // só F: mesmo repo e sobrepõe
  assert.deepEqual((await obter(b)).overlapWarnings, []);
  assert.deepEqual((await obter(d)).overlapWarnings, []);
  assert.deepEqual((await obter(e)).overlapWarnings, []);

  // Tarefa rejeitada não está aberta
  await planoPronto(f);
  assert.equal((await req("POST", `/tarefas/${f}/rejeitar`, HUMANO)).status, 200);
  assert.deepEqual((await obter(a)).overlapWarnings, []);
});

test("aviso aparece em GET /tarefas/:id/sobreposicao e na resposta de plano-pronto, antes da Aprovação", async () => {
  const ctx = await contexto({ name: "R", kind: "repositorio", repository: "repo" });
  const a = await tarefa(ctx, "A");
  const b = await tarefa(ctx, "B");
  await area(a, ["src"]);
  await area(b, ["src/x.ts"]);
  await ate(b, ["autorizar", "iniciar"]);
  const pronto = await json(await req("POST", `/tarefas/${b}/plano-pronto`, AGENTE));
  assert.equal(pronto.overlapWarnings[0].taskId, a);
  const r = await req("GET", `/tarefas/${b}/sobreposicao`, HUMANO);
  assert.equal(r.status, 200);
  assert.equal((await json(r))[0].taskId, a);
  assert.equal((await req("GET", `/tarefas/nao-existe/sobreposicao`, HUMANO)).status, 404);
});

test("aprovar com aviso continua possível e o aviso vem na resposta", async () => {
  const ctx = await contexto({ name: "R", kind: "repositorio", repository: "repo" });
  const a = await tarefa(ctx, "A");
  const b = await tarefa(ctx, "B");
  await area(a, ["src"]);
  await area(b, ["src"]);
  await planoPronto(b);
  const r = await req("POST", `/tarefas/${b}/aprovar`, HUMANO);
  assert.equal(r.status, 200);
  const corpo = await json(r);
  assert.equal(corpo.state, "Aprovado");
  assert.equal(corpo.overlapWarnings[0].taskId, a);
});

test("Área prevista não pode mudar depois de Aprovado; mudança fica no histórico", async () => {
  const id = await tarefa(null);
  await planoPronto(id);
  assert.equal((await area(id, ["src"])).status, 200);
  await req("POST", `/tarefas/${id}/aprovar`, HUMANO);
  assert.equal((await area(id, ["ui"])).status, 409);
  const ev = (await json(await req("GET", `/tarefas/${id}/eventos`, HUMANO))) as any[];
  assert.ok(ev.some((e) => e.tipo === "area-prevista" && e.autor === "agente:agente-a"));
});
