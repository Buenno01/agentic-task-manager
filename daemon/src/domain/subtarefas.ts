/** Resolução da Tarefa-mãe (RF3): só quando todas as Subtarefas foram aprovadas ou rejeitadas. */
export type DecisaoSubtarefa = "aprovada" | "rejeitada";

export interface ResolucaoSubtarefas {
  total: number;
  aprovadas: number;
  rejeitadas: number;
  resolvida: boolean;
}

export function resolucao(decisoes: (DecisaoSubtarefa | null)[]): ResolucaoSubtarefas {
  const aprovadas = decisoes.filter((d) => d === "aprovada").length;
  const rejeitadas = decisoes.filter((d) => d === "rejeitada").length;
  const total = decisoes.length;
  return { total, aprovadas, rejeitadas, resolvida: total > 0 && aprovadas + rejeitadas === total };
}

/** Decisão da Subtarefa a partir da ação humana aplicada a ela; undefined = não altera. */
export function decisaoDaAcao(acao: string): DecisaoSubtarefa | null | undefined {
  if (acao === "aprovar" || acao === "aprovar-subtarefa") return "aprovada";
  if (acao === "rejeitar") return "rejeitada";
  if (acao === "reabrir") return null;
  return undefined;
}
