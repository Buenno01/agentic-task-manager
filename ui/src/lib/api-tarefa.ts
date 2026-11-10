import { api, type Tarefa } from "@/lib/api";

// Detalhe e histórico da Tarefa (daemon/src/api/historico.ts, domain/historico.ts). Só transporte.

export const TIPOS_COMENTARIO = ["comentario", "pergunta", "resposta", "plano"] as const;
export type TipoComentario = (typeof TIPOS_COMENTARIO)[number];

/** Item da linha do tempo: comentário (tem `texto`) ou transição/Aprovação (tem `de`/`para`/`motivo`). */
export interface ItemHistorico {
  id: number | string;
  tarefaId: string;
  em: string;
  autor: string;
  tipo: string;
  de: string;
  para: string;
  motivo: string;
  texto?: string;
  respondeA?: string;
  [campo: string]: unknown;
}

export const obterTarefa = (id: string) => api<Tarefa>(`/tarefas/${id}`);
export const listarEventos = (id: string) => api<ItemHistorico[]>(`/tarefas/${id}/eventos`);
export const comentar = (id: string, c: { tipo: TipoComentario; texto: string; respondeA?: string }) =>
  api<ItemHistorico>(`/tarefas/${id}/comentarios`, { method: "POST", body: c });
