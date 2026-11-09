import { api, type Tarefa } from "@/lib/api";

// Ações de estado do humano (daemon/src/domain/exploracao.ts, TRANSICOES): POST /tarefas/:id/<ação>.
// Só transporte: a API valida quem pode e de qual estado (403/409 chegam como ApiError).

/** "aprovar-subtarefa" é a Aprovação de Subtarefa proposta pelo agente (ticket 08). */
export type AcaoAprovacao = "aprovar" | "aprovar-subtarefa" | "rejeitar" | "reabrir";

export const executarAcao = (id: string, acao: AcaoAprovacao, motivo?: string) =>
  api<Tarefa>(`/tarefas/${id}/${acao}`, { method: "POST", ...(motivo !== undefined ? { body: { motivo } } : {}) });

/** Área prevista e avisos de sobreposição que o daemon anexa à Tarefa (daemon/src/api/area.ts). */
export interface AvisoSobreposicao {
  taskId: string;
  title: string;
  state: string;
  overlaps: { mine: string; theirs: string }[];
}
