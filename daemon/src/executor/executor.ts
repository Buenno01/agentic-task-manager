/**
 * Interface do Executor: inicia uma Rodada num runtime e devolve eventos.
 * Adaptadores: `falso.ts` (testes, determinístico) e, no ticket 12, o Hermes.
 * Falha = a promessa rejeita (a Rodada fica "falhou" com a mensagem do erro).
 */
export type TipoRodada = "Exploração" | "Execução";

/** Evento emitido pelo adaptador. `segmento` abre um Segmento; `tokens` soma uso ao Segmento atual. */
export type EventoExecutor =
  | { tipo: "segmento"; dados: { modelo: string; provedor: string } }
  | { tipo: "tokens"; dados: { entrada: number; saida: number; chamadas?: number; custo?: number } }
  | { tipo: string; dados: Record<string, unknown> };

export interface EntradaRodada {
  rodadaId: string;
  tarefaId: string;
  tipo: TipoRodada;
  /** Diretório de trabalho da Rodada (git). */
  workspace: string;
  /** Ambiente do processo do agente (ADR-0008): API, MCP e token `orquestrador`; nunca token humano. */
  ambiente: { ATM_API_URL: string; ATM_MCP_URL: string; ATM_AGENT_TOKEN: string };
  /** Disparado ao cancelar a Rodada ou fechar o daemon. */
  sinal: AbortSignal;
  emitir(evento: EventoExecutor): void;
}

export interface Executor {
  executar(entrada: EntradaRodada): Promise<void>;
}

/** Padrão quando nenhum adaptador foi injetado (o Hermes entra no ticket 12). */
export const executorNaoConfigurado: Executor = {
  executar: async () => {
    throw new Error("Nenhum adaptador de Executor configurado");
  },
};
