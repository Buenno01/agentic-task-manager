import { ErroValidacao } from "./tarefa.ts";

/** Níveis em ordem crescente de importância (RF8). */
export const NIVEIS = ["baixa", "média", "alta", "urgente"] as const;
export type Nivel = (typeof NIVEIS)[number];
export type Origem = "humano" | "agente" | "padrão";

export interface Justificativa {
  impacto: string;
  urgencia: string;
  esforco: string;
}

export interface Prioridade {
  nivel: Nivel;
  justificativa: Justificativa;
  origem: Origem;
  /** "humano", "agente:<id>" ou null quando é o padrão. */
  autor: string | null;
  em: string | null;
}

export const PRIORIDADE_PADRAO: Prioridade = {
  nivel: "média",
  justificativa: { impacto: "", urgencia: "", esforco: "" },
  origem: "padrão",
  autor: null,
  em: null,
};

/** Valida o corpo de PUT /tarefas/:id/prioridade. O agente precisa justificar; o humano pode omitir. */
export function validarPrioridade(entrada: Record<string, unknown>, exigeJustificativa: boolean) {
  if (!NIVEIS.includes(entrada.nivel as Nivel)) throw new ErroValidacao(`Nível inválido; use: ${NIVEIS.join(", ")}`);
  const campo = (k: keyof Justificativa) => (typeof entrada[k] === "string" ? (entrada[k] as string).trim() : "");
  const justificativa = { impacto: campo("impacto"), urgencia: campo("urgencia"), esforco: campo("esforco") };
  if (exigeJustificativa && Object.values(justificativa).some((v) => !v))
    throw new ErroValidacao("A sugestão exige justificativa: impacto, urgencia e esforco");
  return { nivel: entrada.nivel as Nivel, justificativa };
}

/** Ordena por prioridade (maior primeiro) e depois por chegada (ordem original da lista, já por chegada). */
export function ordenarPorPrioridade<T extends { priority: Prioridade }>(tarefas: T[]): T[] {
  return tarefas
    .map((t, i) => [t, i] as const)
    .sort(([a, i], [b, j]) => NIVEIS.indexOf(b.priority.nivel) - NIVEIS.indexOf(a.priority.nivel) || i - j)
    .map(([t]) => t);
}
