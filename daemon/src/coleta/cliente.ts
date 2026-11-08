import type { Fonte } from "../domain/coleta.ts";

export interface PedidoColeta {
  source: Fonte;
  params: Record<string, unknown>;
  /** AAAA-MM-DD */
  period: string;
  /** Valor lido da variável de ambiente do Coletor; vive só em memória. */
  token: string;
}

export interface RespostaColeta {
  /** Moeda da loja (ISO 4217). */
  moeda: string;
  metricas: Record<string, number | null>;
}

/** Cliente da fonte (injetável em `startDaemon`; testes usam o falso). */
export interface ClienteColeta {
  coletar(pedido: PedidoColeta): Promise<RespostaColeta>;
}

/** Padrão quando nada foi injetado: nenhuma fonte real configurada ainda. */
export const clienteNaoConfigurado: ClienteColeta = {
  async coletar() {
    throw new Error("Nenhum cliente de coleta configurado");
  },
};
