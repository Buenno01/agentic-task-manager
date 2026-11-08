import type { DepsColetas } from "./coletas.ts";
import type { Resposta } from "./contextos.ts";

/** GET /coletores/:id/anomalias (humano e agente leem). Devolve undefined quando a rota não é daqui. */
export function rotaAnomalias(d: DepsColetas, metodo: string, path: string): Resposta | undefined {
  const m = path.match(/^\/coletores\/([^/]+)\/anomalias$/);
  if (!m || metodo !== "GET") return undefined;
  if (!d.store.obterColetor(m[1])) return { status: 404, corpo: { error: "Não encontrado" } };
  return { status: 200, corpo: d.anomalias.listar(m[1]) };
}
