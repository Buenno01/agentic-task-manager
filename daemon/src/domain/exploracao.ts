import type { EstadoExploracao } from "./tarefa.ts";

interface Transicao {
  de: EstadoExploracao[];
  para: EstadoExploracao;
  /** Só o humano pode (autorizar, aprovar, rejeitar, reabrir). */
  apenasHumano: boolean;
}

/** Ciclo de vida da Exploração (spec seção 5). */
export const TRANSICOES: Record<string, Transicao> = {
  autorizar: { de: ["Novo"], para: "Autorizada para explorar", apenasHumano: true },
  iniciar: { de: ["Autorizada para explorar"], para: "Explorando", apenasHumano: false },
  "pedir-humano": { de: ["Explorando"], para: "Aguardando humano", apenasHumano: false },
  retomar: { de: ["Aguardando humano"], para: "Explorando", apenasHumano: false },
  "plano-pronto": { de: ["Explorando"], para: "Plano pronto para aprovação", apenasHumano: false },
  aprovar: { de: ["Plano pronto para aprovação"], para: "Aprovado", apenasHumano: true },
  rejeitar: { de: ["Novo", "Plano pronto para aprovação"], para: "Rejeitado", apenasHumano: true },
  reabrir: { de: ["Rejeitado"], para: "Novo", apenasHumano: true },
};
