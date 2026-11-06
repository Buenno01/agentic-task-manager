import type { Autor } from "../auth/credenciais.ts";
import { rotuloAutor } from "../auth/credenciais.ts";
import type { Prioridades } from "../db/prioridade.ts";
import { validarPrioridade } from "../domain/prioridade.ts";

/**
 * PUT /tarefas/:id/prioridade. Humano define sempre; agente só sugere, com justificativa,
 * e nunca sobrescreve um valor definido pelo humano (409).
 */
export function definirPrioridade(
  prios: Prioridades,
  tarefaId: string,
  autor: Autor,
  corpo: Record<string, unknown>,
): { status: number; corpo: unknown } {
  const { nivel, justificativa } = validarPrioridade(corpo, autor.tipo === "agente");
  if (autor.tipo === "agente" && prios.obter(tarefaId).origem === "humano")
    return { status: 409, corpo: { error: "Prioridade definida pelo humano; o agente não pode sobrescrever" } };
  prios.definir(tarefaId, nivel, justificativa, autor.tipo, rotuloAutor(autor));
  return { status: 200, corpo: { id: tarefaId, priority: prios.obter(tarefaId) } };
}
