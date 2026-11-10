import type { DepsColetas } from "../coleta/deps.ts";
import type { Resposta } from "./contextos.ts";
import { rotaLeituraDoColetor } from "./coletas.ts";

/** GET /coletores/:id/anomalias (humano e agente leem). Devolve undefined quando a rota não é daqui. */
export const rotaAnomalias = (d: DepsColetas, metodo: string, path: string): Resposta | undefined =>
  rotaLeituraDoColetor(d, metodo, path, "anomalias", (id) => d.anomalias.listar(id));
