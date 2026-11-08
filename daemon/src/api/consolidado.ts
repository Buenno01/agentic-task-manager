import type { ArmazemConsolidado } from "../db/consolidado.ts";
import { ErroValidacao } from "../domain/tarefa.ts";
import type { Resposta } from "./contextos.ts";

const VAZIO = (contextId: string) => ({
  contextId, version: 0, text: "", taskId: null, author: null, revertedFrom: null, createdAt: null,
});

function taskIdDe(e: Record<string, unknown>, tarefaExiste: (id: string) => boolean): string | null {
  if (e.taskId === undefined || e.taskId === null) return null;
  if (typeof e.taskId !== "string" || !tarefaExiste(e.taskId)) throw new ErroValidacao("Tarefa de origem não existe");
  return e.taskId;
}

/**
 * Rotas /contextos/:id/consolidado*. Devolve undefined quando a rota não é daqui.
 * O agente atualiza direto (RF12): não há guarda de aprovação; o autor fica registrado em cada versão.
 */
export function rotaConsolidado(
  store: ArmazemConsolidado,
  contextoExiste: (id: string) => boolean,
  tarefaExiste: (id: string) => boolean,
  autor: string,
  metodo: string,
  path: string,
  corpo: () => Promise<Record<string, unknown>>,
  /** Tarefa da Rodada (undefined se a Rodada não existe). */
  tarefaDaRodada: (rodadaId: string) => string | undefined = () => undefined,
): Promise<Resposta> | Resposta | undefined {
  /** Origem: Rodada (deduz a Tarefa) e/ou Tarefa explícita. */
  const origem = (e: Record<string, unknown>) => {
    const taskId = taskIdDe(e, tarefaExiste);
    if (e.rodadaId === undefined || e.rodadaId === null) return { taskId, rodadaId: null };
    const t = typeof e.rodadaId === "string" ? tarefaDaRodada(e.rodadaId) : undefined;
    if (!t) throw new ErroValidacao("Rodada de origem não existe");
    return { taskId: taskId ?? t, rodadaId: e.rodadaId as string };
  };
  const m = path.match(/^\/contextos\/([^/]+)\/consolidado(?:\/(versoes|reverter))?$/);
  if (!m) return undefined;
  const id = m[1];
  if (!contextoExiste(id)) return { status: 404, corpo: { error: "Não encontrado" } };
  if (!m[2] && metodo === "GET") return { status: 200, corpo: store.atual(id) ?? VAZIO(id) };
  if (m[2] === "versoes" && metodo === "GET") return { status: 200, corpo: store.listar(id) };
  if (!m[2] && metodo === "PUT")
    return corpo().then((e) => {
      if (typeof e.text !== "string" || !e.text.trim()) throw new ErroValidacao("Texto é obrigatório");
      const o = origem(e);
      return { status: 201, corpo: store.atualizar(id, e.text, o.taskId, autor, o.rodadaId) };
    });
  if (m[2] === "reverter" && metodo === "POST")
    return corpo().then((e) => {
      const o = origem(e);
      const atual = store.atual(id);
      let alvo: number;
      if (e.version === undefined) {
        alvo = (atual?.version ?? 0) - 1;
        if (alvo < 1) return { status: 409, corpo: { error: "Não há versão anterior para restaurar" } };
      } else if (typeof e.version === "number" && Number.isInteger(e.version)) alvo = e.version;
      else throw new ErroValidacao("Versão inválida");
      const nova = store.reverter(id, alvo, o.taskId, autor, o.rodadaId);
      if (!nova) throw new ErroValidacao("Versão não existe");
      return { status: 201, corpo: nova };
    });
  return undefined;
}
