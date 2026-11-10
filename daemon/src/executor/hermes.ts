import { spawn as spawnReal, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { EntradaRodada, Executor } from "./executor.ts";

/**
 * Adaptador do Executor sobre `hermes chat` não interativo (ADR-0009).
 *
 * Comando: `hermes chat --query-file <arq> --format stream-json --in <workspace> [-m M] [--max-turns N] [--run-budget S]`.
 * O prompt vai por arquivo (nada é interpretado pelo shell). stdout é JSONL (`hermes_cli/stream_json.py`):
 *   system/init {model, session_id} · text {text} · tool_use {name, input} · tool_result {name, output, is_error}
 *   · result {exit_code, text, error?, tokens{input,output,total,cache_read,cache_write}}.
 *
 * ORIGEM DO USO DE TOKENS: o registro terminal `result.tokens` do stream-json (totais da Rodada inteira, sem
 * `chamadas` nem `custo`). `--usage-file` só vale no modo `--oneshot`, que não é este. Se o processo morrer antes do
 * `result` (SIGKILL, queda), não há uso: nenhum evento `tokens` é emitido e o daemon registra "uso desconhecido".
 * Não verificado contra uma Rodada real (ver scripts/verificar-hermes.sh).
 */

/** Subconjunto de ChildProcess que o adaptador usa; permite injetar um stub nos testes. */
export type FuncaoSpawn = (comando: string, args: string[], opcoes: SpawnOptions) => ChildProcess;

export interface OpcoesHermes {
  /** Executável (padrão `hermes`, ou ATM_HERMES_BIN). */
  binario?: string;
  /** `-m`. Sem valor, o Hermes usa o modelo da config. */
  modelo?: string;
  /** Nome do provedor registrado no Segmento. Padrão: prefixo de `modelo` ("anthropic/x" → anthropic) ou "hermes". */
  provedor?: string;
  maxTurnos?: number;
  /** `--run-budget` em segundos. */
  orcamentoSegundos?: number;
  /** `--yolo`: sem aprovação interativa (não há TTY). O contêiner é o limite de segurança (ADR-0006). Padrão true. */
  yolo?: boolean;
  /** Variáveis do ambiente do daemon repassadas ao filho além de PATH/HOME e do `ambiente` da Rodada (chaves do provedor). */
  repassar?: string[];
  spawn?: FuncaoSpawn;
  /** Origem das variáveis a repassar (padrão process.env). */
  env?: NodeJS.ProcessEnv;
}

const REPASSAR_PADRAO = [
  "HERMES_HOME", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "NOUS_API_KEY",
];

/** Lê as opções do ambiente do daemon (ATM_HERMES_MODEL, ATM_HERMES_MAX_TURNS, ATM_HERMES_RUN_BUDGET, ATM_HERMES_BIN). */
export function opcoesHermesDoAmbiente(env: NodeJS.ProcessEnv = process.env): OpcoesHermes {
  const num = (v?: string) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
  return {
    binario: env.ATM_HERMES_BIN || undefined,
    modelo: env.ATM_HERMES_MODEL || undefined,
    provedor: env.ATM_HERMES_PROVIDER || undefined,
    maxTurnos: num(env.ATM_HERMES_MAX_TURNS),
    orcamentoSegundos: num(env.ATM_HERMES_RUN_BUDGET),
    env,
  };
}

/** Ambiente mínimo do filho: PATH/HOME + `ambiente` da Rodada + chaves do provedor. Nunca `process.env` inteiro. */
export function ambienteDoFilho(entrada: EntradaRodada, opcoes: OpcoesHermes = {}): Record<string, string> {
  const origem = opcoes.env ?? process.env;
  const out: Record<string, string> = {};
  for (const k of ["PATH", "HOME", ...(opcoes.repassar ?? REPASSAR_PADRAO)]) if (origem[k]) out[k] = origem[k]!;
  for (const [k, v] of Object.entries(entrada.ambiente)) if (v !== undefined) out[k] = v;
  return out;
}

export function argumentosHermes(arquivoPrompt: string, entrada: EntradaRodada, opcoes: OpcoesHermes = {}): string[] {
  const a = ["chat", "--query-file", arquivoPrompt, "--format", "stream-json", "--in", entrada.workspace, "--source", "tool"];
  if (opcoes.modelo) a.push("-m", opcoes.modelo);
  if (opcoes.maxTurnos) a.push("--max-turns", String(opcoes.maxTurnos));
  if (opcoes.orcamentoSegundos) a.push("--run-budget", String(opcoes.orcamentoSegundos));
  if (opcoes.yolo ?? true) a.push("--yolo");
  return a;
}

const FERRAMENTAS_ARQUIVO = new Set(["write_file", "patch"]);

export function criarExecutorHermes(opcoes: OpcoesHermes = {}): Executor {
  const spawn: FuncaoSpawn = opcoes.spawn ?? ((c, a, o) => spawnReal(c, a, o));
  return {
    async executar(e: EntradaRodada) {
      if (e.sinal.aborted) throw new Error("Rodada cancelada");
      const dir = mkdtempSync(join(tmpdir(), "atm-hermes-"));
      const arquivo = join(dir, "prompt.md");
      writeFileSync(arquivo, e.prompt, { mode: 0o600 });
      try {
        await rodar(e, arquivo, opcoes, spawn);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

function rodar(e: EntradaRodada, arquivo: string, opcoes: OpcoesHermes, spawn: FuncaoSpawn): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const filho = spawn(opcoes.binario ?? "hermes", argumentosHermes(arquivo, e, opcoes), {
      cwd: e.workspace,
      env: ambienteDoFilho(e, opcoes),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let cancelada = false;
    let falhaResultado: string | undefined;
    let viuResultado = false;
    let texto = "";
    let stderr = "";
    const modelo = opcoes.modelo ?? "desconhecido";
    const provedor = opcoes.provedor ?? (opcoes.modelo?.includes("/") ? opcoes.modelo.split("/")[0]! : "hermes");
    let segmentoAberto = false;

    const abrirSegmento = (m: string) => {
      if (segmentoAberto) return;
      segmentoAberto = true;
      e.emitir({ tipo: "segmento", dados: { modelo: m, provedor } });
    };
    const descarregarTexto = () => {
      if (texto.trim()) e.emitir({ tipo: "passo", dados: { texto: texto.trim() } });
      texto = "";
    };

    if (filho.pid !== undefined) e.emitir({ tipo: "processo", dados: { pid: filho.pid } });

    const aoCancelar = () => {
      cancelada = true;
      filho.kill("SIGTERM");
    };
    const aoForcar = () => {
      cancelada = true;
      filho.kill("SIGKILL");
    };
    e.sinal.addEventListener("abort", aoCancelar, { once: true });
    e.sinalForcado.addEventListener("abort", aoForcar, { once: true });
    if (e.sinal.aborted) aoCancelar();
    if (e.sinalForcado.aborted) aoForcar();
    const limpar = () => {
      e.sinal.removeEventListener("abort", aoCancelar);
      e.sinalForcado.removeEventListener("abort", aoForcar);
    };

    const aoLinha = (linha: string) => {
      if (!linha.trim()) return;
      let m: any;
      try {
        m = JSON.parse(linha);
      } catch {
        e.emitir({ tipo: "saida", dados: { texto: linha } });
        return;
      }
      switch (m?.type) {
        case "system":
          if (m.subtype === "init") abrirSegmento(String(m.model || modelo));
          break;
        case "text":
          abrirSegmento(modelo);
          texto += String(m.text ?? "");
          break;
        case "tool_use": {
          abrirSegmento(modelo);
          descarregarTexto();
          const nome = String(m.name ?? "desconhecida");
          const entrada = m.input && typeof m.input === "object" ? (m.input as Record<string, unknown>) : {};
          e.emitir({ tipo: "ferramenta", dados: { nome, entrada } });
          if (nome === "terminal" && typeof entrada.command === "string") {
            e.emitir({ tipo: "comando", dados: { comando: entrada.command, arquivos: [] } });
          } else if (FERRAMENTAS_ARQUIVO.has(nome) && typeof entrada.path === "string") {
            e.emitir({ tipo: "comando", dados: { comando: nome, arquivos: [entrada.path] } });
          }
          break;
        }
        case "tool_result":
          e.emitir({ tipo: "resultado_ferramenta", dados: { nome: String(m.name ?? ""), erro: Boolean(m.is_error), saida: String(m.output ?? "").slice(0, 2000) } });
          break;
        case "result": {
          viuResultado = true;
          abrirSegmento(modelo);
          descarregarTexto();
          const t = m.tokens ?? {};
          const entrada = Number(t.input) || 0;
          const saida = Number(t.output) || 0;
          if (entrada + saida > 0) e.emitir({ tipo: "tokens", dados: { entrada, saida } });
          if (m.exit_code || m.error) falhaResultado = String(m.error || `Hermes terminou com exit_code ${m.exit_code}`);
          break;
        }
      }
    };

    const rl = createInterface({ input: filho.stdout! });
    rl.on("line", aoLinha);
    filho.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    filho.on("error", (err) => {
      limpar();
      reject(new Error(`Falha ao iniciar o Hermes: ${err.message}`));
    });
    filho.on("close", (codigo, sinal) => {
      limpar();
      // 'close' vem depois do fim de stdout, mas o readline pode ter linhas pendentes: dá um tick.
      setImmediate(() => {
        descarregarTexto();
        if (cancelada || e.sinal.aborted) return reject(new Error("Rodada cancelada"));
        if (falhaResultado) return reject(new Error(falhaResultado));
        if (sinal) return reject(new Error(`Processo do agente morreu (${sinal})`));
        if (codigo !== 0) return reject(new Error(`Hermes saiu com código ${codigo}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
        void viuResultado; // sem `result` e código 0: conclui sem uso (fica "uso desconhecido")
        resolve();
      });
    });
  });
}
