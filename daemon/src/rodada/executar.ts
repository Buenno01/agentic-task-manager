import type { ArmazemRodadas, Checkpoint, DadosCheckpoint, Rodada } from "../db/rodadas.ts";
import { arquivosAlteradosDesde, checkpointDeReferencia, diffDesde, headSha, montarPrompt } from "./retomada.ts";
import type { Repositorio } from "../db/index.ts";
import type { Executor, EventoExecutor, TipoRodada } from "../executor/executor.ts";
import { ErroValidacao } from "../domain/tarefa.ts";
import { ESPERA_SIGKILL_MS, erroDeAutorizacao, falhasSeguidas, motivoAguardarHumano } from "./falha.ts";
import type { criarVigiaSobreposicao } from "./sobreposicao.ts";
import { ErroWorkspace, type Workspaces } from "../workspace/workspace.ts";
import type { LogsRodada } from "./logs.ts";
import { criarAskpass } from "./askpass.ts";

export interface DepsRodada {
  repo: Repositorio;
  rodadas: ArmazemRodadas;
  executor: Executor;
  workspaces: Workspaces;
  /** Repositório principal e de consulta da Tarefa (vêm do Contexto). */
  reposDaTarefa: (tarefaId: string) => { repositorio: string | null; consulta: string[] };
  /** Texto do Contexto consolidado vigente da Tarefa ("" se não houver). */
  consolidadoDaTarefa?: (tarefaId: string) => string;
  /** Aviso de sobreposição real de arquivos (RF18); opcional. */
  vigiaSobreposicao?: ReturnType<typeof criarVigiaSobreposicao>;
  mcpUrl: string;
  /** Token do agente `orquestrador` (nunca o humano). */
  tokenAgente: string;
  /** Logs por Rodada (saída grande e trilha completa, já mascarados). */
  logs?: LogsRodada;
  /** Token do GitHub: entra via GIT_ASKPASS só em Rodada de Execução (ADR-0001). */
  tokenGithub?: () => string | undefined;
  /** URL da API do próprio daemon (conhecida só depois do listen). */
  apiUrl: () => string;
  /** Chamado quando uma Rodada termina (o orquestrador reage liberando vaga). */
  aoTerminar?: () => void;
  /** Relógio em ms (injetável; carimba falhas para o backoff). */
  relogio?: () => number;
  /** Agenda `fn` daqui a `ms` e devolve o cancelamento (injetável: SIGKILL após 10 s sem espera real). */
  temporizador?: (fn: () => void, ms: number) => () => void;
}

const temporizadorReal = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};

interface Ativa {
  tarefaId: string;
  abort: AbortController;
  forcado: AbortController;
  fim: Promise<void>;
  /** Preenchido ao cancelar por mudança de estado (sem ele, o aborto é fechamento do daemon). */
  motivoCancelamento?: string;
}

const AUTOR = "agente:orquestrador";

