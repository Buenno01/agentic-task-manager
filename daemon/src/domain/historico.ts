/** Histórico de uma Tarefa: linha do tempo imutável de comentários, transições e Aprovações. */

export const TIPOS_COMENTARIO = ["comentario", "pergunta", "resposta", "plano"] as const;
export type TipoComentario = (typeof TIPOS_COMENTARIO)[number];

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
}

let ultimo = 0;
/** Instante ISO estritamente crescente: garante ordem cronológica estável entre fontes. */
export function agora(): string {
  ultimo = Math.max(Date.now(), ultimo + 1);
  return new Date(ultimo).toISOString();
}

/** Mescla fontes já ordenadas em ordem cronológica (empate: ordem das fontes). */
export function mesclar(...fontes: ItemHistorico[][]): ItemHistorico[] {
  return fontes.flat().map((e, i) => [e, i] as const).sort((a, b) => (a[0].em < b[0].em ? -1 : a[0].em > b[0].em ? 1 : a[1] - b[1])).map(([e]) => e);
}
