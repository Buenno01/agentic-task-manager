import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { criarExecutorHermes, argumentosHermes, ambienteDoFilho, type FuncaoSpawn } from "../src/executor/hermes.ts";
import type { EntradaRodada, EventoExecutor } from "../src/executor/executor.ts";

const STUB = join(import.meta.dirname, "fixtures", "hermes-stub.mjs");
const REGISTRO = join(mkdtempSync(join(tmpdir(), "atm-stub-")), "registro.json");

/** spawn injetado: ignora o binário e roda o stub com os mesmos argumentos e o mesmo env que o adaptador montou. */
const spawnStub: FuncaoSpawn = (_c, args, o) => spawn(process.execPath, [STUB, ...args], { ...o, env: { ...o.env, STUB_REGISTRO: REGISTRO } });

function entrada(prompt: string, extra: Partial<EntradaRodada> = {}) {
  const eventos: EventoExecutor[] = [];
  const ac = new AbortController();
  const forcado = new AbortController();
  const e: EntradaRodada = {
    rodadaId: "r1", tarefaId: "t1", tipo: "Execução", workspace: tmpdir(), prompt,
    ambiente: { ATM_API_URL: "http://api", ATM_MCP_URL: "http://mcp/mcp", ATM_AGENT_TOKEN: "tok-agente" },
    sinal: ac.signal, sinalForcado: forcado.signal, emitir: (ev) => eventos.push(ev), ...extra,
  };
  return { e, eventos, ac, forcado };
}
const executor = () => criarExecutorHermes({ spawn: spawnStub, modelo: "stub/modelo-1", maxTurnos: 7, orcamentoSegundos: 60, env: { PATH: process.env.PATH, HOME: "/h", ATM_HUMAN_TOKEN: "segredo-humano", ATM_GITHUB_TOKEN: "segredo-gh", ANTHROPIC_API_KEY: "k" } });

test("traduz o stream-json em eventos do Executor, com uso vindo do result", async () => {
  const { e, eventos } = entrada("MODO:ok\nfaça algo");
  await executor().executar(e);
  const tipos = eventos.map((x) => x.tipo);
  assert.equal(tipos[0], "processo");
  assert.ok(typeof (eventos[0]!.dados as any).pid === "number");
  assert.equal(tipos[1], "segmento");
  assert.deepEqual(eventos[1]!.dados, { modelo: "stub/modelo-1", provedor: "stub" });
  assert.deepEqual(eventos.find((x) => x.tipo === "passo")!.dados, { texto: "Vou editar." });
  const comandos = eventos.filter((x) => x.tipo === "comando").map((x) => x.dados);
  assert.deepEqual(comandos[0], { comando: "write_file", arquivos: ["a.txt"] });
  assert.equal((comandos[1] as any).comando, "git commit -am x");
  const tokens = eventos.filter((x) => x.tipo === "tokens");
  assert.deepEqual(tokens.map((t) => t.dados), [{ entrada: 120, saida: 30 }]);
  assert.ok(tipos.indexOf("segmento") < tipos.indexOf("tokens"));
});

test("monta o comando com --query-file/--format/--in/-m/--max-turns/--run-budget e prompt verbatim", async () => {
  const { e } = entrada("MODO:ok\n$(rm -rf /) `x` \"aspas\"");
  await executor().executar(e);
  const r = JSON.parse(readFileSync(REGISTRO, "utf8"));
  assert.equal(r.prompt, e.prompt);
  const a: string[] = r.args;
  assert.equal(a[0], "chat");
  for (const [flag, valor] of [["--format", "stream-json"], ["--in", e.workspace], ["-m", "stub/modelo-1"], ["--max-turns", "7"], ["--run-budget", "60"]]) {
    assert.equal(a[a.indexOf(flag!) + 1], valor, flag);
  }
  assert.ok(!a.includes(e.prompt) && !a.includes("-q"));
});