/** Dispara Rodadas num Executor e grava Rodada, Segmentos e eventos. */
export function criarRodadas(d: DepsRodada) {
  const ativas = new Map<string, Ativa>();
  const relogio = d.relogio ?? Date.now;
  const temporizador = d.temporizador ?? temporizadorReal;

  async function prepararWorkspace(tarefaId: string, tipo: TipoRodada): Promise<string> {
    try {
      return (await d.workspaces.preparar({ tarefaId, tipo, ...d.reposDaTarefa(tarefaId) })).dir;
    } catch (e) {
      if (e instanceof ErroWorkspace) throw new ErroValidacao(e.message);
      throw e;
    }
  }

  /** Grava um Checkpoint com o SHA do HEAD do Workspace da Rodada (gravado pelo sistema) e o põe no histórico da Tarefa. */
  async function checkpoint(
    rodadaId: string,
    origem: "agente" | "automático",
    dados: Partial<DadosCheckpoint> = {},
    motivo = "",
  ): Promise<Checkpoint | undefined> {
    const r = d.rodadas.obter(rodadaId);
    if (!r) return undefined;
    const sha = await headSha(r.workspace);
    const anterior = checkpointDeReferencia(d.rodadas.checkpointsDaTarefa(r.tarefaId).filter((c) => c.origem === "agente" || c.sha));
    const arquivos = origem === "automático" ? await arquivosAlteradosDesde(r.workspace, anterior?.sha ?? null) : (dados.arquivosTocados ?? []);
    const cp = d.rodadas.inserirCheckpoint({
      rodadaId,
      tarefaId: r.tarefaId,
      origem,
      sha,
      progresso: dados.progresso ?? null,
      decisoes: dados.decisoes ?? [],
      arquivosTocados: arquivos,
      proximosPassos: dados.proximosPassos ?? [],
    });
    d.rodadas.registrarEvento(rodadaId, "checkpoint", { origem, sha, progresso: cp.progresso, decisoes: cp.decisoes, arquivosTocados: cp.arquivosTocados, proximosPassos: cp.proximosPassos });
    d.repo.registrarEvento(r.tarefaId, {
      autor: origem === "agente" ? AUTOR : "sistema",
      tipo: "checkpoint",
      motivo: `${origem}${motivo ? ` (${motivo})` : ""} · SHA ${sha ?? "—"}${cp.progresso ? ` · ${cp.progresso}` : ""}`,
    });
    return cp;
  }

  /** Prompt da Rodada: primeira Rodada ou retomada a partir do último Checkpoint (ADR-0004). */
  async function promptDe(tarefaId: string, tipo: TipoRodada, workspace: string): Promise<string> {
    const t = d.repo.obterTarefa(tarefaId);
    const checkpoints = d.rodadas.checkpointsDaTarefa(tarefaId);
    const ref = checkpointDeReferencia(checkpoints);
    const diff = ref?.sha ? await diffDesde(workspace, ref.sha) : "";
    const arquivos = ref?.sha || !checkpoints.length ? await arquivosAlteradosDesde(workspace, ref?.sha ?? null) : [];
    return montarPrompt({
      tipo,
      tarefa: { id: tarefaId, title: t?.title ?? "", description: t?.description ?? "" },
      checkpoints,
      consolidado: d.consolidadoDaTarefa?.(tarefaId) ?? "",
      diff,
      arquivos,
    });
  }

  /** Depois de uma falha: 401/403 ou 3 falhas seguidas levam a Tarefa a "Aguardando humano" com o motivo. */
  function escalarSeNecessario(tarefaId: string, erro: string, autorizacao: boolean) {
    const t = d.repo.obterTarefa(tarefaId);
    if (!t || !((t.phase === "Exploração" && t.state === "Explorando") || (t.phase === "Execução" && t.state === "Em execução"))) return;
    const motivo = motivoAguardarHumano(falhasSeguidas(d.repo.listarEventos(tarefaId)), autorizacao, erro);
    if (motivo) d.repo.transicionar(tarefaId, { autor: AUTOR, tipo: "aguardar-humano-falha", de: t.state, para: "Aguardando humano", motivo });
  }

  return {
    /** Checkpoint do agente (rota POST /tarefas/:id/checkpoint). */
    checkpointDoAgente: (rodadaId: string, dados: DadosCheckpoint) =>
      checkpoint(rodadaId, "agente", dados),
    /** Checkpoint automático (SHA e arquivos alterados); usado ao fim de Segmento e pelo cancelamento (ADR-0004). */
    checkpointAutomatico: (rodadaId: string, motivo = "") => checkpoint(rodadaId, "automático", {}, motivo),
    async iniciar(tarefaId: string, tipo: TipoRodada): Promise<Rodada> {
      const workspace = await prepararWorkspace(tarefaId, tipo);
      const prompt = await promptDe(tarefaId, tipo, workspace);
      const rodada = d.rodadas.criar({ tarefaId, tipo, workspace });
      // Toda gravação de evento da Rodada passa pelos logs (mascarados; saída grande vira arquivo).
      const registrar = (tipoEv: string, dados: Record<string, unknown>) =>
        d.rodadas.registrarEvento(rodada.id, tipoEv, d.logs ? d.logs.processar(rodada.id, tipoEv, dados) : dados);
      registrar("prompt", { texto: prompt });
      d.repo.registrarEvento(tarefaId, { autor: AUTOR, tipo: "rodada-iniciada", motivo: `${tipo} (${rodada.id})` });
      const abort = new AbortController();
      const forcado = new AbortController();
      const ativa: Ativa = { tarefaId, abort, forcado, fim: Promise.resolve() };
      let segmentos = 0;
      let fila: Promise<unknown> = Promise.resolve();
      const naFila = (fn: () => Promise<unknown>) => (fila = fila.then(fn).catch(() => {}));
      const vigiar = d.vigiaSobreposicao?.para(rodada.id, tarefaId, workspace);
      const emitir = (e: EventoExecutor) => {
        if (e.tipo === "segmento") {
          // Um novo Segmento encerra o anterior: Checkpoint automático do fim dele.
          if (segmentos++ > 0) naFila(() => checkpoint(rodada.id, "automático", {}, "fim de Segmento"));
          const s = e.dados as { modelo: string; provedor: string };
          d.rodadas.abrirSegmento(rodada.id, { modelo: s.modelo, provedor: s.provedor });
        } else if (e.tipo === "tokens") d.rodadas.somarUso(rodada.id, e.dados as { entrada: number; saida: number });
        registrar(e.tipo, e.dados as Record<string, unknown>);
        if (vigiar && e.tipo === "comando") naFila(vigiar);
      };
      const fim = (async () => {
        // GitHub só na Execução: Exploração nunca recebe o token (ADR-0001).
        const tk = tipo === "Execução" ? d.tokenGithub?.()?.trim() : undefined;
        const askpass = tk ? criarAskpass(tk) : undefined;
        try {
          await d.executor.executar({
            rodadaId: rodada.id,
            tarefaId,
            tipo,
            workspace,
            prompt,
            ambiente: { ATM_API_URL: d.apiUrl(), ATM_MCP_URL: d.mcpUrl, ATM_AGENT_TOKEN: d.tokenAgente, ...askpass?.ambiente },
            sinal: abort.signal,
            sinalForcado: forcado.signal,
            emitir,
          });
          if (vigiar) await naFila(vigiar);
          await naFila(async () => segmentos > 0 && checkpoint(rodada.id, "automático", {}, "fim de Segmento"));
          d.rodadas.finalizar(rodada.id, "concluída");
          d.repo.registrarEvento(tarefaId, { autor: AUTOR, tipo: "rodada-concluida", motivo: rodada.id });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const abortada = abort.signal.aborted;
          const cancelada = abortada && ativa.motivoCancelamento !== undefined;
          const interrompida = abortada && !cancelada;
          const motivoCp = cancelada ? "cancelamento" : interrompida ? "interrupção" : "fim de Segmento";
          await naFila(async () => (segmentos > 0 || abortada) && checkpoint(rodada.id, "automático", {}, motivoCp));
          if (cancelada) {
            d.rodadas.finalizar(rodada.id, "cancelada", ativa.motivoCancelamento);
            d.repo.registrarEvento(tarefaId, { autor: AUTOR, tipo: "rodada-cancelada", motivo: ativa.motivoCancelamento });
          } else if (interrompida) {
            // Fechamento do daemon: não é falha; a próxima Rodada parte do Checkpoint.
            d.rodadas.finalizar(rodada.id, "interrompida", "Daemon encerrado durante a Rodada");
            d.repo.registrarEvento(tarefaId, { autor: AUTOR, tipo: "rodada-interrompida", motivo: rodada.id });
          } else {
            const autorizacao = erroDeAutorizacao(e);
            registrar("falha", { erro: msg, autorizacao, emMs: relogio() });
            d.rodadas.finalizar(rodada.id, "falhou", msg);
            d.repo.registrarEvento(tarefaId, { autor: AUTOR, tipo: "rodada-falhou", motivo: msg });
            escalarSeNecessario(tarefaId, msg, autorizacao);
          }
        } finally {
          askpass?.remover();
          ativas.delete(rodada.id);
          d.aoTerminar?.();
        }
      })();
      ativa.fim = fim;
      ativas.set(rodada.id, ativa);
      return rodada;
    },
    /**
     * Cancela a Rodada em curso da Tarefa por mudança de estado (rejeitar, reabrir, campo-chave, pausar):
     * `sinal` (SIGTERM), `sinalForcado` (SIGKILL) após 10 s, Checkpoint automático; o Workspace fica.
     * Espera a Rodada terminar. Devolve quantas foram canceladas.
     */
    async cancelarDaTarefa(tarefaId: string, motivo: string): Promise<number> {
      const alvo = [...ativas.values()].filter((a) => a.tarefaId === tarefaId && !a.abort.signal.aborted);
      for (const a of alvo) {
        a.motivoCancelamento = motivo || "Cancelada por mudança de estado";
        a.abort.abort();
      }
      const cancela = alvo.length ? temporizador(() => alvo.forEach((a) => a.forcado.abort()), ESPERA_SIGKILL_MS) : () => {};
      await Promise.all(alvo.map((a) => a.fim));
      cancela();
      return alvo.length;
    },
    /** Cancela as Rodadas em curso e espera terminarem (fechamento do daemon). */
    async encerrar() {
      const todas = [...ativas.values()];
      const cancela = temporizador(() => todas.forEach((a) => a.forcado.abort()), ESPERA_SIGKILL_MS);
      for (const a of todas) a.abort.abort();
      await Promise.all(todas.map((a) => a.fim));
      cancela();
    },
  };
}
