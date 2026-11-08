import type { ArmazemRodadas, Rodada } from "../db/rodadas.ts";
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

  return {
    async iniciar(tarefaId: string, tipo: TipoRodada): Promise<Rodada> {
      const workspace = await prepararWorkspace(tarefaId, tipo);
      const rodada = d.rodadas.criar({ tarefaId, tipo, workspace });
      d.repo.registrarEvento(tarefaId, { autor: AUTOR, tipo: "rodada-iniciada", motivo: `${tipo} (${rodada.id})` });
      const abort = new AbortController();
      const emitir = (e: EventoExecutor) => {
        if (e.tipo === "segmento") {
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
            ambiente: { ATM_API_URL: d.apiUrl(), ATM_MCP_URL: d.mcpUrl, ATM_AGENT_TOKEN: d.tokenAgente },
            sinal: abort.signal,
            emitir,
          });
          d.rodadas.finalizar(rodada.id, "concluída");
          d.repo.registrarEvento(tarefaId, { autor: AUTOR, tipo: "rodada-concluida", motivo: rodada.id });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const cancelada = abort.signal.aborted;
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