test("o filho recebe só PATH/HOME + ambiente da Rodada + chaves do provedor", async () => {
  const { e } = entrada("MODO:ok");
  await executor().executar(e);
  const env: string[] = JSON.parse(readFileSync(REGISTRO, "utf8")).env;
  for (const k of ["PATH", "HOME", "ATM_API_URL", "ATM_MCP_URL", "ATM_AGENT_TOKEN", "ANTHROPIC_API_KEY"]) assert.ok(env.includes(k), k);
  assert.ok(!env.includes("ATM_HUMAN_TOKEN") && !env.includes("ATM_GITHUB_TOKEN"));
  // GIT_ASKPASS só aparece se a Rodada o trouxer
  const com = ambienteDoFilho({ ...e, ambiente: { ...e.ambiente, GIT_ASKPASS: "/x", ATM_GIT_TOKEN: "g" } }, { env: { PATH: "/bin" } });
  assert.equal(com.GIT_ASKPASS, "/x");
  assert.equal(ambienteDoFilho(e, { env: { PATH: "/bin" } }).GIT_ASKPASS, undefined);
});

test("result com erro / exit_code != 0 rejeita, mas o uso já emitido fica", async () => {
  const { e, eventos } = entrada("MODO:falha");
  await assert.rejects(executor().executar(e), /limite de turnos/);
  assert.equal(eventos.filter((x) => x.tipo === "tokens").length, 1);
});

test("sem registro result e código 0: conclui sem tokens (uso desconhecido)", async () => {
  const { e, eventos } = entrada("MODO:sem-resultado");
  await executor().executar(e);
  assert.equal(eventos.filter((x) => x.tipo === "tokens").length, 0);
});

test("processo morto por sinal rejeita sem tokens", async () => {
  const { e, eventos } = entrada("MODO:morrer");
  await assert.rejects(executor().executar(e), /morreu \(SIGKILL\)/);
  assert.equal(eventos.filter((x) => x.tipo === "tokens").length, 0);
});

test("linha que não é JSON vira evento 'saida' e não derruba a Rodada", async () => {
  const { e, eventos } = entrada("MODO:saida-invalida");
  await executor().executar(e);
  assert.ok(eventos.some((x) => x.tipo === "saida"));
});

test("cancelar manda SIGTERM; se o filho ignora, o sinal forçado manda SIGKILL", async () => {
  const { e, ac, forcado, eventos } = entrada("MODO:travar");
  const p = executor().executar(e);
  const pid = await new Promise<number>((res) => {
    const t = setInterval(() => { const ev = eventos.find((x) => x.tipo === "processo"); if (ev) { clearInterval(t); res((ev.dados as any).pid); } }, 10);
  });
  await new Promise((r) => setTimeout(r, 300)); // dá tempo de o stub instalar o handler de SIGTERM
  ac.abort();
  const resultado = await Promise.race([p.then(() => "fim", () => "fim"), new Promise((r) => setTimeout(() => r("vivo"), 500))]);
  assert.equal(resultado, "vivo", "SIGTERM é ignorado pelo stub");
  forcado.abort();
  await assert.rejects(p, /Rodada cancelada/);
  assert.throws(() => process.kill(pid, 0));
});

test("já cancelada: rejeita sem criar processo", async () => {
  let chamou = false;
  const ex = criarExecutorHermes({ spawn: (...a) => { chamou = true; return spawnStub(...a); } });
  const { e, ac } = entrada("MODO:ok");
  ac.abort();
  await assert.rejects(ex.executar(e), /cancelada/);
  assert.equal(chamou, false);
});

test("binário inexistente rejeita com mensagem clara", async () => {
  const ex = criarExecutorHermes({ binario: "/nao/existe/hermes", env: { PATH: "/bin" } });
  await assert.rejects(ex.executar(entrada("x").e), /Falha ao iniciar o Hermes/);
});

test("argumentosHermes: --yolo por padrão e opcional", () => {
  const { e } = entrada("x");
  assert.ok(argumentosHermes("/p", e).includes("--yolo"));
  assert.ok(!argumentosHermes("/p", e, { yolo: false }).includes("--yolo"));
});

test.after(() => rmSync(join(REGISTRO, ".."), { recursive: true, force: true }));

test("o token OAuth da assinatura Claude (CLAUDE_CODE_OAUTH_TOKEN) chega ao filho; o do humano não", () => {
  const { e } = entrada("MODO:ok");
  const env = ambienteDoFilho(e, { env: { PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x", ATM_HUMAN_TOKEN: "h" } });
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-x");
  assert.equal(env.ATM_HUMAN_TOKEN, undefined);
});
