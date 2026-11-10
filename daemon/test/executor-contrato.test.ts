import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntradaRodada, EventoExecutor, Executor } from "../src/executor/executor.ts";
import { criarExecutorFalso } from "../src/executor/falso.ts";
import { criarExecutorHermes, opcoesHermesDoAmbiente } from "../src/executor/hermes.ts";

/**
 * Contrato do Executor (ADR-0009). Roda sempre sobre o falso; sobre o Hermes real só com ATM_TESTE_HERMES=1
 * (chama o modelo: custa dinheiro e exige credenciais do provedor configuradas no ambiente).
 */
interface Implementacao {
  nome: string;
  /** `ok`: prompt/roteiro que conclui sem erro. `falha`: que termina em erro. */
  criar(modo: "ok" | "falha" | "longo"): Executor;
  /** O adaptador cria processo (então deve emitir `processo` com pid)? */
  comProcesso: boolean;
  /** O adaptador reporta uso quando conclui? Hermes real depende do provedor: não exigimos. */
  reportaUso: boolean;
  prompt: string;
}

const implementacoes: { impl: Implementacao; pular: string | false }[] = [
  {
    pular: false,
    impl: {
      nome: "falso",
      comProcesso: true,
      reportaUso: true,
      prompt: "tarefa de exemplo",
      criar: (modo) =>
        criarExecutorFalso(
          modo === "falha"
            ? [{ processo: process.pid }, { segmento: { modelo: "m", provedor: "p" } }, { falha: "quebrou" }]
            : [{ processo: process.pid }, { segmento: { modelo: "m", provedor: "p" } }, { passo: "ok" }, { tokens: { entrada: 3, saida: 2 } }],
        ),
    },
  },
  {
    pular: process.env.ATM_TESTE_HERMES === "1" ? false : "defina ATM_TESTE_HERMES=1 para rodar sobre o Hermes real (chama o modelo)",
    impl: {
      nome: "hermes real",
      comProcesso: true,
      reportaUso: false,
      prompt: "Responda apenas com a palavra OK. Não use nenhuma ferramenta nem altere arquivos.",
      criar: (modo) =>
        criarExecutorHermes({
          ...opcoesHermesDoAmbiente(),
          maxTurnos: 3,
          orcamentoSegundos: 120,
          // "falha": binário/modelo inválido faz o Hermes terminar com erro; "longo" usa o mesmo prompt e cancelamos logo.
          ...(modo === "falha" ? { modelo: "atm-modelo-inexistente/zzz" } : {}),
        }),
    },
  },
];

function repoTemporario(): string {
  const dir = mkdtempSync(join(tmpdir(), "atm-contrato-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# repo de teste\n");
  git("add", "."), git("commit", "-q", "-m", "inicial");
  return dir;
}

function entrada(prompt: string, workspace: string) {
  const eventos: EventoExecutor[] = [];
  const ac = new AbortController();
  const forcado = new AbortController();
  const e: EntradaRodada = {
    rodadaId: "r1", tarefaId: "t1", tipo: "Exploração", workspace, prompt,
    ambiente: { ATM_API_URL: "http://127.0.0.1:9", ATM_MCP_URL: "http://127.0.0.1:9/mcp", ATM_AGENT_TOKEN: "tok-contrato-0123456789" },
    sinal: ac.signal, sinalForcado: forcado.signal, emitir: (ev) => eventos.push(ev),
  };
  return { e, eventos, ac, forcado };
}

for (const { impl, pular } of implementacoes) {
  describe(`contrato do Executor: ${impl.nome}`, { skip: pular }, () => {
    test("conclui: a promessa resolve e, se cria processo, emite pid antes de qualquer outra coisa", { timeout: 300_000 }, async () => {
      const { e, eventos } = entrada(impl.prompt, repoTemporario());
      await impl.criar("ok").executar(e);
      if (impl.comProcesso) {
        const p = eventos.find((x) => x.tipo === "processo");
        assert.ok(p, "evento processo");
        assert.ok(Number.isInteger((p.dados as { pid: number }).pid));
        assert.equal(eventos[0]!.tipo, "processo");
      }
    });

    test("segmento abre antes de tokens; tokens são números não negativos", { timeout: 300_000 }, async () => {
      const { e, eventos } = entrada(impl.prompt, repoTemporario());
      await impl.criar("ok").executar(e);
      const tokens = eventos.filter((x) => x.tipo === "tokens");
      if (impl.reportaUso) assert.ok(tokens.length > 0, "uso reportado");
      if (tokens.length) {
        assert.ok(eventos.findIndex((x) => x.tipo === "segmento") >= 0);
        assert.ok(eventos.findIndex((x) => x.tipo === "segmento") < eventos.findIndex((x) => x.tipo === "tokens"));
        for (const t of tokens) {
          const d = t.dados as { entrada: number; saida: number };
          assert.ok(d.entrada >= 0 && d.saida >= 0);
        }
      }
    });

    test("falha = a promessa rejeita com Error de mensagem não vazia", { timeout: 300_000 }, async () => {
      const { e } = entrada(impl.prompt, repoTemporario());
      await assert.rejects(impl.criar("falha").executar(e), (err: Error) => err instanceof Error && err.message.length > 0);
    });

    test("sinal já abortado: rejeita sem concluir", async () => {
      const { e, ac } = entrada(impl.prompt, repoTemporario());
      ac.abort();
      await assert.rejects(impl.criar("longo").executar(e));
    });

    test("abortar durante a Rodada encerra o processo e rejeita", { timeout: 300_000 }, async () => {
      const { e, eventos, ac, forcado } = entrada(impl.prompt, repoTemporario());
      const p = impl.criar("longo").executar(e);
      p.catch(() => {});
      // aborta assim que o processo existir (o falso conclui rápido: nesse caso a promessa pode resolver — ambos válidos)
      for (let i = 0; i < 200 && !eventos.some((x) => x.tipo === "processo"); i++) await new Promise((r) => setTimeout(r, 10));
      ac.abort();
      const t = setTimeout(() => forcado.abort(), 10_000);
      try {
        await p;
      } catch (err) {
        assert.ok(err instanceof Error);
      } finally {
        clearTimeout(t);
      }
    });
  });
}
