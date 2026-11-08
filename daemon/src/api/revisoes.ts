import type { DepsColetas } from "../coleta/deps.ts";
import type { Resposta } from "./contextos.ts";
import { rotaLeituraDoColetor } from "./coletas.ts";

/** GET /coletores/:id/revisoes e /coletores/:id/lacunas. Devolve undefined quando a rota não é daqui. */
export const rotaRevisoes = (d: DepsColetas, metodo: string, path: string): Resposta | undefined =>
  rotaLeituraDoColetor(d, metodo, path, "revisoes|lacunas", (id, sufixo) => (sufixo === "revisoes" ? d.revisoes.listarRevisoes(id) : d.revisoes.listarLacunas(id)));
