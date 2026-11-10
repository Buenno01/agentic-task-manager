import type { Repositorio } from "../db/index.ts";
import { totaisDeUso, type ArmazemRodadas } from "../db/rodadas.ts";
import type { Resposta } from "./contextos.ts";

/** GET /tarefas/:id/uso: uso por Segmento, totais por Rodada e total da Tarefa. */
export function rotaUso(repo: Repositorio, rodadas: ArmazemRodadas, metodo: string, path: string): Resposta | undefined {
  const m = path.match(/^\/tarefas\/([^/]+)\/uso$/);
  if (!m || metodo !== "GET") return undefined;
  if (!repo.obterTarefa(m[1])) return { status: 404, corpo: { error: "Não encontrado" } };
  const lista = rodadas.listarDaTarefa(m[1]);
  return {
    status: 200,
    corpo: {
      totais: totaisDeUso(lista.flatMap((r) => r.segmentos)),
      rodadas: lista.map((r) => ({ id: r.id, tipo: r.tipo, estado: r.estado, segmentos: r.segmentos, totais: r.totais })),
    },
  };
}
