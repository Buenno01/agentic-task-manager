import type { DepsColetas } from "./coletas.ts";
import type { Resposta } from "./contextos.ts";

/** GET /coletores/:id/revisoes e /coletores/:id/lacunas. Devolve undefined quando a rota não é daqui. */
export function rotaRevisoes(d: DepsColetas, metodo: string, path: string): Resposta | undefined {
  const m = path.match(/^\/coletores\/([^/]+)\/(revisoes|lacunas)$/);
  if (!m || metodo !== "GET") return undefined;
  if (!d.store.obterColetor(m[1])) return { status: 404, corpo: { error: "Não encontrado" } };
  return { status: 200, corpo: m[2] === "revisoes" ? d.revisoes.listarRevisoes(m[1]) : d.revisoes.listarLacunas(m[1]) };
}
