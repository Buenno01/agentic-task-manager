import { randomUUID } from "node:crypto";

export type Fase = "Exploração" | "Execução";
export type EstadoExploracao = "Novo";

export interface Tarefa {
  id: string;
  title: string;
  description: string;
  phase: Fase;
  state: EstadoExploracao;
  createdAt: string;
}

export class ErroValidacao extends Error {}

/** Regra de negócio: toda Tarefa criada nasce em Exploração, estado "Novo". */
export function novaTarefa(entrada: { title?: unknown; description?: unknown }): Tarefa {
  const title = typeof entrada.title === "string" ? entrada.title.trim() : "";
  if (!title) throw new ErroValidacao("O título da Tarefa é obrigatório");
  const description = typeof entrada.description === "string" ? entrada.description : "";
  return {
    id: randomUUID(),
    title,
    description,
    phase: "Exploração",
    state: "Novo",
    createdAt: new Date().toISOString(),
  };
}
