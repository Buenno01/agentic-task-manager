import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/api/server.ts";
import { criarClienteFalso, type ClienteFalso } from "../src/coleta/falso.ts";
import type { ClienteColeta } from "../src/coleta/cliente.ts";
import { CRED, HUMANO, comToken } from "./helpers.ts";

const VAR_TOKEN = "ATM_AGENDADOR_TOKEN";
let dir: string;
let cliente: ClienteFalso;
let agoraMs: number;
let daemons: Daemon[];

const iniciar = async (c: ClienteColeta = cliente) => {
  const d = await startDaemon({
    dbPath: join(dir, "atm.db"),
    port: 0,
    credenciais: CRED,
    logsDir: join(dir, "logs"),
    // Agendador ligado, mas sem timer real: os testes disparam a varredura à mão.
    coleta: { cliente: c, relogio: () => agoraMs, agendador: { agendar: () => () => {} } },
  });
  daemons.push(d);
  return d;
};
const fechar = async (d: Daemon) => {
  daemons = daemons.filter((x) => x !== d);
  await d.close();
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atm-agendador-"));
  process.env[VAR_TOKEN] = "segredo-do-agendador-0123456789";
  agoraMs = Date.parse("2026-03-10T12:00:00Z"); // 09:00 em São Paulo
  cliente = criarClienteFalso();
  daemons = [];
});
afterEach(async () => {
  for (const d of [...daemons]) await fechar(d);
  delete process.env[VAR_TOKEN];
  rmSync(dir, { recursive: true, force: true });
});

const send = (d: Daemon, method: string, path: string, body?: unknown) =>
  fetch(d.url + path, {
    method,
    headers: comToken(HUMANO, { "content-type": "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (d: Daemon, method: string, path: string, body?: unknown) => (await send(d, method, path, body)).json();

async function novoColetor(d: Daemon, params: Record<string, unknown> = {}) {
  const ctx = await json(d, "POST", "/contextos", { name: "Loja Wine", kind: "loja" });
  const res = await send(d, "POST", "/coletores", { contextId: ctx.id, source: "falso", tokenEnv: VAR_TOKEN, params });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  return (await res.json()).id as string;
}
const periodos = async (d: Daemon, coletor: string) =>
  ((await json(d, "GET", `/coletores/${coletor}/coletas`)) as { period: string }[]).map((c) => c.period).sort();

test("primeira Coleta de um Coletor faz backfill de 90 dias, sem esperas reais", async () => {
  const d = await iniciar();
  const id = await novoColetor(d);
  await d.varrerColetas();
  const ps = await periodos(d, id);
  assert.equal(ps.length, 90);
  assert.equal(ps[0], "2025-12-10");
  assert.equal(ps[89], "2026-03-09");
  const snaps = await json(d, "GET", `/coletores/${id}/consolidado`);
  assert.equal(snaps.length, 90 * 4);
  // Outra varredura no mesmo instante não repete nada.
  await d.varrerColetas();
  assert.equal((await periodos(d, id)).length, 90);
});

test("Coleta diária dispara no horário configurado, no fuso da loja", async () => {
  const d = await iniciar();
  const id = await novoColetor(d, { scheduleTime: "23:00", timezone: "America/Sao_Paulo" });
  agoraMs = Date.parse("2026-03-10T01:00:00Z"); // 22:00 de 09/03 em SP; UTC já é dia 10
  await d.varrerColetas(); // backfill termina em 07/03 (dia anterior ao dia civil de SP: 08/03 ainda não fechou)
  const antes = await periodos(d, id);
  assert.equal(antes.at(-1), "2026-03-07");

  agoraMs = Date.parse("2026-03-10T01:59:00Z"); // 22:59 em SP: ainda não é a hora
  await d.varrerColetas();
  assert.equal((await periodos(d, id)).length, antes.length);

  agoraMs = Date.parse("2026-03-10T02:00:00Z"); // 23:00 em SP
  await d.varrerColetas();
  const depois = await periodos(d, id);
  assert.equal(depois.length, antes.length + 1);
  assert.equal(depois.at(-1), "2026-03-08");
});

test("horário padrão é 06:00 no fuso da loja (America/Sao_Paulo)", async () => {
  const d = await iniciar();
  const id = await novoColetor(d);
  agoraMs = Date.parse("2026-03-10T08:59:00Z"); // 05:59 em SP
  await d.varrerColetas();
  assert.equal((await periodos(d, id)).at(-1), "2026-03-08");
  agoraMs = Date.parse("2026-03-10T09:00:00Z"); // 06:00 em SP
  await d.varrerColetas();
  assert.equal((await periodos(d, id)).at(-1), "2026-03-09");
});

test("Coletas atrasadas rodam no boot sem duplicar as que já rodaram", async () => {
  let d = await iniciar();
  const id = await novoColetor(d);
  await d.varrerColetas();
  await fechar(d);
  const chamadas = cliente.pedidos.length;
  assert.equal(chamadas, 90);

  agoraMs = Date.parse("2026-03-13T12:00:00Z"); // daemon ficou fora 3 dias
  d = await iniciar();
  await d.varrerColetas(); // aguarda a recuperação do boot
  const ps = await periodos(d, id);
  assert.equal(ps.length, 93);
  assert.equal(new Set(ps).size, 93);
  assert.deepEqual(ps.slice(-4), ["2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12"]);
  assert.equal(cliente.pedidos.length, 93);
});

test("reiniciar no meio de uma Coleta não deixa estado inconsistente nem duplica dados", async () => {
  // O primeiro processo trava na coleta de 2026-03-05 (como um daemon que cai no meio).
  let soltar!: (e: Error) => void;
  const travado = new Promise<never>((_, rej) => (soltar = rej));
  const interno = criarClienteFalso();
  const clienteQueTrava: ClienteColeta = {
    coletar: (p) => (p.period === "2026-03-05" ? travado : interno.coletar(p)),
  };
  const d1 = await iniciar(clienteQueTrava);
  const id = await novoColetor(d1);
  void d1.varrerColetas();
  for (let i = 0; i < 500 && !interno.pedidos.some((p) => p.period === "2026-03-04"); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(interno.pedidos.some((p) => p.period === "2026-03-04"));
  const coletasAntes = (await json(d1, "GET", `/coletores/${id}/coletas`)) as { state: string }[];
  assert.ok(coletasAntes.some((c) => c.state === "em andamento"));

  // Segundo processo sobe sobre o mesmo banco: a Coleta pendente vira falhou e é refeita.
  const d2 = await iniciar(cliente);
  await d2.varrerColetas();
  soltar(new Error("processo morto")); // o primeiro nunca conclui de fato
  await fechar(d1);

  const coletas = (await json(d2, "GET", `/coletores/${id}/coletas`)) as { period: string; state: string }[];
  assert.equal(coletas.filter((c) => c.state === "em andamento").length, 0);
  const consolidado = (await json(d2, "GET", `/coletores/${id}/consolidado`)) as { period: string; metric: string; value: number | null }[];
  const dia5 = consolidado.filter((s) => s.period === "2026-03-05" && s.metric === "orders");
  assert.equal(dia5.length, 1);
  assert.notEqual(dia5[0].value, null);
  // Cada período tem exatamente um Snapshot concluído.
  const porPeriodo = new Map<string, number>();
  for (const c of coletas.filter((c) => c.state === "concluída")) porPeriodo.set(c.period, (porPeriodo.get(c.period) ?? 0) + 1);
  assert.ok([...porPeriodo.values()].every((n) => n === 1));
  assert.equal(porPeriodo.size, 90);
});
