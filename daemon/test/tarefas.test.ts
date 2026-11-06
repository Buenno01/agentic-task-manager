import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/api/server.ts";

import { CRED, HUMANO, comToken } from "./helpers.ts";

let daemon: Daemon;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "atm-"));
  daemon = await startDaemon({ dbPath: join(dir, "atm.db"), port: 0, credenciais: CRED });
});
afterEach(async () => {
  await daemon.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  fetch(daemon.url + path, {
    method: "POST",
    headers: comToken(HUMANO, { "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
const get = (path: string) => fetch(daemon.url + path, { headers: comToken(HUMANO) });

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
  assert.deepEqual(await (await get("/tarefas")).json(), []);
  await post("/tarefas", { title: "A" });
  await post("/tarefas", { title: "B" });
  const list = await (await get("/tarefas")).json();
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
  daemon = await startDaemon({ dbPath: join(dir, "atm.db"), port: 0, credenciais: CRED });
  const list = await (await get("/tarefas")).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "Persistente");
});

const UI = "http://127.0.0.1:5173";
test("API permite CORS só para a origem da UI (lista configurável)", async () => {
  const res = await fetch(daemon.url + "/tarefas", { method: "OPTIONS", headers: { origin: UI } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), UI);
  const outra = await fetch(daemon.url + "/tarefas", { method: "OPTIONS", headers: { origin: "http://evil.example" } });
  assert.equal(outra.headers.get("access-control-allow-origin"), null);
  const semOrigem = await fetch(daemon.url + "/tarefas", { method: "OPTIONS" });
  assert.equal(semOrigem.headers.get("access-control-allow-origin"), null);
});

test("ATM_CORS_ORIGIN configura a origem permitida", async () => {
  await daemon.close();
  daemon = await startDaemon({ dbPath: join(dir, "atm.db"), port: 0, credenciais: CRED, corsOrigins: ["https://ui.exemplo"] });
  const ok = await fetch(daemon.url + "/tarefas", { method: "OPTIONS", headers: { origin: "https://ui.exemplo" } });
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://ui.exemplo");
  const no = await fetch(daemon.url + "/tarefas", { method: "OPTIONS", headers: { origin: UI } });
  assert.equal(no.headers.get("access-control-allow-origin"), null);
});

test("startDaemon exige credenciais (não falha aberto)", () => {
  assert.throws(() => (startDaemon as (o: unknown) => unknown)({ dbPath: join(dir, "x.db"), port: 0 }), /credenciais/i);
});
