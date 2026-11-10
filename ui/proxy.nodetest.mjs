// Teste do destino do proxy /api (node --test). Garante que o Bearer nunca vai para outro origin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { destinoDoProxy, cabecalhosDoProxy } from "./proxy.js";

const api = new URL("http://127.0.0.1:3000");

test("remove /api e ancora no origin configurado", () => {
  assert.equal(destinoDoProxy("/api/tarefas?x=1", api).href, "http://127.0.0.1:3000/tarefas?x=1");
  assert.equal(destinoDoProxy("/api/tarefas/a%20b", api).href, "http://127.0.0.1:3000/tarefas/a%20b");
});

test("rejeita caminho que não começa com uma única barra", () => {
  assert.equal(destinoDoProxy("/api", api), null);
  assert.equal(destinoDoProxy("/api//evil.com/x", api), null);
  assert.equal(destinoDoProxy("/api/\\evil.com/x", api), null);
  assert.equal(destinoDoProxy("/apix/tarefas", api), null);
});

test("rejeita o que mudaria de origin", () => {
  assert.equal(destinoDoProxy("/api/@evil.com/x", api)?.origin ?? api.origin, api.origin);
  assert.equal(destinoDoProxy("/api/../../x", api)?.origin ?? api.origin, api.origin);
});

test("repassa só cabeçalhos necessários", () => {
  const h = cabecalhosDoProxy(
    { authorization: "Bearer t", "content-type": "application/json", cookie: "s=1", "x-forwarded-for": "1.1.1.1", accept: "*/*" },
    api,
  );
  assert.deepEqual(h, { authorization: "Bearer t", "content-type": "application/json", accept: "*/*", host: "127.0.0.1:3000" });
});
