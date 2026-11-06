import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/api/server.ts";

let daemon: Daemon;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "atm-"));
  daemon = await startDaemon({ dbPath: join(dir, "atm.db"), port: 0 });
});
afterEach(async () => {
  await daemon.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  fetch(daemon.url + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("GET /health responde ok", async () => {
  const res = await fetch(daemon.url + "/health");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("criar Tarefa nasce na Exploração, estado Novo", async () => {
  const res = await post("/tarefas", { title: "Revisar preços", description: "Comparar com concorrente" });
  assert.equal(res.status, 201);
  const t = await res.json();
  assert.equal(t.title, "Revisar preços");
  assert.equal(t.description, "Comparar com concorrente");
  assert.equal(t.phase, "Exploração");
  assert.equal(t.state, "Novo");
  assert.ok(t.id);
  assert.ok(!Number.isNaN(Date.parse(t.createdAt)));
});

test("listar Tarefas devolve as criadas", async () => {
  assert.deepEqual(await (await fetch(daemon.url + "/tarefas")).json(), []);
  await post("/tarefas", { title: "A" });
  await post("/tarefas", { title: "B" });
  const list = await (await fetch(daemon.url + "/tarefas")).json();
  assert.deepEqual(list.map((t: { title: string }) => t.title).sort(), ["A", "B"]);
  assert.equal(list[0].description, "");
});

test("Tarefa sem título é rejeitada", async () => {
  const res = await post("/tarefas", { title: "  " });
  assert.equal(res.status, 400);
});

test("Tarefas persistem no SQLite após reiniciar o daemon", async () => {
  await post("/tarefas", { title: "Persistente" });
  await daemon.close();
  daemon = await startDaemon({ dbPath: join(dir, "atm.db"), port: 0 });
  const list = await (await fetch(daemon.url + "/tarefas")).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "Persistente");
});

test("API permite CORS para a UI (projeto separado)", async () => {
  const res = await fetch(daemon.url + "/tarefas", { method: "OPTIONS" });
  assert.equal(res.status, 204);
  assert.ok(res.headers.get("access-control-allow-origin"));
});
