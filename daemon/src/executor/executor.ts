/**
 * Interface do Executor: inicia uma Rodada num runtime e devolve eventos.
 * Adaptadores: `falso.ts` (testes, determinístico) e `hermes.ts` (ADR-0009).
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
  /** Prompt da Rodada: tarefa e Contexto consolidado; na retomada, também o último Checkpoint e o diff desde o SHA (ADR-0004). */
  prompt: string;
  /** Ambiente do processo do agente (ADR-0008): API, MCP e token `orquestrador`; nunca token humano.
   *  CONTRATO para adaptadores (ADR-0009): o processo do agente deve ser iniciado com env = PATH/HOME + SOMENTE estas chaves
   *  (+ chaves do provedor do modelo, se o adaptador precisar); NUNCA repasse `process.env` inteiro (tem ATM_HUMAN_TOKEN e ATM_GITHUB_TOKEN). */
  ambiente: {
    ATM_API_URL: string;
    ATM_MCP_URL: string;
    ATM_AGENT_TOKEN: string;
    /** Só em Rodada de Execução com ATM_GITHUB_TOKEN: script que responde ao prompt de credencial do git (o token nunca vai na URL do remote). */
    GIT_ASKPASS?: string;
    /** Idem: lido pelo script `GIT_ASKPASS`. */
    ATM_GIT_TOKEN?: string;
    GIT_TERMINAL_PROMPT?: string;
  };
  /** Disparado ao cancelar a Rodada ou fechar o daemon. */
  sinal: AbortSignal;
  /** Disparado 10 s depois de `sinal` se a Rodada ainda não terminou: o adaptador deve mandar SIGKILL (o `sinal` equivale ao SIGTERM). */
  sinalForcado: AbortSignal;
  /** Adaptadores que criam processo emitem `{ tipo: "processo", dados: { pid } }` para o daemon matar órfãos no boot. */
  emitir(evento: EventoExecutor): void;
}

export interface Executor {
  executar(entrada: EntradaRodada): Promise<void>;
}

/** Padrão quando nenhum adaptador foi injetado (o Hermes entra via ADR-0009). */
export const executorNaoConfigurado: Executor = {
  executar: async () => {
    throw new Error("Nenhum adaptador de Executor configurado");
  },
};
