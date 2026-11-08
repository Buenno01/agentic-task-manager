import type { ArmazemRodadas, Checkpoint, Rodada } from "../db/rodadas.ts";
import { arquivosAlteradosDesde, checkpointDeReferencia, diffDesde, headSha, montarPrompt } from "./retomada.ts";
import type { Repositorio } from "../db/index.ts";
import type { Executor, EventoExecutor, TipoRodada } from "../executor/executor.ts";
import { ErroValidacao } from "../domain/tarefa.ts";
import { ErroWorkspace, type Workspaces } from "../workspace/workspace.ts";

export interface DepsRodada {
  repo: Repositorio;
  rodadas: ArmazemRodadas;
  executor: Executor;
  workspaces: Workspaces;
  /** Repositório principal e de consulta da Tarefa (vêm do Contexto). */
  reposDaTarefa: (tarefaId: string) => { repositorio: string | null; consulta: string[] };
  /** Texto do Contexto consolidado vigente da Tarefa ("" se não houver). */
  consolidadoDaTarefa?: (tarefaId: string) => string;
  mcpUrl: string;
  /** Token do agente `orquestrador` (nunca o humano). */
  tokenAgente: string;
  /** URL da API do próprio daemon (conhecida só depois do listen). */
  apiUrl: () => string;
  /** Chamado quando uma Rodada termina (o orquestrador reage liberando vaga). */
  aoTerminar?: () => void;
}

const AUTOR = "agente:orquestrador";

/** Dispara Rodadas num Executor e grava Rodada, Segmentos e eventos. */
export function criarRodadas(d: DepsRodada) {
  const ativas = new Map<string, { abort: AbortController; fim: Promise<void> }>();

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
    dados: { progresso?: string; decisoes?: string[]; arquivosTocados?: string[]; proximosPassos?: string[] } = {},
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

  return {
    /** Checkpoint do agente (rota POST /tarefas/:id/checkpoint). */
    checkpointDoAgente: (rodadaId: string, dados: { progresso: string; decisoes: string[]; arquivosTocados: string[]; proximosPassos: string[] }) =>
      checkpoint(rodadaId, "agente", dados),
    /** Checkpoint automático (SHA e arquivos alterados); usado ao fim de Segmento e pelo cancelamento (tickets 05-07). */
    checkpointAutomatico: (rodadaId: string, motivo = "") => checkpoint(rodadaId, "automático", {}, motivo),
    async iniciar(tarefaId: string, tipo: TipoRodada): Promise<Rodada> {
      const workspace = await prepararWorkspace(tarefaId, tipo);
      const prompt = await promptDe(tarefaId, tipo, workspace);
      const rodada = d.rodadas.criar({ tarefaId, tipo, workspace });
      d.rodadas.registrarEvento(rodada.id, "prompt", { texto: prompt });
      d.repo.registrarEvento(tarefaId, { autor: AUTOR, tipo: "rodada-iniciada", motivo: `${tipo} (${rodada.id})` });
      const abort = new AbortController();
      let segmentos = 0;
      let fila: Promise<unknown> = Promise.resolve();
      const naFila = (fn: () => Promise<unknown>) => (fila = fila.then(fn).catch(() => {}));
      const emitir = (e: EventoExecutor) => {
        if (e.tipo === "segmento") {
          // Um novo Segmento encerra o anterior: Checkpoint automático do fim dele.
          if (segmentos++ > 0) naFila(() => checkpoint(rodada.id, "automático", {}, "fim de Segmento"));
          const s = e.dados as { modelo: string; provedor: string };
          d.rodadas.abrirSegmento(rodada.id, { modelo: s.modelo, provedor: s.provedor });
        } else if (e.tipo === "tokens") d.rodadas.somarUso(rodada.id, e.dados as { entrada: number; saida: number });
        d.rodadas.registrarEvento(rodada.id, e.tipo, e.dados as Record<string, unknown>);
      };
      const fim = (async () => {
        try {
          await d.executor.executar({
            rodadaId: rodada.id,
            tarefaId,
            tipo,
            workspace,
            prompt,
            ambiente: { ATM_API_URL: d.apiUrl(), ATM_MCP_URL: d.mcpUrl, ATM_AGENT_TOKEN: d.tokenAgente },
            sinal: abort.signal,
            emitir,
          });
          await naFila(async () => segmentos > 0 && checkpoint(rodada.id, "automático", {}, "fim de Segmento"));
          d.rodadas.finalizar(rodada.id, "concluída");
          d.repo.registrarEvento(tarefaId, { autor: AUTOR, tipo: "rodada-concluida", motivo: rodada.id });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const cancelada = abort.signal.aborted;
          await naFila(async () => (segmentos > 0 || cancelada) && checkpoint(rodada.id, "automático", {}, cancelada ? "cancelamento" : "fim de Segmento"));
          d.rodadas.finalizar(rodada.id, cancelada ? "cancelada" : "falhou", msg);
          d.repo.registrarEvento(tarefaId, { autor: AUTOR, tipo: cancelada ? "rodada-cancelada" : "rodada-falhou", motivo: msg });
        } finally {
          ativas.delete(rodada.id);
          d.aoTerminar?.();
        }
      })();
      ativas.set(rodada.id, { abort, fim });
      return rodada;
    },
    /** Cancela as Rodadas em curso e espera terminarem (fechamento do daemon). */
    async encerrar() {
      const todas = [...ativas.values()];
      for (const a of todas) a.abort.abort();
      await Promise.all(todas.map((a) => a.fim));
    },
  };
}
